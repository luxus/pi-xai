/**
 * Narrow retry for Grok CLI proxy 403 "I can't help with that request."
 *
 * Official grok-build treats HTTP 403 as non-retryable (auth/forbidden). Pi's
 * openai-responses wrapper surfaces the proxy body as:
 *   OpenAI API error (403): 403 "I can't help with that request."
 * That body is a transient proxy refusal, not stale-token or entitlement.
 * Clicking continue often succeeds on the next turn.
 *
 * Pi registers provider.streamSimple as the *api* streamer (keyed by
 * "openai-responses"), so this wrap must pass through every other model.
 * Capture the builtin openai-responses streamSimple by direct import — after
 * registerProvider, getApiProvider("openai-responses") would be this wrap.
 */

import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type SimpleStreamOptions,
  type Usage,
} from "@earendil-works/pi-ai";
import { isXaiEntitlementError, isXaiStaleTokenError } from "./xai-oauth.ts";
import { isGrokCliProxyBaseUrl } from "./xai-stream.ts";

export const CANT_HELP_PHRASE = "I can't help with that request.";
/** Extra attempts after the first failure. Total tries = 1 + this. */
export const CANT_HELP_RETRY_COUNT = 2;
export const CANT_HELP_RETRY_DELAY_MS = 400;

const EMPTY_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export type StreamSimpleFn = (
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

export type CantHelpSleep = (ms: number, signal?: AbortSignal) => Promise<"slept" | "aborted">;

export type CantHelpRetryOptions = {
  extraAttempts?: number;
  delayMs?: number;
  sleep?: CantHelpSleep;
};

export function isCantHelpProxyRefusal(text: string | undefined | null): boolean {
  if (!text) return false;
  if (isXaiStaleTokenError(text) || isXaiEntitlementError(text)) return false;
  if (!text.includes(CANT_HELP_PHRASE)) return false;
  return /\b403\b/.test(text);
}

export function shouldApplyCantHelpRetry(model: { provider?: string; baseUrl?: string }): boolean {
  return model.provider === "grok-build" && isGrokCliProxyBaseUrl(model.baseUrl);
}

export async function sleepUnlessAborted(
  ms: number,
  signal?: AbortSignal,
): Promise<"slept" | "aborted"> {
  if (signal?.aborted) return "aborted";
  if (ms <= 0) return "slept";
  return await new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve("slept");
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve("aborted");
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function isContentEvent(event: AssistantMessageEvent): boolean {
  return (
    event.type === "text_start" ||
    event.type === "text_delta" ||
    event.type === "text_end" ||
    event.type === "thinking_start" ||
    event.type === "thinking_delta" ||
    event.type === "thinking_end" ||
    event.type === "toolcall_start" ||
    event.type === "toolcall_delta" ||
    event.type === "toolcall_end"
  );
}

function abortedMessage(model: Model<Api>): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: EMPTY_USAGE,
    stopReason: "aborted",
    errorMessage: "Request was aborted",
    timestamp: Date.now(),
  };
}

function pushAbort(out: AssistantMessageEventStream, model: Model<Api>): void {
  const error = abortedMessage(model);
  out.push({ type: "error", reason: "aborted", error });
  out.end();
}

/**
 * Replay a single inner stream onto `out`.
 * Returns `retry` when the attempt was a cant-help 403 with no streamed content.
 */
async function consumeAttempt(
  out: AssistantMessageEventStream,
  innerStream: AssistantMessageEventStream,
  canRetry: boolean,
): Promise<"retry" | "finished"> {
  const buffered: AssistantMessageEvent[] = [];
  let forwarded = false;
  let streamedContent = false;

  const flush = (event: AssistantMessageEvent) => {
    for (const item of buffered) out.push(item);
    buffered.length = 0;
    out.push(event);
  };

  for await (const event of innerStream) {
    if (isContentEvent(event)) streamedContent = true;

    if (!forwarded) {
      if (event.type === "error") {
        const retryable =
          canRetry && !streamedContent && isCantHelpProxyRefusal(event.error.errorMessage);
        if (retryable) return "retry";
        flush(event);
        out.end();
        return "finished";
      }
      if (event.type === "done") {
        flush(event);
        out.end();
        return "finished";
      }
      if (isContentEvent(event)) {
        forwarded = true;
        flush(event);
        continue;
      }
      buffered.push(event);
      continue;
    }

    out.push(event);
    if (event.type === "error" || event.type === "done") {
      out.end();
      return "finished";
    }
  }

  if (!forwarded && buffered.length > 0) {
    for (const item of buffered) out.push(item);
  }
  out.end();
  return "finished";
}

export function wrapGrokBuildCantHelpRetry(
  inner: StreamSimpleFn,
  retry: CantHelpRetryOptions = {},
): StreamSimpleFn {
  const extraAttempts = retry.extraAttempts ?? CANT_HELP_RETRY_COUNT;
  const delayMs = retry.delayMs ?? CANT_HELP_RETRY_DELAY_MS;
  const sleep = retry.sleep ?? sleepUnlessAborted;

  return (model, context, options) => {
    if (!shouldApplyCantHelpRetry(model)) {
      return inner(model, context, options);
    }

    const out = createAssistantMessageEventStream();
    const signal = options?.signal;

    void (async () => {
      try {
        for (let attempt = 0; attempt <= extraAttempts; attempt++) {
          if (signal?.aborted) {
            pushAbort(out, model);
            return;
          }
          const outcome = await consumeAttempt(
            out,
            inner(model, context, options),
            attempt < extraAttempts,
          );
          if (outcome === "finished") return;
          const slept = await sleep(delayMs, signal);
          if (slept === "aborted") {
            pushAbort(out, model);
            return;
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const error: AssistantMessage = {
          role: "assistant",
          content: [],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: EMPTY_USAGE,
          stopReason: signal?.aborted ? "aborted" : "error",
          errorMessage: message,
          timestamp: Date.now(),
        };
        out.push({
          type: "error",
          reason: error.stopReason === "aborted" ? "aborted" : "error",
          error,
        });
        out.end();
      }
    })();

    return out;
  };
}
