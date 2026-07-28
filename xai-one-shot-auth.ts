import { AuthStorage } from "@earendil-works/pi-coding-agent";
import type { OAuthProviderInterface } from "@earendil-works/pi-ai";
import { registerOAuthProvider } from "@earendil-works/pi-ai/oauth";
import { grokBuildOAuthProvider } from "./xai-oauth.ts";
import type { OneShotAuth } from "./xai-one-shot.ts";

interface AuthStorageLike {
  get(provider: string): { type?: string } | undefined;
  getApiKey(provider: string, options?: { includeFallback?: boolean }): Promise<string | undefined>;
  drainErrors(): Error[];
}

export interface PiGrokBuildAuthOptions {
  authStorage?: AuthStorageLike;
  oauthProvider?: OAuthProviderInterface;
}

/**
 * Resolve only the persisted `grok-build` OAuth credential through Pi's
 * canonical AuthStorage path. AuthStorage owns its atomic cross-process refresh
 * lock and persists refresh-token rotation before the access token is returned.
 * API-key, environment, runtime, and fallback credentials are rejected.
 */
export function createPiGrokBuildAuth(options: PiGrokBuildAuthOptions = {}): OneShotAuth {
  const authStorage = options.authStorage ?? AuthStorage.create();
  const provider = options.oauthProvider ?? grokBuildOAuthProvider;
  registerOAuthProvider(provider);

  return {
    async getAccessToken(signal) {
      // pi-coding-agent ships its own locked pi-ai runtime via npm shrinkwrap.
      // Register in that registry too; flattened installs use the registration above.
      try {
        const codingAgentEntry = import.meta.resolve("@earendil-works/pi-coding-agent");
        const runtimeOAuthUrl = new URL(
          "../node_modules/@earendil-works/pi-ai/dist/oauth.js",
          codingAgentEntry,
        );
        const runtimeOAuth = (await import(runtimeOAuthUrl.href)) as {
          registerOAuthProvider(value: OAuthProviderInterface): void;
        };
        runtimeOAuth.registerOAuthProvider(provider);
      } catch (error) {
        const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
        if (code !== "ERR_MODULE_NOT_FOUND") throw error;
      }
      if (signal?.aborted) throw signal.reason;
      if (authStorage.get("grok-build")?.type !== "oauth") {
        throw new Error("Grok Build OAuth is not configured");
      }
      if (authStorage.drainErrors().length > 0) {
        throw new Error("OAuth credential storage is unavailable");
      }

      const apiKey = await authStorage.getApiKey("grok-build", { includeFallback: false });
      if (signal?.aborted) throw signal.reason;
      if (authStorage.drainErrors().length > 0) {
        throw new Error("OAuth credential persistence failed");
      }
      if (!apiKey) throw new Error("Grok Build OAuth is unavailable");
      return apiKey;
    },
  };
}
