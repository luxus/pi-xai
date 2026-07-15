import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveXaiConfig } from "./xai-config.ts";
import { loginXai, refreshXaiToken, getXaiApiKeyFromCredentials } from "./xai-oauth.ts";
import { grokCliModelHeaders, isGrokCliProxyBaseUrl } from "./xai-stream.ts";

// ─── Cost constants ($/M tokens) — estimates for pi UI, not subscription credits ─

const COST_BUILD = { input: 1, output: 2, cacheRead: 0.2, cacheWrite: 0.2 };
const COST_COMPOSER_FAST = { input: 3, output: 15, cacheRead: 0.5, cacheWrite: 0 };
const COST_43 = { input: 1.25, output: 2.5, cacheRead: 0.2, cacheWrite: 0 };
const COST_45 = { input: 2, output: 6, cacheRead: 0.5, cacheWrite: 0 };
const COST_420 = { input: 1.25, output: 2.5, cacheRead: 0.2, cacheWrite: 0 };

export interface GrokBuildModelSpec {
  id: string;
  name: string;
  reasoning: boolean;
  contextWindow: number;
  maxTokens: number;
  input: ("text" | "image")[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  thinkingLevelMap?: Record<string, string | null>;
}

// Catalog aligned with Grok CLI / pi-grok-cli / pi-xai-oauth observed models.
const GROK_BUILD_MODEL_SPECS: GrokBuildModelSpec[] = [
  {
    id: "grok-composer-2.5-fast",
    // Live /v1/models catalog name (models_cache.json)
    name: "Composer 2.5",
    reasoning: false,
    contextWindow: 200_000,
    maxTokens: 30_000,
    input: ["text"],
    cost: COST_COMPOSER_FAST,
    thinkingLevelMap: {
      off: "none",
      minimal: null,
      low: null,
      medium: null,
      high: null,
      xhigh: null,
    },
  },
  {
    id: "grok-build",
    name: "Grok Build",
    reasoning: true,
    // Official default_models.json: context_window 500000
    contextWindow: 500_000,
    maxTokens: 30_000,
    input: ["text", "image"],
    cost: COST_BUILD,
  },
  {
    id: "grok-4.5",
    name: "Grok 4.5",
    reasoning: true,
    contextWindow: 500_000,
    maxTokens: 131_072,
    input: ["text", "image"],
    cost: COST_45,
    thinkingLevelMap: {
      off: null,
      minimal: "low",
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: null,
    },
  },
  {
    id: "grok-4.3",
    name: "Grok 4.3",
    reasoning: true,
    contextWindow: 1_000_000,
    maxTokens: 131_072,
    input: ["text", "image"],
    cost: COST_43,
  },
  {
    id: "grok-4.20-0309-reasoning",
    name: "Grok 4.20 Reasoning",
    reasoning: true,
    contextWindow: 2_000_000,
    maxTokens: 131_072,
    input: ["text", "image"],
    cost: COST_420,
  },
  {
    id: "grok-4.20-0309-non-reasoning",
    name: "Grok 4.20 Non-Reasoning",
    reasoning: false,
    contextWindow: 2_000_000,
    maxTokens: 131_072,
    input: ["text", "image"],
    cost: COST_420,
    thinkingLevelMap: {
      off: "none",
      minimal: null,
      low: null,
      medium: null,
      high: null,
      xhigh: null,
    },
  },
  {
    id: "grok-4.20-multi-agent-0309",
    name: "Grok 4.20 Multi-Agent",
    reasoning: true,
    contextWindow: 2_000_000,
    maxTokens: 131_072,
    input: ["text", "image"],
    cost: COST_420,
  },
];

export const GROK_BUILD_MODELS = GROK_BUILD_MODEL_SPECS.map((m) => ({ ...m }));

export function registerXaiProvider(api: ExtensionAPI) {
  const config = resolveXaiConfig();
  const baseUrl = config.xai.baseUrl;
  const useCliHeaders = isGrokCliProxyBaseUrl(baseUrl);

  api.registerProvider("grok-build", {
    baseUrl,
    api: "openai-responses",
    authHeader: true,
    oauth: {
      name: "xAI (Grok Build)",
      usesCallbackServer: true,
      login: loginXai,
      refreshToken: refreshXaiToken,
      getApiKey: getXaiApiKeyFromCredentials,
    } as any,
    models: GROK_BUILD_MODELS.map((m) => ({
      id: m.id,
      name: m.name,
      reasoning: m.reasoning,
      thinkingLevelMap: m.thinkingLevelMap,
      input: m.input,
      cost: m.cost,
      contextWindow: m.contextWindow,
      maxTokens: m.maxTokens,
      // Carry static CLI headers on the model so tool-continuation turns still pass the version gate.
      // Dynamic x-grok-conv-id is injected via before_provider_headers (see registerGrokCliConvHeaders).
      ...(useCliHeaders ? { headers: grokCliModelHeaders(m.id) } : {}),
    })),
  });
}

/**
 * Scope conversation affinity headers to Grok Build CLI-proxy requests only.
 * Prefer this over a custom streamSimple (which pi-ai can clobber when re-registering
 * the default openai-responses streamer). Mirrors kenryu42/pi-grok-cli.
 */
export function registerGrokCliConvHeaders(api: ExtensionAPI) {
  api.on("before_provider_headers", (event, ctx) => {
    if (ctx.model?.provider !== "grok-build") return;
    if (!isGrokCliProxyBaseUrl(ctx.model.baseUrl)) return;
    const sessionId = ctx.sessionManager.getSessionId();
    if (!sessionId) return;
    event.headers["x-grok-conv-id"] = sessionId;
  });
}
