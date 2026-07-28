import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import type {
  AssistantMessage,
  Context,
  Model,
  OAuthProviderInterface,
  ProviderStreamOptions,
} from "@earendil-works/pi-ai";
import { AuthStorage } from "@earendil-works/pi-coding-agent";
import {
  CANDIDATE_ENVELOPE_SCHEMA,
  DEFAULT_ONE_SHOT_PROVIDER,
  EXIT_INVALID_RESPONSE,
  EXIT_REQUEST_FAILED,
  runOneShot,
  type OneShotDependencies,
  type OneShotRequest,
} from "../xai-one-shot.ts";
import { createPiGrokBuildAuth } from "../xai-one-shot-auth.ts";
import { runOneShotCli } from "../xai-one-shot-cli.ts";

const hash = "a".repeat(64);
const parent = "Rewrite this: ${output}";
const request: OneShotRequest = {
  schema_version: 1,
  model: "grok-build",
  parent_prompt_sha256: hash,
  parent_prompt: parent,
  prompt: "Return one candidate envelope for the supplied optimization brief.",
  max_output_tokens: 512,
  timeout_ms: 12_000,
};

function message(text: string, overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-responses",
    provider: "grok-build",
    model: "grok-build",
    usage: {
      input: 11,
      output: 7,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 18,
      cost: { input: 99, output: 99, cacheRead: 0, cacheWrite: 0, total: 198 },
    },
    stopReason: "stop",
    timestamp: 0,
    ...overrides,
  };
}

function envelope(candidatePrompt = "Improved: ${output}"): string {
  return JSON.stringify({
    parent_prompt_sha256: hash,
    hypothesis: "This should preserve meaning more reliably.",
    candidate_prompt: candidatePrompt,
  });
}

function dependencies(response: AssistantMessage | Error) {
  let authCalls = 0;
  let generationCalls = 0;
  let captured:
    | { model: Model<"openai-responses">; context: Context; options: ProviderStreamOptions }
    | undefined;
  const secret = "access-secret-never-return";
  const deps: OneShotDependencies = {
    auth: {
      async getAccessToken() {
        authCalls++;
        return secret;
      },
    },
    provider: DEFAULT_ONE_SHOT_PROVIDER,
    transport: {
      async complete(model, context, options) {
        generationCalls++;
        captured = { model, context, options };
        const basePayload: Record<string, unknown> = {
          model: model.id,
          input: [{ role: "user", content: [{ type: "input_text", text: request.prompt }] }],
          stream: true,
          store: false,
        };
        await options?.onPayload?.(basePayload, model);
        if (response instanceof Error) throw response;
        return response;
      },
    },
  };
  return {
    deps,
    secret,
    counts: () => ({ authCalls, generationCalls }),
    captured: () => captured,
  };
}

describe("bounded xAI one-shot helper", () => {
  test("uses the injected Pi auth/provider seam to refresh exactly once", async () => {
    let refreshCalls = 0;
    const storage = AuthStorage.inMemory({
      "grok-build": {
        type: "oauth",
        access: "expired-secret",
        refresh: "refresh-secret",
        expires: 0,
      },
    });
    const provider: OAuthProviderInterface = {
      id: "grok-build",
      name: "fake",
      async login() {
        throw new Error("not used");
      },
      async refreshToken() {
        refreshCalls++;
        return {
          access: "fresh-secret",
          refresh: "next-refresh-secret",
          expires: Date.now() + 60_000,
        };
      },
      getApiKey(credentials) {
        return credentials.access;
      },
    };
    const auth = createPiGrokBuildAuth({ authStorage: storage, oauthProvider: provider });

    await expect(auth.getAccessToken()).resolves.toBe("fresh-secret");
    expect(refreshCalls).toBe(1);
    expect(storage.get("grok-build")).toMatchObject({ type: "oauth", access: "fresh-secret" });
  });

  test("resolves OAuth once and performs one bounded stateless generation", async () => {
    const fake = dependencies(message(envelope()));

    const result = await runOneShot(request, fake.deps);

    expect(result.exitCode).toBe(0);
    expect(fake.counts()).toEqual({ authCalls: 1, generationCalls: 1 });
    expect(result.frame).toEqual({
      ok: true,
      candidate: {
        parent_prompt_sha256: hash,
        hypothesis: "This should preserve meaning more reliably.",
        candidate_prompt: "Improved: ${output}",
      },
      usage: { input_tokens: 11, output_tokens: 7, total_tokens: 18 },
    });
    expect(JSON.stringify(result.frame)).not.toContain(fake.secret);

    const call = fake.captured()!;
    expect(call.model).toMatchObject({
      provider: "grok-build",
      id: "grok-build",
      api: "openai-responses",
    });
    expect(call.context).toEqual({
      messages: [{ role: "user", content: request.prompt, timestamp: expect.any(Number) }],
    });
    expect(call.context).not.toHaveProperty("tools");
    expect(call.options).toMatchObject({
      apiKey: fake.secret,
      maxTokens: 512,
      timeoutMs: 12_000,
      maxRetries: 0,
      cacheRetention: "none",
    });
    expect(call.options).not.toHaveProperty("sessionId");

    let payload: any = { store: false };
    payload = (await call.options.onPayload?.(payload, call.model)) ?? payload;
    expect(payload.store).toBe(false);
    expect(payload).not.toHaveProperty("tools");
    expect(payload).not.toHaveProperty("previous_response_id");
    expect(payload).not.toHaveProperty("prompt_cache_key");
    expect(payload.text.format).toEqual({
      type: "json_schema",
      name: "candidate_envelope",
      strict: true,
      schema: CANDIDATE_ENVELOPE_SCHEMA,
    });
  });

  test("does not retry a 429 and does not leak provider details", async () => {
    const error = Object.assign(new Error("429 body access-secret-never-return"), { status: 429 });
    const fake = dependencies(error);

    const result = await runOneShot(request, fake.deps);

    expect(fake.counts()).toEqual({ authCalls: 1, generationCalls: 1 });
    expect(result.exitCode).toBe(EXIT_REQUEST_FAILED);
    expect(result.frame).toEqual({
      ok: false,
      error: { code: "rate_limited", message: "Generation request was rate limited." },
    });
    expect(JSON.stringify(result.frame)).not.toContain(fake.secret);
  });

  test.each([
    ["malformed JSON", "not json"],
    [
      "duplicate fields",
      `{"parent_prompt_sha256":"${hash}","hypothesis":"one","hypothesis":"two","candidate_prompt":"x ${"${output}"}"}`,
    ],
    ["trailing output", `${envelope()}\nextra`],
  ])("rejects %s without repair", async (_name, output) => {
    const fake = dependencies(message(output));
    const result = await runOneShot(request, fake.deps);
    expect(result.exitCode).toBe(EXIT_INVALID_RESPONSE);
    expect(result.frame).toEqual({
      ok: false,
      error: {
        code: "invalid_candidate_envelope",
        message: "Model output was not one valid Candidate Envelope.",
      },
    });
    expect(fake.counts().generationCalls).toBe(1);
  });

  test("rejects multiple output blocks", async () => {
    const fake = dependencies(
      message(envelope(), {
        content: [
          { type: "text", text: envelope() },
          { type: "text", text: envelope("Other: ${output}") },
        ],
      }),
    );
    const result = await runOneShot(request, fake.deps);
    expect(result.exitCode).toBe(EXIT_INVALID_RESPONSE);
    expect(fake.counts().generationCalls).toBe(1);
  });

  test.each([
    ["wrong hash", { parent_prompt_sha256: "b".repeat(64) }],
    ["unknown field", { unexpected: true }],
    ["blank hypothesis", { hypothesis: " " }],
    ["same parent", { candidate_prompt: parent }],
    ["missing placeholder", { candidate_prompt: "No placeholder" }],
    ["two placeholders", { candidate_prompt: "${output} and ${output}" }],
  ])("rejects an envelope with %s", async (_name, patch) => {
    const value = {
      parent_prompt_sha256: hash,
      hypothesis: "A useful hypothesis",
      candidate_prompt: "Changed ${output}",
      ...patch,
    };
    const fake = dependencies(message(JSON.stringify(value)));
    const result = await runOneShot(request, fake.deps);
    expect(result.exitCode).toBe(EXIT_INVALID_RESPONSE);
  });

  test("CLI reads only stdin and emits exactly one JSON frame", async () => {
    const cliParent = "Parent ${output}";
    const cliHash = createHash("sha256").update(cliParent).digest("hex");
    const cliRequest = {
      ...request,
      parent_prompt: cliParent,
      parent_prompt_sha256: cliHash,
    };
    const fake = dependencies(
      message(
        JSON.stringify({
          parent_prompt_sha256: cliHash,
          hypothesis: "A bounded hypothesis",
          candidate_prompt: "Candidate ${output}",
        }),
      ),
    );
    const stdout: string[] = [];
    const stderr: string[] = [];

    const exitCode = await runOneShotCli(
      {
        stdin: (async function* () {
          yield JSON.stringify(cliRequest);
        })(),
        stdout: { write: (chunk) => stdout.push(chunk) },
        stderr: { write: (chunk) => stderr.push(chunk) },
      },
      fake.deps,
    );

    expect(exitCode).toBe(0);
    expect(stdout).toHaveLength(1);
    expect(stdout[0].endsWith("\n")).toBe(true);
    expect(JSON.parse(stdout[0])).toMatchObject({
      ok: true,
      candidate: { parent_prompt_sha256: cliHash },
    });
    expect(stderr).toEqual([]);
  });

  test("CLI emits one bounded sanitized failure frame for malformed input", async () => {
    const fake = dependencies(message(envelope()));
    const stdout: string[] = [];
    const stderr: string[] = [];
    const exitCode = await runOneShotCli(
      {
        stdin: (async function* () {
          yield '{"schema_version":1,"schema_version":1}';
        })(),
        stdout: { write: (chunk) => stdout.push(chunk) },
        stderr: { write: (chunk) => stderr.push(chunk) },
      },
      fake.deps,
    );
    expect(exitCode).toBe(2);
    expect(stdout).toHaveLength(1);
    expect(stdout[0].split("\n").filter(Boolean)).toHaveLength(1);
    expect(JSON.parse(stdout[0])).toEqual({
      ok: false,
      error: { code: "invalid_request", message: "stdin was not one valid bounded request." },
    });
    expect(stderr).toEqual(["pi-xai-one-shot: invalid_request\n"]);
    expect(fake.counts()).toEqual({ authCalls: 0, generationCalls: 0 });
  });

  test("omits invalid usage instead of inventing spend", async () => {
    const fake = dependencies(
      message(envelope(), {
        usage: {
          input: -1,
          output: 7,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 6,
          cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 3 },
        },
      }),
    );
    const result = await runOneShot(request, fake.deps);
    expect(result.frame).not.toHaveProperty("usage");
    expect(JSON.stringify(result.frame)).not.toContain("cost");
    expect(JSON.stringify(result.frame)).not.toContain("spend");
  });
});
