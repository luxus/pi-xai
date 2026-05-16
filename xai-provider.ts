import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { resolveXaiConfig } from "./xai-config.ts";
import {
  loginXai,
  refreshXaiToken,
  getXaiApiKeyFromCredentials,
} from "./xai-oauth.ts";

export function registerXaiProvider(api: ExtensionAPI) {
  const config = resolveXaiConfig();

  // ========================================================================
  // xAI (Grok Build) provider — primary (and only) provider from this extension
  // ========================================================================
  // This extension now focuses exclusively on the dedicated "grok-build" provider
  // for xAI Coding Plan / Grok Build subscribers.
  //
  // - Uses the modern Responses API (`api: "openai-responses"`) for excellent
  //   native tool calling, reasoning, and multi-agent support.
  // - Authenticates via native OAuth — run `/login grok-build` (no CLI binary needed).
  // - The generic "xai" provider is intentionally NOT registered here (Pi already
  //   ships a built-in xai provider for regular API key users).
  //
  // Model list kept in sync with Hermes Agent PR #25941.
  // "grok-build" is the primary alias for Coding Plan users (max reasoning internally).
  //
  // Usage:
  //   /login grok-build
  //   /model grok-build/grok-build
  // ========================================================================
  api.registerProvider("grok-build", {
    baseUrl: config.xai.baseUrl,
    api: "openai-responses",
    authHeader: true,

    oauth: {
      name: "xAI (Grok Build)",
      login: loginXai,
      refreshToken: refreshXaiToken,
      getApiKey: getXaiApiKeyFromCredentials,
    },

    // Exact model list from Hermes PR #25941 for the Coding Plan.
    // No fast/mini variants — only what the Coding Plan officially exposes.
    models: [
      {
        id: "grok-build",
        name: "Grok Build (Coding Plan)",
        // grok-build is a special alias for Coding Plan users.
        // It does heavy reasoning internally but does NOT accept the public "reasoningEffort" parameter.
        // Declare reasoning: false so the core + our tools don't send it.
        reasoning: false,
        input: ["text", "image"],
        cost: { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 },
        contextWindow: 131072,
        maxTokens: 32768,
      },
      {
        id: "grok-4.3",
        name: "Grok 4.3 (Build)",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 },
        contextWindow: 131072,
        maxTokens: 32768,
      },
      {
        id: "grok-4.3-latest",
        name: "Grok 4.3 Latest (Build)",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 },
        contextWindow: 131072,
        maxTokens: 32768,
      },
    ],
  });
}
