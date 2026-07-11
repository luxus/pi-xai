/**
 * Grok CLI proxy stream + client identification headers.
 *
 * cli-chat-proxy.grok.com enforces a client-version gate (HTTP 426 when missing).
 * Headers are attached to each model so they survive pi's default openai-responses
 * handler on tool-continuation turns; streamSimple re-asserts them per request.
 *
 * Inspired by kenryu42/pi-grok-cli (MIT) — thanks @kenryu42.
 */

import {
  type Api,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type SimpleStreamOptions,
  streamSimpleOpenAIResponses,
} from "@earendil-works/pi-ai/compat";

/** Observed Grok CLI client version accepted by the proxy version gate. */
export const GROK_CLI_VERSION = "0.2.91";

export const GROK_CLI_USER_AGENT = `grok-pager/${GROK_CLI_VERSION} grok-shell/${GROK_CLI_VERSION} (linux; x86_64)`;

export const GROK_CLI_CLIENT_IDENTIFIER = "grok-pager";
export const GROK_CLI_TOKEN_AUTH = "xai-grok-cli";

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
    "User-Agent": GROK_CLI_USER_AGENT,
    "x-grok-client-identifier": GROK_CLI_CLIENT_IDENTIFIER,
    "x-grok-client-version": GROK_CLI_VERSION,
    "x-xai-token-auth": GROK_CLI_TOKEN_AUTH,
    "x-grok-model-override": modelId,
  };
}

/**
 * Headers for a request: CLI proxy headers when base is the proxy, else empty.
 * Always adds x-grok-conv-id when a session id is available on the proxy path.
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

/** Stream via openai-responses with Grok CLI proxy headers when applicable. */
export function streamGrokCli(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const sessionId = options?.sessionId;
  const headers = {
    ...options?.headers,
    ...xaiRequestHeaders(model.id, model.baseUrl, sessionId),
  };

  return streamSimpleOpenAIResponses(model as Model<"openai-responses">, context, {
    ...options,
    headers,
    onResponse(response, responseModel) {
      return options?.onResponse?.(response, responseModel);
    },
  });
}
