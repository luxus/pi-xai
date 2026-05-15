import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  getRequiredXaiApiKey,
  resolveXaiConfig,
} from "./xai-config.ts";
import {
  loginXai,
  refreshXaiToken,
  getXaiApiKeyFromCredentials,
} from "./xai-oauth.ts";

export function registerXaiProvider(api: ExtensionAPI) {
  const config = resolveXaiConfig();

  // ========================================================================
  // 1. Override the built-in "xai" provider (Responses API support)
  // ========================================================================
  // We attach **no oauth block** on purpose.
  // Your normal `xai` usage is via API key (`XAI_API_KEY`).
  // API keys belong in the separate "API Keys" section, not under Subscriptions.
  // This prevents the xai provider from appearing as an OAuth login.
  api.registerProvider("xai", {
    baseUrl: config.xai.baseUrl,
    apiKey: "XAI_API_KEY",
    api: "openai-responses",
    authHeader: true,

    models: [
      {
        id: "grok-4",
        name: "Grok 4",
        reasoning: false,
        input: ["text", "image"],
        cost: { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 },
        contextWindow: 131072,
        maxTokens: 16384,
      },
      {
        id: "grok-4-1-fast",
        name: "Grok 4 Fast",
        reasoning: false,
        input: ["text"],
        cost: { input: 2.0, output: 10.0, cacheRead: 0.2, cacheWrite: 2.5 },
        contextWindow: 131072,
        maxTokens: 16384,
      },
      {
        id: "grok-4.20-reasoning",
        name: "Grok 4.20 Reasoning",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 },
        contextWindow: 131072,
        maxTokens: 32768,
      },
      {
        id: "grok-4.20-multi-agent",
        name: "Grok 4.20 Multi-Agent",
        reasoning: true,
        input: ["text"],
        cost: { input: 5.0, output: 25.0, cacheRead: 0.5, cacheWrite: 6.0 },
        contextWindow: 131072,
        maxTokens: 32768,
      },
      {
        id: "grok-3-mini",
        name: "Grok 3 Mini",
        reasoning: true,
        input: ["text"],
        cost: { input: 0.5, output: 2.0, cacheRead: 0.05, cacheWrite: 0.5 },
        contextWindow: 65536,
        maxTokens: 8192,
      },
    ],
  });

  // ========================================================================
  // 2. Dedicated "grok-build" provider (xAI Coding Plan / Grok Build)
  // ========================================================================
  // This is the **curated high-end** provider.
  //
  // We only expose the strongest reasoning + multi-agent models here
  // so you have zero confusion about which experience you're using.
  //
  // Authenticates via native OAuth (no grok CLI binary required).
  // Run `/login grok-build` — uses the same official xAI OAuth client as the Grok apps.
  //
  // Usage:
  //   /login grok-build
  //   /model grok-build/grok-4.20-reasoning
  // ========================================================================
  // 2. Dedicated "grok-build" provider — this one SHOULD show under Subscriptions
  // ========================================================================
  // We attach the oauth block here so that "Grok Build / xAI Coding Plan"
  // properly appears in Pi's subscriptions / login UI with a first-class native OAuth flow.
  // This is the one the user wants visible as a real subscription.
  api.registerProvider("grok-build", {
    baseUrl: config.xai.baseUrl,
    api: "openai-responses",
    authHeader: true,

    oauth: {
      name: "Grok Build / xAI Coding Plan",
      login: loginXai,
      refreshToken: refreshXaiToken,
      getApiKey: getXaiApiKeyFromCredentials,
    },

    // Only the top-tier models — no fast/mini variants on purpose
    // to keep the "Grok Build" experience clean and powerful.
    models: [
      {
        id: "grok-4.20-reasoning",
        name: "Grok 4.20 Reasoning (Build)",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 },
        contextWindow: 131072,
        maxTokens: 32768,
      },
      {
        id: "grok-4.20-multi-agent",
        name: "Grok 4.20 Multi-Agent (Build)",
        reasoning: true,
        input: ["text"],
        cost: { input: 5.0, output: 25.0, cacheRead: 0.5, cacheWrite: 6.0 },
        contextWindow: 131072,
        maxTokens: 32768,
      },
    ],
  });
}
