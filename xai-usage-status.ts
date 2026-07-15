/**
 * Optional Pi footer status for Grok Build usage (`Grok 40% left · 3d 12h`).
 * Enable: `xai.text.usageStatus` or `/xai-usage statusbar`.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isUsageStatusEnabled, setUsageStatusEnabled } from "./xai-config.ts";
import {
  fetchBillingUsage,
  formatUsageStatusText,
  getEffectiveXaiApiKey,
  type BillingUsage,
} from "./xai-oauth.ts";

export const XAI_USAGE_STATUS_KEY = "xai-usage";
export const USAGE_STATUS_TTL_MS = 5 * 60 * 1000;

type UiCtx = Pick<ExtensionContext, "ui" | "hasUI" | "model">;

let cache: { usage: BillingUsage; fetchedAt: number } | undefined;
let inFlight: Promise<void> | undefined;

export function noteBillingUsage(usage: BillingUsage, fetchedAt = Date.now()): void {
  cache = { usage, fetchedAt };
}

export function clearBillingUsageCache(): void {
  cache = undefined;
}

export function isGrokModel(model: ExtensionContext["model"] | undefined | null): boolean {
  if (!model) return false;
  const id = String(model.id ?? "").toLowerCase();
  const provider = String(model.provider ?? "").toLowerCase();
  return provider === "grok-build" || provider === "xai" || id.startsWith("grok-");
}

export function paintUsageStatus(ctx: UiCtx, usage: BillingUsage, now = new Date()): void {
  if (!ctx.hasUI) return;
  ctx.ui.setStatus(XAI_USAGE_STATUS_KEY, ctx.ui.theme.fg("dim", formatUsageStatusText(usage, now)));
}

export function clearUsageStatus(ctx: UiCtx): void {
  if (!ctx.hasUI) return;
  ctx.ui.setStatus(XAI_USAGE_STATUS_KEY, undefined);
}

export async function refreshUsageStatus(
  ctx: UiCtx,
  options?: { force?: boolean; now?: Date },
): Promise<void> {
  if (!isUsageStatusEnabled() || !isGrokModel(ctx.model)) {
    clearUsageStatus(ctx);
    return;
  }

  const force = options?.force === true;
  const now = options?.now ?? new Date();
  if (!force && cache && now.getTime() - cache.fetchedAt < USAGE_STATUS_TTL_MS) {
    paintUsageStatus(ctx, cache.usage, now);
    return;
  }

  if (inFlight) {
    await inFlight;
    if (cache) paintUsageStatus(ctx, cache.usage, now);
    return;
  }

  inFlight = (async () => {
    try {
      const effective = await getEffectiveXaiApiKey();
      if (!effective?.apiKey) {
        clearUsageStatus(ctx);
        return;
      }
      const usage = await fetchBillingUsage(effective.apiKey);
      noteBillingUsage(usage);
      paintUsageStatus(ctx, usage, now);
    } catch {
      if (cache) paintUsageStatus(ctx, cache.usage, now);
      else clearUsageStatus(ctx);
    } finally {
      inFlight = undefined;
    }
  })();

  await inFlight;
}

export async function toggleUsageStatusbar(ctx: ExtensionContext): Promise<void> {
  const next = !isUsageStatusEnabled();
  setUsageStatusEnabled(next);

  if (!next) {
    clearUsageStatus(ctx);
    ctx.ui.notify("xai-usage statusbar: OFF", "info");
    return;
  }

  await refreshUsageStatus(ctx, { force: true });
  if (!isGrokModel(ctx.model)) {
    ctx.ui.notify("xai-usage statusbar: ON (shows when a Grok model is selected)", "info");
    return;
  }
  ctx.ui.notify(
    cache
      ? `xai-usage statusbar: ON — ${formatUsageStatusText(cache.usage)}`
      : "xai-usage statusbar: ON (could not load billing — run /login grok-build)",
    cache ? "info" : "warning",
  );
}

export function registerXaiUsageStatus(api: ExtensionAPI): void {
  api.on("session_start", async (_e, ctx) => {
    await refreshUsageStatus(ctx);
  });
  api.on("model_select", async (_e, ctx) => {
    await refreshUsageStatus(ctx);
  });
  // No turn_end poll — cache TTL + model_select is enough.
  api.on("session_shutdown", async (_e, ctx) => {
    clearUsageStatus(ctx);
    clearBillingUsageCache();
  });
}
