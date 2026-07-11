/**
 * Optional Cursor-named WebSearch → pi-web-access web_search.
 *
 * Registered only when pi-web-access is installed. Activation on grok-build is
 * gated by `xai.text.webSearch` (`web-access` | `both`). Default `native` keeps
 * xAI agentic web_search and leaves client web_search for other models.
 *
 * Inspired by kenryu42/pi-grok-cli WebSearch shim (MIT) — thanks @kenryu42.
 */

import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getWebSearchMode, wantsClientWebSearch } from "./xai-config.ts";
import {
  bindLivePiWebAccess,
  ensureWebSearchDelegate,
  getWebSearchDelegate,
  getWebSearchLoadError,
  isPiWebAccessInstalled,
  PI_WEB_SEARCH_TOOL,
} from "./xai-web-search-delegate.ts";

export const WEB_SEARCH_SHIM_NAME = "WebSearch";
export const WEB_SEARCH_SUPPRESSED_NAME = "web_search";

const WEB_SEARCH_DESCRIPTION =
  "Search the web using Perplexity AI, Exa, or Gemini (via pi-web-access). Returns an AI-synthesized answer with source citations. Prefer queries (plural) with 2-4 varied angles for research. Optional: install with `pi install npm:pi-web-access`.";

const WebSearchParams = Type.Object({
  query: Type.Optional(
    Type.String({
      description:
        "Single search query. For research tasks, prefer 'queries' with multiple varied angles instead.",
    }),
  ),
  queries: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Multiple queries searched in sequence, each returning its own synthesized answer. Prefer 2-4 varied angles for broader coverage.",
    }),
  ),
  numResults: Type.Optional(
    Type.Number({ description: "Results per query (default: 5, max: 20)" }),
  ),
  includeContent: Type.Optional(Type.Boolean({ description: "Fetch full page content (async)" })),
  recencyFilter: Type.Optional(
    Type.Union(
      [Type.Literal("day"), Type.Literal("week"), Type.Literal("month"), Type.Literal("year")],
      { description: "Filter by recency" },
    ),
  ),
  domainFilter: Type.Optional(
    Type.Array(Type.String(), {
      description: "Limit to domains (prefix with - to exclude)",
    }),
  ),
  provider: Type.Optional(
    Type.Union(
      [
        Type.Literal("auto"),
        Type.Literal("perplexity"),
        Type.Literal("gemini"),
        Type.Literal("exa"),
      ],
      { description: "Search provider (default: auto)" },
    ),
  ),
  workflow: Type.Optional(
    Type.Union([Type.Literal("none"), Type.Literal("summary-review")], {
      description:
        "Search workflow mode: none = no curator, summary-review = open curator with auto summary draft (default)",
    }),
  ),
});

export function normalizeQueryList(raw: unknown[]): string[] {
  return raw
    .filter((q): q is string => typeof q === "string")
    .map((q) => q.trim())
    .filter((q) => q.length > 0);
}

export function normalizeWebSearchParams(params: Record<string, unknown>): Record<string, unknown> {
  const normalized: Record<string, unknown> = { ...params };
  if (Array.isArray(normalized.queries)) {
    normalized.queries = normalizeQueryList(normalized.queries);
  }
  if (typeof normalized.query === "string") {
    const query = normalized.query.trim();
    if (query) normalized.query = query;
    else delete normalized.query;
  }
  return normalized;
}

function missingDelegateMessage() {
  const reason =
    getWebSearchLoadError() ??
    "pi-web-access web_search delegate not available. Install with: pi install npm:pi-web-access";
  return {
    content: [
      {
        type: "text" as const,
        text: `WebSearch requires pi-web-access: ${reason}`,
      },
    ],
    details: { error: reason },
  };
}

/** Whether pi-web-access is installed (registration prerequisite). */
export function isOptionalWebSearchAvailable() {
  return isPiWebAccessInstalled();
}

/** Whether mode + install say we should expose Cursor WebSearch on grok-build. */
export function shouldActivateClientWebSearch() {
  return isPiWebAccessInstalled() && wantsClientWebSearch(getWebSearchMode());
}

export function registerOptionalWebSearch(api: ExtensionAPI) {
  if (!isPiWebAccessInstalled()) return false;

  api.registerTool({
    name: WEB_SEARCH_SHIM_NAME,
    label: "Web Search",
    description: WEB_SEARCH_DESCRIPTION,
    promptSnippet:
      "pi-web-access search (enable with xai.text.webSearch: web-access|both). Prefer {queries:[...]} with 2-4 angles.",
    parameters: WebSearchParams,

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      if (!shouldActivateClientWebSearch()) {
        return {
          content: [
            {
              type: "text" as const,
              text: 'WebSearch is installed but inactive. Set xai.text.webSearch to "web-access" or "both" (default is "native" xAI search). Restart/reload after changing settings.',
            },
          ],
          details: { error: "webSearch mode is native" },
        };
      }
      await ensureWebSearchDelegate(api);
      const delegate = getWebSearchDelegate();
      if (!delegate) return missingDelegateMessage();
      return delegate(
        toolCallId,
        normalizeWebSearchParams(params as Record<string, unknown>),
        signal,
        onUpdate,
        ctx,
      );
    },
  });

  // Only block client web_search on grok-build when we intentionally route to WebSearch.
  // Mode native: leave pi-web-access web_search alone for multi-model sessions.
  api.on("tool_call", (event, ctx) => {
    if (ctx.model?.provider !== "grok-build") return;
    if (event.toolName !== PI_WEB_SEARCH_TOOL) return;
    if (!shouldActivateClientWebSearch()) return;
    return {
      block: true,
      reason:
        'Client web_search is suppressed on grok-build when xai.text.webSearch is "web-access" or "both"; use WebSearch instead. For native xAI search only, set webSearch to "native".',
    };
  });

  api.on("session_start", async (_event, _ctx) => {
    bindLivePiWebAccess(api);
    if (shouldActivateClientWebSearch()) {
      await ensureWebSearchDelegate(api);
    }
  });

  return true;
}
