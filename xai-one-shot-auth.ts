import { AuthStorage } from "@earendil-works/pi-coding-agent";
import type { OAuthCredentials, OAuthProviderInterface } from "@earendil-works/pi-ai";
import { grokBuildOAuthProvider } from "./xai-oauth.ts";
import type { OneShotAuth } from "./xai-one-shot.ts";

type StoredOAuthCredential = { type: "oauth" } & OAuthCredentials;

interface AuthStorageLike {
  get(provider: string): { type?: string } | undefined;
  set(provider: string, credential: StoredOAuthCredential): void;
}

export interface PiGrokBuildAuthOptions {
  authStorage?: AuthStorageLike;
  oauthProvider?: OAuthProviderInterface;
}

/**
 * Resolve only the persisted `grok-build` OAuth credential from Pi AuthStorage.
 * The pi-xai OAuth provider owns refresh behavior; AuthStorage persists rotated
 * credentials. API-key and environment fallbacks are deliberately rejected.
 */
export function createPiGrokBuildAuth(options: PiGrokBuildAuthOptions = {}): OneShotAuth {
  const authStorage = options.authStorage ?? AuthStorage.create();
  const provider = options.oauthProvider ?? grokBuildOAuthProvider;

  return {
    async getAccessToken() {
      const stored = authStorage.get("grok-build");
      if (stored?.type !== "oauth") {
        throw new Error("Grok Build OAuth is not configured");
      }
      let credential = stored as StoredOAuthCredential;
      if (Date.now() >= credential.expires) {
        const refreshed = await provider.refreshToken(credential);
        credential = { type: "oauth", ...refreshed };
        authStorage.set("grok-build", credential);
      }
      const apiKey = provider.getApiKey(credential);
      if (!apiKey) throw new Error("Grok Build OAuth is unavailable");
      return apiKey;
    },
  };
}
