/**
 * Cursor/Composer tool-name compatibility for Grok models on pi.
 *
 * Grok Composer often first-calls capital Grep/Glob (and Cursor-ish arg names).
 * These thin shims wrap pi's native grep/find and activate under provider grok-build.
 *
 * Inspired by kenryu42/pi-grok-cli Cursor tool shims (MIT) — thanks @kenryu42.
 * We only port the high-ROI search aliases + a few prepareArguments normalizations,
 * not the full Cursor tool surface or cli-chat-proxy provider.
 */

import {
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createWriteToolDefinition,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { getWebSearchMode, wantsClientWebSearch } from "./xai-config.ts";
import {
  isOptionalWebSearchAvailable,
  registerOptionalWebSearch,
  WEB_SEARCH_SHIM_NAME,
  WEB_SEARCH_SUPPRESSED_NAME,
} from "./xai-web-search-shim.ts";

/** Capital Cursor-style names registered by this extension. */
export const GROK_SHIM_TOOL_NAMES = ["Grep", "Glob"] as const;

/** Pi search tools Composer needs; often inactive in the default tool set. */
export const GROK_SEARCH_TOOL_NAMES = ["grep", "find"] as const;

/** Optional Cursor WebSearch (only when pi-web-access is installed). */
export const GROK_OPTIONAL_WEB_SEARCH_NAME = WEB_SEARCH_SHIM_NAME;

/** Client tool name suppressed when WebSearch shim is active on grok-build. */
export const GROK_SUPPRESSED_WEB_SEARCH_NAME = WEB_SEARCH_SUPPRESSED_NAME;

/** Restore client web_search when leaving grok-build if we had suppressed it. */
const preservedClientWebSearch = new WeakMap<object, true>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Normalize Cursor/Composer grep args → pi grep schema. */
export function prepareGrepArgs(args: unknown): Record<string, unknown> {
  const input = isRecord(args) ? args : {};
  return {
    ...input,
    pattern: str(input.pattern) ?? "",
    path: str(input.path),
    glob: str(input.glob) ?? str(input.include) ?? str(input.glob_filter),
    ignoreCase:
      input.ignoreCase === true || input["-i"] === true || input.case_insensitive === true,
    limit: num(input.limit) ?? num(input.head_limit),
  };
}

/** Normalize Cursor Glob args (`glob_pattern`) → pi find schema. */
export function prepareGlobArgs(args: unknown): Record<string, unknown> {
  const input = isRecord(args) ? args : {};
  return {
    ...input,
    pattern: str(input.pattern) ?? str(input.glob_pattern) ?? "",
    path: str(input.path),
    limit: num(input.limit),
  };
}

/** Accept `contents` / `file_path` (Composer sometimes sends these). */
export function prepareWriteArgs(args: unknown): Record<string, unknown> {
  const input = isRecord(args) ? args : {};
  return {
    ...input,
    path: str(input.path) ?? str(input.file_path) ?? "",
    content: str(input.content) ?? str(input.contents) ?? "",
  };
}

/**
 * Strip Cursor-only edit fields that fail pi's additionalProperties:false schema
 * (e.g. replace_all) and map old_string/new_string → oldText/newText.
 */
export function prepareEditArgs(args: unknown): unknown {
  if (!isRecord(args)) return args;
  const next: Record<string, unknown> = { ...args };

  if (str(next.file_path) && !str(next.path)) next.path = next.file_path;

  if (Array.isArray(next.edits)) {
    next.edits = next.edits.map((item) => {
      if (!isRecord(item)) return item;
      const {
        replace_all: _ra,
        replaceAll: _rA,
        old_string,
        new_string,
        old_str,
        new_str,
        ...rest
      } = item;
      return {
        ...rest,
        oldText: str(rest.oldText) ?? str(old_string) ?? str(old_str) ?? rest.oldText,
        newText: str(rest.newText) ?? str(new_string) ?? str(new_str) ?? rest.newText,
      };
    });
  }

  if (str(next.old_string) || str(next.old_str) || str(next.new_string) || str(next.new_str)) {
    next.oldText = str(next.oldText) ?? str(next.old_string) ?? str(next.old_str);
    next.newText = str(next.newText) ?? str(next.new_string) ?? str(next.new_str);
  }

  return next;
}

export type ShimActiveToolsOptions = {
  /**
   * When true on grok-build: activate Cursor WebSearch and suppress client `web_search`
   * (pi-web-access installed + xai.text.webSearch is web-access|both).
   */
  clientWebSearch?: boolean;
};

/** Merge/activate search shims for grok-build; drop capital shims for other providers. */
export function nextActiveToolsWithShims(
  current: string[],
  provider: string | undefined,
  options: ShimActiveToolsOptions = {},
): string[] {
  const clientWebSearch = options.clientWebSearch === true;
  const withoutShims = current.filter(
    (name) =>
      !(GROK_SHIM_TOOL_NAMES as readonly string[]).includes(name) && name !== WEB_SEARCH_SHIM_NAME,
  );
  if (provider !== "grok-build") return withoutShims;

  const next = new Set(withoutShims);
  for (const name of GROK_SEARCH_TOOL_NAMES) next.add(name);
  for (const name of GROK_SHIM_TOOL_NAMES) next.add(name);

  if (clientWebSearch) {
    next.delete(WEB_SEARCH_SUPPRESSED_NAME);
    next.add(WEB_SEARCH_SHIM_NAME);
  }

  return [...next];
}

function syncActiveTools(
  api: Pick<ExtensionAPI, "getActiveTools" | "setActiveTools">,
  provider: string | undefined,
) {
  const current = api.getActiveTools();
  const mode = getWebSearchMode();
  const clientWebSearch = isOptionalWebSearchAvailable() && wantsClientWebSearch(mode);

  // Only suppress pi-web-access's client web_search while grok-build uses WebSearch.
  // Leaving grok-build restores it so other models can keep using pi-web-access.
  if (
    provider === "grok-build" &&
    clientWebSearch &&
    current.includes(WEB_SEARCH_SUPPRESSED_NAME)
  ) {
    preservedClientWebSearch.set(api, true);
  }

  let next = nextActiveToolsWithShims(current, provider, { clientWebSearch });

  if (provider !== "grok-build" && preservedClientWebSearch.get(api)) {
    if (!next.includes(WEB_SEARCH_SUPPRESSED_NAME)) {
      next = [...next, WEB_SEARCH_SUPPRESSED_NAME];
    }
    preservedClientWebSearch.delete(api);
  }

  if (current.length === next.length && current.every((name, i) => name === next[i])) return;
  api.setActiveTools(next);
}

export function registerGrokToolShims(api: ExtensionAPI) {
  // Optional: Cursor WebSearch → pi-web-access (only if installed).
  registerOptionalWebSearch(api);
  // Capital Grep → pi grep
  const grepBase = createGrepToolDefinition(process.cwd());
  api.registerTool({
    ...grepBase,
    name: "Grep",
    label: "Grep",
    description:
      "Search file contents for a pattern (Cursor-compatible name for pi grep). Optional path/glob filters.",
    prepareArguments: (args) => prepareGrepArgs(args) as never,
    async execute(
      toolCallId: string,
      params: Parameters<typeof grepBase.execute>[1],
      signal: AbortSignal | undefined,
      onUpdate: Parameters<typeof grepBase.execute>[3],
      ctx: ExtensionContext,
    ) {
      return createGrepToolDefinition(ctx.cwd).execute(toolCallId, params, signal, onUpdate, ctx);
    },
  });

  // Capital Glob → pi find
  const findBase = createFindToolDefinition(process.cwd());
  api.registerTool({
    ...findBase,
    name: "Glob",
    label: "Glob",
    description:
      "Find files by glob pattern (Cursor-compatible name for pi find). Returns matching paths.",
    prepareArguments: (args) => prepareGlobArgs(args) as never,
    async execute(
      toolCallId: string,
      params: Parameters<typeof findBase.execute>[1],
      signal: AbortSignal | undefined,
      onUpdate: Parameters<typeof findBase.execute>[3],
      ctx: ExtensionContext,
    ) {
      return createFindToolDefinition(ctx.cwd).execute(toolCallId, params, signal, onUpdate, ctx);
    },
  });

  // write: contents / file_path aliases
  const writeBase = createWriteToolDefinition(process.cwd());
  api.registerTool({
    ...writeBase,
    prepareArguments: (args) => prepareWriteArgs(args) as never,
    async execute(
      toolCallId: string,
      params: Parameters<typeof writeBase.execute>[1],
      signal: AbortSignal | undefined,
      onUpdate: Parameters<typeof writeBase.execute>[3],
      ctx: ExtensionContext,
    ) {
      return createWriteToolDefinition(ctx.cwd).execute(toolCallId, params, signal, onUpdate, ctx);
    },
  });

  // edit: strip replace_all; map old_string → oldText
  const editBase = createEditToolDefinition(process.cwd());
  api.registerTool({
    ...editBase,
    prepareArguments(args: unknown) {
      const normalized = prepareEditArgs(args);
      return editBase.prepareArguments
        ? editBase.prepareArguments(normalized as never)
        : (normalized as never);
    },
    async execute(
      toolCallId: string,
      params: Parameters<typeof editBase.execute>[1],
      signal: AbortSignal | undefined,
      onUpdate: Parameters<typeof editBase.execute>[3],
      ctx: ExtensionContext,
    ) {
      return createEditToolDefinition(ctx.cwd).execute(toolCallId, params, signal, onUpdate, ctx);
    },
  });

  api.on("model_select", (event) => {
    syncActiveTools(api, event.model?.provider);
  });
  api.on("before_agent_start", (_event, ctx) => {
    syncActiveTools(api, ctx.model?.provider);
  });
  api.on("session_start", (_event, ctx) => {
    syncActiveTools(api, ctx.model?.provider);
  });
}
