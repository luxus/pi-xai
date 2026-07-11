/**
 * Vision routing for text-only models (especially Composer).
 *
 * When pi's `read` / `Read` tool returns an image and the active model does not
 * declare image input, describe the image via a vision-capable Grok model and
 * replace the image block with text.
 *
 * Default mode: `composer` — only routes when the active model is Composer.
 * Use `/xai-vision:on` for all text-only models, `/xai-vision:off` to disable.
 *
 * Inspired by kenryu42/pi-grok-cli (MIT) — thanks @kenryu42.
 * Config: ~/.pi/xai-vision.json
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { resolveXaiConfig } from "./xai-config.ts";
import { getEffectiveXaiApiKey } from "./xai-oauth.ts";
import { GROK_BUILD_MODELS } from "./xai-provider.ts";
import { xaiRequestHeaders } from "./xai-stream.ts";

// ─── Paths & defaults ────────────────────────────────────────────────────────

const homePath = () => process.env.HOME || homedir();

export const getConfigPath = () => join(homePath(), ".pi", "xai-vision.json");
export const getCachePath = () => join(homePath(), ".pi", "xai-vision-cache.json");

/** Vision-capable flagship; not composer (text-only) and not legacy grok-build. */
export const DEFAULT_DESCRIBE_MODEL = "grok-4.5";
export const DEFAULT_MAX_IMAGES = 4;
export const DEFAULT_CACHE_MAX_ENTRIES = 100;

export const DEFAULT_PROMPT =
  "Describe this image in detail. If it contains text, transcribe it exactly. " +
  "If it shows code, reproduce it. If it shows a UI, describe layout and elements. " +
  "Respond in the same language as any text in the image.";

/** When vision routing runs for non-image models. */
export type VisionMode = "off" | "composer" | "all";

export interface VisionConfig {
  /** @deprecated Prefer `mode`. Kept for back-compat with older configs. */
  enabled?: boolean;
  /** Default `composer`: only route when active model is Composer. */
  mode: VisionMode;
  model: string;
  maxImages: number;
  cacheEnabled: boolean;
  cacheMaxEntries: number;
}

/** Default: on for Composer only — not other text-only / non-vision models. */
export const DEFAULT_CONFIG: VisionConfig = {
  mode: "composer",
  model: DEFAULT_DESCRIBE_MODEL,
  maxImages: DEFAULT_MAX_IMAGES,
  cacheEnabled: true,
  cacheMaxEntries: DEFAULT_CACHE_MAX_ENTRIES,
};

/** True when model id is Grok Composer (text-only coding model). */
export function isComposerModel(modelId: string | undefined | null): boolean {
  if (!modelId) return false;
  const id = modelId.toLowerCase().split("/").pop() ?? modelId.toLowerCase();
  return id.includes("composer");
}

/** Effective mode after normalizeConfig (always one of off|composer|all). */
export function resolveVisionMode(config: VisionConfig): VisionMode {
  if (config.mode === "off" || config.mode === "composer" || config.mode === "all") {
    return config.mode;
  }
  return DEFAULT_CONFIG.mode;
}

/** Whether routing should run for this active model under the config. */
export function shouldRouteVision(
  config: VisionConfig,
  modelId: string | undefined | null,
  modelInput: readonly string[] | undefined,
): boolean {
  // Any model that declares image input uses native vision — never route.
  if (!modelInput || modelInput.includes("image")) return false;
  const mode = resolveVisionMode(config);
  if (mode === "off") return false;
  if (mode === "all") return true;
  // mode === "composer": only Grok Composer (default).
  return isComposerModel(modelId);
}

export interface LoadedConfig {
  config: VisionConfig;
  warning?: string;
}

/** Image-capable flagship ids allowed as the describer (not composer, not legacy grok-build). */
export function describableModels(): string[] {
  return GROK_BUILD_MODELS.filter(
    (m) => m.input.includes("image") && !m.id.startsWith("grok-build"),
  ).map((m) => m.id);
}

function isDescribableModel(value: unknown): value is string {
  return typeof value === "string" && describableModels().includes(value);
}

function normalizeMaxImages(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 1 ||
    !Number.isInteger(value)
  ) {
    return DEFAULT_MAX_IMAGES;
  }
  return value;
}

export function normalizeConfig(
  raw: Partial<VisionConfig> & { enabled?: boolean; mode?: string },
  warnings: string[] = [],
): VisionConfig {
  const config: VisionConfig = { ...DEFAULT_CONFIG };

  // Prefer explicit mode; fall back to legacy enabled boolean.
  if ("mode" in raw && raw.mode !== undefined) {
    if (raw.mode === "off" || raw.mode === "composer" || raw.mode === "all") {
      config.mode = raw.mode;
    } else {
      warnings.push('mode must be "off", "composer", or "all". Using mode=composer.');
    }
  } else if ("enabled" in raw) {
    if (raw.enabled === true) {
      config.mode = "all";
    } else if (raw.enabled === false) {
      config.mode = "off";
    } else if (raw.enabled !== undefined) {
      warnings.push("enabled must be true or false (or use mode). Using mode=composer.");
    }
  }

  if ("model" in raw) {
    if (isDescribableModel(raw.model)) {
      config.model = raw.model;
    } else if (raw.model !== undefined) {
      warnings.push(
        `Unknown model "${String(raw.model)}". Available: ${describableModels().join(", ")}. Using ${DEFAULT_CONFIG.model}.`,
      );
    }
  }

  if ("maxImages" in raw) {
    const normalized = normalizeMaxImages(raw.maxImages);
    config.maxImages = normalized;
    if (raw.maxImages !== normalized) {
      warnings.push(`maxImages must be a positive integer. Using ${DEFAULT_MAX_IMAGES}.`);
    }
  }

  if ("cacheEnabled" in raw) {
    if (typeof raw.cacheEnabled === "boolean") {
      config.cacheEnabled = raw.cacheEnabled;
    } else if (raw.cacheEnabled !== undefined) {
      warnings.push("cacheEnabled must be true or false. Using cacheEnabled=true.");
    }
  }

  if ("cacheMaxEntries" in raw) {
    if (
      typeof raw.cacheMaxEntries === "number" &&
      Number.isInteger(raw.cacheMaxEntries) &&
      raw.cacheMaxEntries > 0
    ) {
      config.cacheMaxEntries = raw.cacheMaxEntries;
    } else if (raw.cacheMaxEntries !== undefined) {
      warnings.push(
        `cacheMaxEntries must be a positive integer. Using ${DEFAULT_CACHE_MAX_ENTRIES}.`,
      );
    }
  }

  return config;
}

export function loadConfig(configPath = getConfigPath()): LoadedConfig {
  try {
    if (!existsSync(configPath)) return { config: { ...DEFAULT_CONFIG } };
    const parsed: unknown = JSON.parse(readFileSync(configPath, "utf-8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {
        config: { ...DEFAULT_CONFIG },
        warning: `Config ${configPath} must be a JSON object. Using defaults.`,
      };
    }
    const warnings: string[] = [];
    const config = normalizeConfig(parsed as Partial<VisionConfig>, warnings);
    return {
      config,
      warning: warnings.length ? `Invalid ${configPath}: ${warnings.join(" ")}` : undefined,
    };
  } catch (err) {
    return {
      config: { ...DEFAULT_CONFIG },
      warning: `Could not read ${configPath}: ${err instanceof Error ? err.message : String(err)}. Using defaults.`,
    };
  }
}

export function saveConfig(config: VisionConfig, configPath = getConfigPath()) {
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify(normalizeConfig(config), null, 2));
}

// ─── Cache ───────────────────────────────────────────────────────────────────

export interface CacheEntry {
  createdAt: string;
  description: string;
  imageHash: string;
  mediaType: string;
  model: string;
  promptHash: string;
}

export interface CacheFile {
  version: 1;
  entries: Record<string, CacheEntry>;
}

export interface VisionImage {
  data: string;
  mimeType: string;
}

function emptyCache(): CacheFile {
  return { version: 1, entries: {} };
}

const cacheUpdates = new Map<string, Promise<void>>();

export function loadCache(cachePath: string): CacheFile {
  try {
    const raw = JSON.parse(readFileSync(cachePath, "utf-8"));
    if (
      raw?.version === 1 &&
      raw.entries &&
      typeof raw.entries === "object" &&
      !Array.isArray(raw.entries)
    ) {
      return raw as CacheFile;
    }
  } catch {
    // Missing or invalid cache: start fresh.
  }
  return emptyCache();
}

export function saveCache(cache: CacheFile, cachePath: string) {
  mkdirSync(dirname(cachePath), { recursive: true });
  writeFileSync(cachePath, JSON.stringify(cache, null, 2));
}

export async function updateCache(cachePath: string, update: (cache: CacheFile) => void) {
  const previous = cacheUpdates.get(cachePath) ?? Promise.resolve();
  let release = () => {};
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const next = previous.then(() => current);
  cacheUpdates.set(cachePath, next);

  await previous;
  try {
    const cache = loadCache(cachePath);
    update(cache);
    saveCache(cache, cachePath);
  } finally {
    release();
    if (cacheUpdates.get(cachePath) === next) cacheUpdates.delete(cachePath);
  }
}

export function clearCache(cachePath: string) {
  saveCache(emptyCache(), cachePath);
}

export function cacheStats(cachePath: string): { entries: number; path: string } {
  return { entries: Object.keys(loadCache(cachePath).entries).length, path: cachePath };
}

function hash(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function makeCacheKey(img: VisionImage, model: string, prompt: string): string {
  const imageHash = hash(Buffer.from(img.data, "base64"));
  return hash(JSON.stringify({ imageHash, mediaType: img.mimeType, model, prompt }));
}

export function makeCacheEntry(
  img: VisionImage,
  model: string,
  prompt: string,
  description: string,
): CacheEntry {
  return {
    createdAt: new Date().toISOString(),
    description,
    imageHash: hash(Buffer.from(img.data, "base64")),
    mediaType: img.mimeType || "unknown",
    model,
    promptHash: hash(prompt),
  };
}

export function pruneCache(cache: CacheFile, maxEntries: number) {
  const entries = Object.entries(cache.entries).sort(
    ([, a], [, b]) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
  );
  cache.entries = Object.fromEntries(entries.slice(0, maxEntries));
}

// ─── Describe ────────────────────────────────────────────────────────────────

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 500;

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function createTimeoutSignal(parent?: AbortSignal): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error("request timed out")),
    REQUEST_TIMEOUT_MS,
  );

  const onAbort = () => controller.abort(parent?.reason ?? new Error("request cancelled"));
  if (parent) {
    if (parent.aborted) onAbort();
    else parent.addEventListener("abort", onAbort, { once: true });
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timeout);
      parent?.removeEventListener("abort", onAbort);
    },
  };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(resolve, ms);
    if (!signal) return;

    const onAbort = () => {
      clearTimeout(timeout);
      reject(new Error("request cancelled"));
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

async function readErrorBody(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  if (!text) return "";
  try {
    const json = JSON.parse(text);
    return json?.error?.message ?? json?.message ?? text;
  } catch {
    return text;
  }
}

function explainHttpError(status: number, body: string, model: string): string {
  const detail = body ? `: ${body.slice(0, 500)}` : "";
  if (status === 401 || status === 403) {
    return `xAI rejected the API key (HTTP ${status}). Run /login grok-build or set XAI_API_KEY${detail}`;
  }
  if (status === 400 || status === 404) {
    return `xAI rejected model "${model}" (HTTP ${status})${detail}`;
  }
  if (status === 429) {
    return `xAI rate limited the request (HTTP 429). Try again later${detail}`;
  }
  if (status >= 500) {
    return `xAI service error (HTTP ${status}). Retried automatically; try again later if it persists${detail}`;
  }
  return `xAI request failed (HTTP ${status})${detail}`;
}

function explainFetchError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof Error && (err.name === "AbortError" || /timed out/i.test(message))) {
    return `xAI request timed out after ${REQUEST_TIMEOUT_MS / 1000}s`;
  }
  if (/cancelled|aborted/i.test(message)) {
    return "xAI request was cancelled";
  }
  return `xAI network request failed: ${message}`;
}

async function fetchWithRetry(url: string, init: RequestInit, model: string): Promise<Response> {
  let lastError: string | undefined;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const { signal, cleanup } = createTimeoutSignal(init.signal ?? undefined);
    try {
      const res = await fetch(url, { ...init, signal });
      if (res.ok || !isRetryableStatus(res.status) || attempt === MAX_ATTEMPTS) {
        return res;
      }
      lastError = explainHttpError(res.status, await readErrorBody(res), model);
    } catch (err) {
      lastError = explainFetchError(err);
      if (attempt === MAX_ATTEMPTS || /cancelled|aborted/i.test(lastError)) {
        throw new Error(`${lastError} after ${attempt} attempt${attempt === 1 ? "" : "s"}.`);
      }
    } finally {
      cleanup();
    }

    await sleep(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1), init.signal ?? undefined);
  }

  throw new Error(lastError ?? "xAI request failed.");
}

function extractDescription(json: unknown): string {
  const obj = asObject(json);
  if (!obj) return "";
  if (typeof obj.output_text === "string" && obj.output_text.trim()) return obj.output_text;
  if (!Array.isArray(obj.output)) return "";

  return obj.output
    .map(asObject)
    .filter((o): o is Record<string, unknown> => o !== undefined && o.type === "message")
    .flatMap((o) => (Array.isArray(o.content) ? o.content : []))
    .map(asObject)
    .filter(
      (o): o is Record<string, unknown> =>
        o !== undefined && o.type === "output_text" && typeof o.text === "string",
    )
    .map((o) => o.text as string)
    .join("\n");
}

/** Describe a single image via the xAI Responses endpoint. */
export async function describeImage(
  img: VisionImage,
  model: string,
  prompt: string,
  apiKey: string,
  baseUrl: string,
  signal?: AbortSignal,
): Promise<string> {
  const url = `${baseUrl.replace(/\/+$/, "")}/responses`;
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
    ...xaiRequestHeaders(model, baseUrl),
  };

  const res = await fetchWithRetry(
    url,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        input: [
          {
            role: "user",
            content: [
              { type: "input_text", text: prompt },
              {
                type: "input_image",
                image_url: `data:${img.mimeType};base64,${img.data}`,
                detail: "auto",
              },
            ],
          },
        ],
        text: { format: { type: "text" } },
        stream: false,
        store: false,
      }),
      signal,
    },
    model,
  );

  if (!res.ok) {
    const body = await readErrorBody(res);
    throw new Error(explainHttpError(res.status, body, model));
  }

  const rawText = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(rawText);
  } catch (err) {
    throw new Error(
      `xAI returned non-JSON response: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const description = extractDescription(json);
  if (!description.trim()) {
    throw new Error("xAI returned an empty description.");
  }
  return description;
}

function textContent(text: string): TextContent {
  return { type: "text", text };
}

function replaceImagesWithText(
  content: (TextContent | ImageContent)[],
  replacements: TextContent[],
  skipped?: TextContent,
): TextContent[] {
  let imageIndex = 0;
  const parts = content.flatMap((part) => {
    if (part.type === "text") return [part];

    const replacement = replacements[imageIndex];
    imageIndex += 1;
    return replacement ? [replacement] : [];
  });

  return skipped ? [...parts, skipped] : parts;
}

async function resolveApiKey(): Promise<string | undefined> {
  try {
    const effective = await getEffectiveXaiApiKey();
    return effective?.apiKey;
  } catch {
    return undefined;
  }
}

async function describeSingle(
  img: ImageContent,
  index: number,
  config: VisionConfig,
  cachePath: string,
  apiKey: string,
  baseUrl: string,
  ctx: ExtensionContext,
): Promise<string> {
  const visionImg: VisionImage = { data: img.data, mimeType: img.mimeType };
  const cacheKey = makeCacheKey(visionImg, config.model, DEFAULT_PROMPT);

  if (config.cacheEnabled) {
    const hit = loadCache(cachePath).entries[cacheKey];
    if (hit) return hit.description;
  }

  try {
    const description = await describeImage(
      visionImg,
      config.model,
      DEFAULT_PROMPT,
      apiKey,
      baseUrl,
      ctx.signal,
    );
    if (config.cacheEnabled) {
      await updateCache(cachePath, (cache) => {
        cache.entries[cacheKey] = makeCacheEntry(
          visionImg,
          config.model,
          DEFAULT_PROMPT,
          description,
        );
        pruneCache(cache, config.cacheMaxEntries);
      });
    }
    return description;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.ui.notify(`[xai-vision] description failed: ${msg}`, "warning");
    return `[Image ${index + 1} — description unavailable: ${msg}]`;
  }
}

/**
 * Tool-result handler that routes images from `read` results through a vision
 * Grok model when the active model is text-only and vision routing is enabled.
 */
export async function handleReadResult(
  event: ToolResultEvent,
  ctx: ExtensionContext,
): Promise<{ content: TextContent[] } | undefined> {
  // Accept both the native `read` tool and the capital-`Read` Cursor shim.
  if (event.toolName !== "read" && event.toolName !== "Read") return;

  const { config, warning } = loadConfig();
  const modelInput = ctx.model?.input;
  const modelId = ctx.model?.id;
  // Default: composer only. Native vision models never route. Other text-only
  // models only when mode=all (/xai-vision:on).
  if (!shouldRouteVision(config, modelId, modelInput)) return;

  const images = event.content.filter((c): c is ImageContent => c.type === "image");
  if (images.length === 0) return;

  const selected = images.slice(0, config.maxImages);
  const skipped = images.length - selected.length;

  const apiKey = await resolveApiKey();
  if (!apiKey) {
    ctx.ui.notify("[xai-vision] No API key — run /login grok-build or set XAI_API_KEY", "warning");
    return {
      content: replaceImagesWithText(
        event.content,
        selected.map(() => textContent("[xai-vision: image not described — not authenticated]")),
        skipped > 0
          ? textContent(
              `[xai-vision: ${skipped} additional image(s) omitted (maxImages=${config.maxImages}).]`,
            )
          : undefined,
      ),
    };
  }

  if (warning) ctx.ui.notify(`[xai-vision] ${warning}`, "warning");

  const baseUrl = resolveXaiConfig().xai.baseUrl;
  const cachePath = getCachePath();
  const descriptions = await Promise.all(
    selected.map((img, index) =>
      describeSingle(img, index, config, cachePath, apiKey, baseUrl, ctx),
    ),
  );

  const parts = descriptions.map((description, index) =>
    textContent(`[Image ${index + 1} — described by ${config.model}]\n${description}`),
  );
  return {
    content: replaceImagesWithText(
      event.content,
      parts,
      skipped > 0
        ? textContent(
            `[xai-vision: ${skipped} additional image(s) omitted (maxImages=${config.maxImages}).]`,
          )
        : undefined,
    ),
  };
}

// ─── Registration ────────────────────────────────────────────────────────────

export function registerXaiVision(pi: ExtensionAPI) {
  pi.on("tool_result", handleReadResult);

  pi.registerCommand("xai-vision:status", {
    description: "Show xai-vision status, mode, describer model, and cache stats",
    handler: async (_args, ctx) => {
      const { config, warning } = loadConfig();
      const mode = resolveVisionMode(config);
      const stats = cacheStats(getCachePath());
      const modeLabel =
        mode === "off"
          ? "OFF"
          : mode === "composer"
            ? "ON (composer only — default)"
            : "ON (all text-only models)";
      ctx.ui.notify(
        [
          `xai-vision: ${modeLabel}`,
          `mode: ${mode}`,
          `describer: ${config.model}`,
          `maxImages: ${config.maxImages}`,
          `cache: ${config.cacheEnabled ? "ON" : "OFF"} (${stats.entries} entries, max ${config.cacheMaxEntries})`,
          `config: ${getConfigPath()}`,
          `cache file: ${stats.path}`,
          warning ? `warning: ${warning}` : undefined,
        ]
          .filter(Boolean)
          .join("\n"),
        warning ? "warning" : "info",
      );
    },
  });

  pi.registerCommand("xai-vision:on", {
    description: "Enable xai-vision for all text-only models",
    handler: async (_args, ctx) => {
      const { config } = loadConfig();
      saveConfig({ ...config, mode: "all" });
      ctx.ui.notify(`xai-vision: ON all text-only (${config.model})`, "info");
    },
  });

  pi.registerCommand("xai-vision:composer", {
    description: "Enable xai-vision for Composer only (default)",
    handler: async (_args, ctx) => {
      const { config } = loadConfig();
      saveConfig({ ...config, mode: "composer" });
      ctx.ui.notify(`xai-vision: ON composer only (${config.model})`, "info");
    },
  });

  pi.registerCommand("xai-vision:off", {
    description: "Disable xai-vision image routing",
    handler: async (_args, ctx) => {
      const { config } = loadConfig();
      saveConfig({ ...config, mode: "off" });
      ctx.ui.notify("xai-vision: OFF", "info");
    },
  });

  pi.registerCommand("xai-vision:cache-clear", {
    description: "Clear the xai-vision description cache",
    handler: async (_args, ctx) => {
      clearCache(getCachePath());
      ctx.ui.notify("xai-vision cache: cleared", "info");
    },
  });
}
