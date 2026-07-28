import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { describe, expect, test } from "vitest";
import type {
  AssistantMessage,
  Context,
  Model,
  OAuthProviderInterface,
  ProviderStreamOptions,
} from "@earendil-works/pi-ai";
import { registerOAuthProvider, unregisterOAuthProvider } from "@earendil-works/pi-ai/oauth";
import { AuthStorage } from "@earendil-works/pi-coding-agent";
import {
  CANDIDATE_ENVELOPE_SCHEMA,
  DEFAULT_ONE_SHOT_PROVIDER,
  EXIT_AUTH_FAILED,
  EXIT_INVALID_RESPONSE,
  EXIT_REQUEST_FAILED,
  MAX_GENERATION_PROMPT_BYTES,
  MAX_ONE_SHOT_REQUEST_BYTES,
  MAX_PARENT_PROMPT_BYTES,
  runOneShot,
  validateOneShotRequest,
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
  test("uses Pi's locked canonical refresh path once across racing storage instances", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-xai-auth-"));
    const authPath = join(dir, "auth.json");
    await writeFile(
      authPath,
      JSON.stringify({
        "grok-build": {
          type: "oauth",
          access: "expired-secret",
          refresh: "refresh-secret",
          expires: 0,
        },
      }),
      { mode: 0o600 },
    );
    let refreshCalls = 0;
    const provider: OAuthProviderInterface = {
      id: "grok-build",
      name: "fake",
      async login() {
        throw new Error("not used");
      },
      async refreshToken(credentials) {
        refreshCalls++;
        expect(credentials.refresh).toBe("refresh-secret");
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
        return {
          access: "fresh-secret",
          refresh: "rotated-refresh-secret",
          expires: Date.now() + 60_000,
        };
      },
      getApiKey(credentials) {
        return credentials.access;
      },
    };
    registerOAuthProvider(provider);
    try {
      const first = createPiGrokBuildAuth({
        authStorage: AuthStorage.create(authPath),
        oauthProvider: provider,
      });
      const second = createPiGrokBuildAuth({
        authStorage: AuthStorage.create(authPath),
        oauthProvider: provider,
      });
      await expect(Promise.all([first.getAccessToken(), second.getAccessToken()])).resolves.toEqual(
        ["fresh-secret", "fresh-secret"],
      );
      expect(refreshCalls).toBe(1);
      const persisted = JSON.parse(await readFile(authPath, "utf8"));
      expect(persisted["grok-build"]).toMatchObject({
        type: "oauth",
        access: "fresh-secret",
        refresh: "rotated-refresh-secret",
      });
    } finally {
      unregisterOAuthProvider("grok-build");
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("surfaces AuthStorage persistence errors without exposing credentials", async () => {
    let drainCalls = 0;
    const storage = {
      get: () => ({
        type: "oauth" as const,
        access: "old-secret",
        refresh: "refresh-secret",
        expires: 0,
      }),
      getApiKey: async () => "new-secret",
      drainErrors: () => (++drainCalls === 1 ? [] : [new Error("failed writing new-secret")]),
    };
    const auth = createPiGrokBuildAuth({ authStorage: storage });
    await expect(auth.getAccessToken()).rejects.toThrow("OAuth credential persistence failed");
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
      maxRetries: 0,
      cacheRetention: "none",
    });
    expect(call.options.timeoutMs).toBeGreaterThan(0);
    expect(call.options.timeoutMs).toBeLessThanOrEqual(12_000);
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

  test("includes OAuth refresh in the total wall-clock timeout", async () => {
    let observedSignal: AbortSignal | undefined;
    const fake = dependencies(message(envelope()));
    fake.deps.auth = {
      getAccessToken(signal) {
        observedSignal = signal;
        return new Promise(() => {});
      },
    };
    const started = Date.now();
    const result = await runOneShot({ ...request, timeout_ms: 20 }, fake.deps);
    expect(Date.now() - started).toBeLessThan(500);
    expect(observedSignal?.aborted).toBe(true);
    expect(result).toEqual({
      exitCode: EXIT_AUTH_FAILED,
      frame: {
        ok: false,
        error: { code: "oauth_unavailable", message: "Grok Build OAuth is unavailable." },
      },
    });
    expect(fake.counts()).toEqual({ authCalls: 0, generationCalls: 0 });
  });

  test("passes only the remaining wall-clock budget and abort signal to generation", async () => {
    let generationSignal: AbortSignal | undefined;
    let generationTimeout: number | undefined;
    const fake = dependencies(message(envelope()));
    fake.deps.auth = {
      async getAccessToken() {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
        return "secret";
      },
    };
    fake.deps.transport.complete = async (_model, _context, options) => {
      generationSignal = options.signal;
      generationTimeout = options.timeoutMs as number;
      return new Promise(() => {});
    };
    const result = await runOneShot({ ...request, timeout_ms: 40 }, fake.deps);
    expect(generationTimeout).toBeGreaterThan(0);
    expect(generationTimeout).toBeLessThan(40);
    expect(generationSignal?.aborted).toBe(true);
    expect(result.exitCode).toBe(EXIT_REQUEST_FAILED);
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

  test("CLI rejects malformed UTF-8 rather than replacement-decoding it", async () => {
    const fake = dependencies(message(envelope()));
    const stdout: string[] = [];
    const exitCode = await runOneShotCli(
      {
        stdin: (async function* () {
          yield new Uint8Array([0x7b, 0x22, 0xc3, 0x28, 0x22, 0x3a, 0x31, 0x7d]);
        })(),
        stdout: { write: (chunk) => stdout.push(chunk) },
        stderr: { write: () => undefined },
      },
      fake.deps,
    );
    expect(exitCode).toBe(2);
    expect(JSON.parse(stdout[0])).toMatchObject({ ok: false, error: { code: "invalid_request" } });
    expect(fake.counts()).toEqual({ authCalls: 0, generationCalls: 0 });
  });

  test("CLI enforces the outer request frame at and just above its byte boundary", async () => {
    for (const size of [MAX_ONE_SHOT_REQUEST_BYTES, MAX_ONE_SHOT_REQUEST_BYTES + 1]) {
      const fake = dependencies(message(envelope()));
      const stdout: string[] = [];
      const exitCode = await runOneShotCli(
        {
          stdin: (async function* () {
            yield Buffer.alloc(size, 0x20);
          })(),
          stdout: { write: (chunk) => stdout.push(chunk) },
          stderr: { write: () => undefined },
        },
        fake.deps,
      );
      expect(exitCode).toBe(2);
      expect(stdout).toHaveLength(1);
      expect(Buffer.byteLength(stdout[0])).toBeLessThan(MAX_ONE_SHOT_REQUEST_BYTES);
      expect(fake.counts()).toEqual({ authCalls: 0, generationCalls: 0 });
    }
  });

  test("accepts exact prompt byte limits and rejects one byte over", () => {
    const boundedParent = "p".repeat(MAX_PARENT_PROMPT_BYTES);
    const bounded = {
      ...request,
      parent_prompt: boundedParent,
      parent_prompt_sha256: createHash("sha256").update(boundedParent).digest("hex"),
      prompt: "q".repeat(MAX_GENERATION_PROMPT_BYTES),
    };
    expect(validateOneShotRequest(bounded)).toBe(true);
    expect(validateOneShotRequest({ ...bounded, parent_prompt: `${boundedParent}p` })).toBe(false);
    expect(validateOneShotRequest({ ...bounded, prompt: `${bounded.prompt}q` })).toBe(false);
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

  test("package metadata matches the Pi runtime and exposes only the executable contract", async () => {
    const manifest = JSON.parse(await readFile(resolve("package.json"), "utf8"));
    expect(manifest.engines.node).toBe(">=22.19.0");
    expect(manifest.bin).toEqual({ "pi-xai-one-shot": "./xai-one-shot-bin.js" });
    expect(manifest.exports).not.toHaveProperty("./one-shot");
  });

  test("the npm-packed bin is executable and exits when OAuth refresh hangs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-xai-pack-"));
    try {
      const pack = spawn("npm", ["pack", "--ignore-scripts", "--pack-destination", dir], {
        cwd: resolve("."),
        stdio: ["ignore", "pipe", "pipe"],
      });
      let packStdout = "";
      pack.stdout.on("data", (chunk) => (packStdout += String(chunk)));
      const [packExit] = (await once(pack, "close")) as [number];
      expect(packExit).toBe(0);
      const tarball = join(dir, packStdout.trim().split("\n").at(-1)!);
      const extract = spawn("tar", ["-xzf", tarball, "-C", dir]);
      const [extractExit] = (await once(extract, "close")) as [number];
      expect(extractExit).toBe(0);
      await symlink(resolve("node_modules"), join(dir, "package", "node_modules"), "dir");

      const child = spawn(process.execPath, [join(dir, "package", "xai-one-shot-bin.js")], {
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => (stdout += String(chunk)));
      child.stderr.on("data", (chunk) => (stderr += String(chunk)));
      child.stdin.end("not-json");
      const [exitCode] = (await once(child, "close")) as [number];
      expect(exitCode).toBe(2);
      expect(stdout.split("\n").filter(Boolean)).toHaveLength(1);
      expect(JSON.parse(stdout)).toMatchObject({ ok: false, error: { code: "invalid_request" } });
      expect(stderr).toBe("pi-xai-one-shot: invalid_request\n");

      const agentDir = join(dir, "agent");
      const authPath = join(agentDir, "auth.json");
      await mkdir(agentDir);
      await writeFile(
        authPath,
        JSON.stringify({
          "grok-build": {
            type: "oauth",
            access: "expired-access",
            refresh: "refresh-value",
            expires: 0,
          },
        }),
        { mode: 0o600 },
      );
      const preload = join(dir, "hanging-fetch.mjs");
      await writeFile(
        preload,
        `globalThis.fetch = (_input, init = {}) => new Promise((_resolve, reject) => {
  const activeRequest = setInterval(() => {}, 1000);
  const abort = () => {
    clearInterval(activeRequest);
    reject(init.signal?.reason ?? new Error("aborted"));
  };
  if (init.signal?.aborted) abort();
  else init.signal?.addEventListener("abort", abort, { once: true });
});\n`,
      );
      const boundedParent = "Parent ${output}";
      const boundedRequest = {
        ...request,
        parent_prompt: boundedParent,
        parent_prompt_sha256: createHash("sha256").update(boundedParent).digest("hex"),
        timeout_ms: 75,
      };
      const started = Date.now();
      const bounded = spawn(process.execPath, [join(dir, "package", "xai-one-shot-bin.js")], {
        env: {
          ...process.env,
          PI_CODING_AGENT_DIR: agentDir,
          NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${preload}`.trim(),
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let boundedStdout = "";
      let boundedStderr = "";
      bounded.stdout.on("data", (chunk) => (boundedStdout += String(chunk)));
      bounded.stderr.on("data", (chunk) => (boundedStderr += String(chunk)));
      bounded.stdin.end(JSON.stringify(boundedRequest));
      const forceKill = setTimeout(() => bounded.kill("SIGKILL"), 3_000);
      const [boundedExit] = (await once(bounded, "close")) as [number];
      clearTimeout(forceKill);

      expect(boundedExit).toBe(EXIT_AUTH_FAILED);
      expect(Date.now() - started).toBeLessThan(1_500);
      expect(JSON.parse(boundedStdout)).toMatchObject({
        ok: false,
        error: { code: "oauth_unavailable" },
      });
      expect(boundedStderr).toBe("pi-xai-one-shot: oauth_unavailable\n");
      expect(await readdir(agentDir)).toEqual(["auth.json"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);

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
