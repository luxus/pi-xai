import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveXaiConfig } from "./xai-config.ts";
import { loginXai, refreshXaiToken, getXaiApiKeyFromCredentials } from "./xai-oauth.ts";

const GROK_COST = { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 };

// ponytail: aliases grok-build / grok-4.3-latest still work if typed manually; picker shows one entry each
const GROK_BUILD_MODEL_SPECS = [
  { id: "grok-build-0.1", name: "Grok Build", reasoning: false, contextWindow: 256_000 },
  { id: "grok-4.3", name: "Grok 4.3", reasoning: true, contextWindow: 1_000_000 },
  {
    id: "grok-composer-2.5-fast",
    name: "Grok Composer 2.5 Fast",
    reasoning: false,
    contextWindow: 200_000,
  },
] as const;

export const GROK_BUILD_MODELS = GROK_BUILD_MODEL_SPECS.map((m) => ({
  ...m,
  input: ["text", "image"] as ("text" | "image")[],
  cost: GROK_COST,
  maxTokens: 32768,
}));

export function registerXaiProvider(api: ExtensionAPI) {
  const config = resolveXaiConfig();

  api.registerProvider("grok-build", {
    baseUrl: config.xai.baseUrl,
    api: "openai-responses",
    authHeader: true,
    oauth: {
      name: "xAI (Grok Build)",
      usesCallbackServer: true,
      login: loginXai,
      refreshToken: refreshXaiToken,
      getApiKey: getXaiApiKeyFromCredentials,
    } as any,
    models: [...GROK_BUILD_MODELS],
  });
}
