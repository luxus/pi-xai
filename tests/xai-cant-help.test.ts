import { describe, expect, test } from "vitest";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEvent,
  type Context,
  type Model,
} from "@earendil-works/pi-ai";
import {
  CANT_HELP_PHRASE,
  CANT_HELP_RETRY_COUNT,
  isCantHelpProxyRefusal,
  shouldApplyCantHelpRetry,
  wrapGrokBuildCantHelpRetry,
  type StreamSimpleFn,
} from "../xai-cant-help.ts";
import { registerXaiProvider } from "../xai-provider.ts";
import { XAI_API_BASE, XAI_CLI_BASE } from "../xai-config.ts";

const CANT_HELP_ERROR = `OpenAI API error (403): 403 "${CANT_HELP_PHRASE}"`;

const grokBuildModel = {
  id: "grok-build",
  name: "Grok Build",
  api: "openai-responses" as const,
  provider: "grok-build",
  baseUrl: XAI_CLI_BASE,
  reasoning: true,
  input: ["text"] as ("text" | "image")[],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1000,
  maxTokens: 100,
} satisfies Model<"openai-responses">;

const emptyContext: Context = { messages: [], tools: [] };

const emptyUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function message(
  model: Model<"openai-responses">,
  patch: Partial<AssistantMessage> = {},
): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: emptyUsage,
    stopReason: "stop",
    timestamp: 1,
    ...patch,
  };
}

function start(model: Model<"openai-responses">): AssistantMessageEvent {
  return { type: "start", partial: message(model) };
}

function textDelta(model: Model<"openai-responses">, delta: string): AssistantMessageEvent {
  return {
    type: "text_delta",
    contentIndex: 0,
    delta,
    partial: message(model, { content: [{ type: "text", text: delta }] }),
  };
}

function done(model: Model<"openai-responses">, text = "ok"): AssistantMessageEvent {
  const msg = message(model, { content: [{ type: "text", text }], stopReason: "stop" });
  return { type: "done", reason: "stop", message: msg };
}

function errorEvent(model: Model<"openai-responses">, errorMessage: string): AssistantMessageEvent {
  const error = message(model, { stopReason: "error", errorMessage });
  return { type: "error", reason: "error", error };
}

function streamFrom(events: AssistantMessageEvent[]): ReturnType<StreamSimpleFn> {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    for (const event of events) stream.push(event);
    stream.end();
  });
  return stream;
}

function innerFrom(factory: (call: number) => AssistantMessageEvent[]): {
  fn: StreamSimpleFn;
  calls: number;
} {
  const state = { fn: undefined as unknown as StreamSimpleFn, calls: 0 };
  state.fn = (_model, _context, _options) => {
    state.calls += 1;
    return streamFrom(factory(state.calls));
  };
  return state;
}

async function collect(stream: ReturnType<StreamSimpleFn>): Promise<AssistantMessageEvent[]> {
  const events: AssistantMessageEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

const instantSleep = async () => "slept" as const;

describe("isCantHelpProxyRefusal", () => {
  test("hits wrapped OpenAI 403 body", () => {
    expect(isCantHelpProxyRefusal(CANT_HELP_ERROR)).toBe(true);
  });

  test("requires the exact phrase and 403", () => {
    expect(isCantHelpProxyRefusal(CANT_HELP_PHRASE)).toBe(false);
    expect(isCantHelpProxyRefusal("OpenAI API error (403): 403 forbidden")).toBe(false);
    expect(isCantHelpProxyRefusal(`OpenAI API error (500): 500 "${CANT_HELP_PHRASE}"`)).toBe(false);
  });

  test("excludes stale-token and entitlement 403s", () => {
    expect(isCantHelpProxyRefusal("403 [WKE=unauthenticated:bad-credentials]")).toBe(false);
    expect(
      isCantHelpProxyRefusal(`403 You do not have an active Grok subscription ${CANT_HELP_PHRASE}`),
    ).toBe(false);
  });
});

describe("shouldApplyCantHelpRetry", () => {
  test("only grok-build on the CLI proxy", () => {
    expect(shouldApplyCantHelpRetry(grokBuildModel)).toBe(true);
    expect(shouldApplyCantHelpRetry({ ...grokBuildModel, baseUrl: XAI_API_BASE })).toBe(false);
    expect(shouldApplyCantHelpRetry({ ...grokBuildModel, provider: "openai" })).toBe(false);
  });
});

describe("wrapGrokBuildCantHelpRetry", () => {
  test("retries cant-help 403 then forwards the successful attempt", async () => {
    const inner = innerFrom((call) =>
      call === 1
        ? [start(grokBuildModel), errorEvent(grokBuildModel, CANT_HELP_ERROR)]
        : [start(grokBuildModel), textDelta(grokBuildModel, "ok"), done(grokBuildModel)],
    );
    const stream = wrapGrokBuildCantHelpRetry(inner.fn, { sleep: instantSleep })(
      grokBuildModel,
      emptyContext,
    );
    const events = await collect(stream);
    expect(inner.calls).toBe(2);
    expect(events.map((e) => e.type)).toEqual(["start", "text_delta", "done"]);
  });

  test("exhausts extra attempts and surfaces the last cant-help error", async () => {
    const inner = innerFrom(() => [
      start(grokBuildModel),
      errorEvent(grokBuildModel, CANT_HELP_ERROR),
    ]);
    const stream = wrapGrokBuildCantHelpRetry(inner.fn, { sleep: instantSleep })(
      grokBuildModel,
      emptyContext,
    );
    const events = await collect(stream);
    expect(inner.calls).toBe(1 + CANT_HELP_RETRY_COUNT);
    expect(events.map((e) => e.type)).toEqual(["start", "error"]);
    const last = events[1];
    expect(last.type).toBe("error");
    if (last.type === "error") {
      expect(last.error.errorMessage).toBe(CANT_HELP_ERROR);
    }
  });

  test("does not retry after streamed text", async () => {
    const inner = innerFrom(() => [
      start(grokBuildModel),
      textDelta(grokBuildModel, "partial"),
      errorEvent(grokBuildModel, CANT_HELP_ERROR),
    ]);
    const stream = wrapGrokBuildCantHelpRetry(inner.fn, { sleep: instantSleep })(
      grokBuildModel,
      emptyContext,
    );
    const events = await collect(stream);
    expect(inner.calls).toBe(1);
    expect(events.map((e) => e.type)).toEqual(["start", "text_delta", "error"]);
  });

  test("does not retry entitlement 403", async () => {
    const inner = innerFrom(() => [
      start(grokBuildModel),
      errorEvent(grokBuildModel, "403 You do not have an active Grok subscription"),
    ]);
    const stream = wrapGrokBuildCantHelpRetry(inner.fn, { sleep: instantSleep })(
      grokBuildModel,
      emptyContext,
    );
    await collect(stream);
    expect(inner.calls).toBe(1);
  });

  test("aborts during retry delay", async () => {
    const ac = new AbortController();
    let resumeAbort: () => void = () => {};
    const waiting = new Promise<void>((resolve) => {
      resumeAbort = resolve;
    });
    const inner = innerFrom(() => [
      start(grokBuildModel),
      errorEvent(grokBuildModel, CANT_HELP_ERROR),
    ]);
    const stream = wrapGrokBuildCantHelpRetry(inner.fn, {
      sleep: async (_ms, signal) => {
        resumeAbort();
        await new Promise<void>((resolve) => {
          signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        return "aborted";
      },
    })(grokBuildModel, emptyContext, { signal: ac.signal });

    const eventsPromise = collect(stream);
    await waiting;
    ac.abort();
    const events = await eventsPromise;
    expect(inner.calls).toBe(1);
    expect(events.map((e) => e.type)).toEqual(["error"]);
    const last = events[0];
    expect(last.type).toBe("error");
    if (last.type === "error") {
      expect(last.reason).toBe("aborted");
    }
  });

  test("pass-through for public API and other providers", async () => {
    const inner = innerFrom(() => [
      start(grokBuildModel),
      errorEvent(grokBuildModel, CANT_HELP_ERROR),
    ]);
    const wrapped = wrapGrokBuildCantHelpRetry(inner.fn, { sleep: instantSleep });
    await collect(wrapped({ ...grokBuildModel, baseUrl: XAI_API_BASE }, emptyContext));
    expect(inner.calls).toBe(1);
    await collect(wrapped({ ...grokBuildModel, provider: "openai" }, emptyContext));
    expect(inner.calls).toBe(2);
  });
});

describe("registerXaiProvider", () => {
  test("installs the cant-help streamSimple wrap", () => {
    let captured: { id?: string; streamSimple?: unknown };
    registerXaiProvider({
      registerProvider: (id: string, cfg: { streamSimple?: unknown }) => {
        captured = { id, streamSimple: cfg.streamSimple };
      },
    } as any);
    expect(captured!.id).toBe("grok-build");
    expect(typeof captured!.streamSimple).toBe("function");
  });
});
