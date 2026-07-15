/**
 * Grok CLI proxy client identification headers.
 *
 * From xAI open-source Grok Build (xai-org/grok-build sampler + inject_proxy_headers).
 * Static headers on model defs pass the version gate; dynamic x-grok-conv-id via
 * before_provider_headers (registerGrokCliConvHeaders).
 */

import { arch as osArch, platform as osPlatform } from "node:os";

/** Match shipped `grok --version` / ~/.grok/version.json. Bump when stable CLI moves. */
export const GROK_CLI_VERSION = "0.2.101";

/** Official default product id (xai-grok-sampler DEFAULT_CLIENT_IDENTIFIER). */
export const GROK_CLI_CLIENT_IDENTIFIER = "grok-shell";

/** Token-auth middleware value for OAuth user tokens on cli-chat-proxy. */
export const GROK_CLI_TOKEN_AUTH = "xai-grok-cli";

/** User-Agent: `grok-shell/{version} ({os}; {arch})` */
export function grokCliUserAgent(version = GROK_CLI_VERSION): string {
  const p = osPlatform();
  const os = p === "darwin" ? "macos" : p === "win32" ? "windows" : p;
  const a = osArch();
  const arch = a === "arm64" ? "aarch64" : a;
  return `${GROK_CLI_CLIENT_IDENTIFIER}/${version} (${os}; ${arch})`;
}

/** True when base URL targets the Grok CLI chat proxy. */
export function isGrokCliProxyBaseUrl(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false;
  try {
    return new URL(baseUrl).hostname === "cli-chat-proxy.grok.com";
  } catch {
    return baseUrl.includes("cli-chat-proxy.grok.com");
  }
}

/** Static identification headers required on every CLI proxy request. */
export function grokCliModelHeaders(modelId: string): Record<string, string> {
  return {
    "User-Agent": grokCliUserAgent(),
    "x-grok-client-identifier": GROK_CLI_CLIENT_IDENTIFIER,
    "x-grok-client-version": GROK_CLI_VERSION,
    "x-grok-client-mode": "interactive",
    "x-xai-token-auth": GROK_CLI_TOKEN_AUTH,
    "x-authenticateresponse": "authenticate-response",
    "x-grok-model-override": modelId,
  };
}

/**
 * Headers for a request: CLI proxy headers when base is the proxy, else empty.
 * Adds x-grok-conv-id when a session id is available on the proxy path.
 */
export function xaiRequestHeaders(
  modelId: string,
  baseUrl: string | undefined,
  sessionId?: string | null,
): Record<string, string> {
  if (!isGrokCliProxyBaseUrl(baseUrl)) return {};
  const headers = grokCliModelHeaders(modelId);
  if (sessionId) headers["x-grok-conv-id"] = sessionId;
  return headers;
}
