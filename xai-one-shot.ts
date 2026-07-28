import { createHash } from "node:crypto";
import type {
  AssistantMessage,
  Context,
  Model,
  ProviderStreamOptions,
} from "@earendil-works/pi-ai";
import { complete } from "@earendil-works/pi-ai";

export const MAX_ONE_SHOT_REQUEST_BYTES = 1 << 20;
export const MAX_ONE_SHOT_RESULT_BYTES = 512 << 10;
export const MAX_PARENT_PROMPT_BYTES = 256 << 10;
export const MAX_GENERATION_PROMPT_BYTES = 768 << 10;
export const MAX_HYPOTHESIS_BYTES = 8 << 10;
export const MAX_CANDIDATE_PROMPT_BYTES = 256 << 10;
export const MAX_OUTPUT_TOKENS = 32_768;
export const MAX_TIMEOUT_MS = 10 * 60 * 1000;

export const EXIT_INVALID_INPUT = 2;
export const EXIT_AUTH_FAILED = 3;
export const EXIT_REQUEST_FAILED = 4;
export const EXIT_INVALID_RESPONSE = 5;
export const EXIT_INTERNAL_ERROR = 6;

export const CANDIDATE_ENVELOPE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["parent_prompt_sha256", "hypothesis", "candidate_prompt"],
  properties: {
    parent_prompt_sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
    hypothesis: { type: "string", minLength: 1, maxLength: MAX_HYPOTHESIS_BYTES },
    candidate_prompt: { type: "string", minLength: 1, maxLength: MAX_CANDIDATE_PROMPT_BYTES },
  },
} as const;

export interface OneShotRequest {
  schema_version: 1;
  model: "grok-build";
  parent_prompt_sha256: string;
  parent_prompt: string;
  prompt: string;
  max_output_tokens: number;
  timeout_ms: number;
}

export interface CandidateEnvelope {
  parent_prompt_sha256: string;
  hypothesis: string;
  candidate_prompt: string;
}

export interface NormalizedUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
}

export type OneShotResultFrame =
  | { ok: true; candidate: CandidateEnvelope; usage?: NormalizedUsage }
  | { ok: false; error: { code: string; message: string } };

export interface OneShotAuth {
  /** Returns an access token internally. Callers never receive or serialize it. */
  getAccessToken(): Promise<string>;
}

export interface OneShotProvider {
  createModel(model: OneShotRequest["model"]): Model<"openai-responses">;
}

export interface OneShotTransport {
  complete(
    model: Model<"openai-responses">,
    context: Context,
    options: ProviderStreamOptions,
  ): Promise<AssistantMessage>;
}

export interface OneShotDependencies {
  auth: OneShotAuth;
  provider: OneShotProvider;
  transport: OneShotTransport;
}

export interface OneShotRunResult {
  exitCode: number;
  frame: OneShotResultFrame;
}

export const DEFAULT_ONE_SHOT_PROVIDER: OneShotProvider = {
  createModel(model) {
    return {
      id: model,
      name: "Grok Build (bounded one-shot)",
      api: "openai-responses",
      provider: "grok-build",
      baseUrl: "https://api.x.ai/v1",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 131_072,
      maxTokens: MAX_OUTPUT_TOKENS,
    };
  },
};

export const DEFAULT_ONE_SHOT_TRANSPORT: OneShotTransport = { complete };

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Validate JSON grammar while rejecting duplicate object keys before JSON.parse loses them. */
function assertStrictJson(text: string): void {
  let index = 0;
  const whitespace = () => {
    while (/\s/u.test(text[index] ?? "")) index++;
  };
  const string = (): string => {
    if (text[index] !== '"') throw new Error("expected string");
    const start = index++;
    while (index < text.length) {
      if (text[index] === "\\") {
        index += 2;
        continue;
      }
      if (text[index++] === '"') return JSON.parse(text.slice(start, index)) as string;
    }
    throw new Error("unterminated string");
  };
  const value = (): void => {
    whitespace();
    if (text[index] === "{") {
      index++;
      whitespace();
      const keys = new Set<string>();
      if (text[index] === "}") {
        index++;
        return;
      }
      while (index < text.length) {
        whitespace();
        const key = string();
        if (keys.has(key)) throw new Error("duplicate key");
        keys.add(key);
        whitespace();
        if (text[index++] !== ":") throw new Error("expected colon");
        value();
        whitespace();
        if (text[index] === "}") {
          index++;
          return;
        }
        if (text[index++] !== ",") throw new Error("expected comma");
      }
      throw new Error("unterminated object");
    }
    if (text[index] === "[") {
      index++;
      whitespace();
      if (text[index] === "]") {
        index++;
        return;
      }
      while (index < text.length) {
        value();
        whitespace();
        if (text[index] === "]") {
          index++;
          return;
        }
        if (text[index++] !== ",") throw new Error("expected comma");
      }
      throw new Error("unterminated array");
    }
    if (text[index] === '"') {
      string();
      return;
    }
    const match = /^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/u.exec(
      text.slice(index),
    );
    if (!match) throw new Error("invalid value");
    index += match[0].length;
  };
  value();
  whitespace();
  if (index !== text.length) throw new Error("trailing data");
}

export function parseStrictJson(text: string): unknown {
  assertStrictJson(text);
  return JSON.parse(text) as unknown;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return (
    actual.length === expected.length && actual.every((key, i) => key === [...expected].sort()[i])
  );
}

function validBoundedString(value: unknown, min: number, max: number): value is string {
  return typeof value === "string" && byteLength(value) >= min && byteLength(value) <= max;
}

export function validateOneShotRequest(value: unknown): value is OneShotRequest {
  if (!isRecord(value)) return false;
  if (
    !exactKeys(value, [
      "schema_version",
      "model",
      "parent_prompt_sha256",
      "parent_prompt",
      "prompt",
      "max_output_tokens",
      "timeout_ms",
    ]) ||
    value.schema_version !== 1 ||
    value.model !== "grok-build" ||
    typeof value.parent_prompt_sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.parent_prompt_sha256) ||
    !validBoundedString(value.parent_prompt, 1, MAX_PARENT_PROMPT_BYTES) ||
    !validBoundedString(value.prompt, 1, MAX_GENERATION_PROMPT_BYTES) ||
    !Number.isInteger(value.max_output_tokens) ||
    (value.max_output_tokens as number) < 1 ||
    (value.max_output_tokens as number) > MAX_OUTPUT_TOKENS ||
    !Number.isInteger(value.timeout_ms) ||
    (value.timeout_ms as number) < 1 ||
    (value.timeout_ms as number) > MAX_TIMEOUT_MS
  ) {
    return false;
  }
  return (
    createHash("sha256").update(value.parent_prompt).digest("hex") === value.parent_prompt_sha256
  );
}

function validateCandidate(value: unknown, request: OneShotRequest): value is CandidateEnvelope {
  if (!isRecord(value) || !exactKeys(value, CANDIDATE_ENVELOPE_SCHEMA.required)) return false;
  const { parent_prompt_sha256: identity, hypothesis, candidate_prompt: candidate } = value;
  return (
    identity === request.parent_prompt_sha256 &&
    validBoundedString(hypothesis, 1, MAX_HYPOTHESIS_BYTES) &&
    hypothesis.trim().length > 0 &&
    validBoundedString(candidate, 1, MAX_CANDIDATE_PROMPT_BYTES) &&
    candidate !== request.parent_prompt &&
    candidate.split("${output}").length - 1 === 1
  );
}

function normalizedUsage(message: AssistantMessage): NormalizedUsage | undefined {
  const { input, output, totalTokens } = message.usage;
  if (
    ![input, output, totalTokens].every((value) => Number.isSafeInteger(value) && value >= 0) ||
    totalTokens < input + output
  ) {
    return undefined;
  }
  return { input_tokens: input, output_tokens: output, total_tokens: totalTokens };
}

function failure(exitCode: number, code: string, message: string): OneShotRunResult {
  return { exitCode, frame: { ok: false, error: { code, message } } };
}

function errorStatus(error: unknown): number | undefined {
  if (!isRecord(error)) return undefined;
  return typeof error.status === "number" ? error.status : undefined;
}

export async function runOneShot(
  request: OneShotRequest,
  dependencies: OneShotDependencies,
): Promise<OneShotRunResult> {
  let apiKey: string;
  try {
    apiKey = await dependencies.auth.getAccessToken();
    if (!apiKey) throw new Error("missing token");
  } catch {
    return failure(EXIT_AUTH_FAILED, "oauth_unavailable", "Grok Build OAuth is unavailable.");
  }

  const model = dependencies.provider.createModel(request.model);
  let response: AssistantMessage;
  try {
    response = await dependencies.transport.complete(
      model,
      { messages: [{ role: "user", content: request.prompt, timestamp: Date.now() }] },
      {
        apiKey,
        maxTokens: request.max_output_tokens,
        timeoutMs: request.timeout_ms,
        maxRetries: 0,
        maxRetryDelayMs: 0,
        cacheRetention: "none",
        onPayload(payload) {
          if (!isRecord(payload)) throw new Error("invalid provider payload");
          payload.store = false;
          delete payload.prompt_cache_key;
          delete payload.prompt_cache_retention;
          delete payload.previous_response_id;
          delete payload.tools;
          delete payload.include;
          delete payload.workspace;
          payload.text = {
            format: {
              type: "json_schema",
              name: "candidate_envelope",
              strict: true,
              schema: CANDIDATE_ENVELOPE_SCHEMA,
            },
          };
          return payload;
        },
      },
    );
  } catch (error) {
    if (errorStatus(error) === 429) {
      return failure(EXIT_REQUEST_FAILED, "rate_limited", "Generation request was rate limited.");
    }
    return failure(EXIT_REQUEST_FAILED, "generation_failed", "Generation request failed.");
  }

  if (
    response.stopReason !== "stop" ||
    response.content.length !== 1 ||
    response.content[0]?.type !== "text" ||
    byteLength(response.content[0].text) > MAX_ONE_SHOT_RESULT_BYTES
  ) {
    return failure(
      EXIT_INVALID_RESPONSE,
      "invalid_candidate_envelope",
      "Model output was not one valid Candidate Envelope.",
    );
  }

  let candidate: unknown;
  try {
    candidate = parseStrictJson(response.content[0].text);
  } catch {
    return failure(
      EXIT_INVALID_RESPONSE,
      "invalid_candidate_envelope",
      "Model output was not one valid Candidate Envelope.",
    );
  }
  if (!validateCandidate(candidate, request)) {
    return failure(
      EXIT_INVALID_RESPONSE,
      "invalid_candidate_envelope",
      "Model output was not one valid Candidate Envelope.",
    );
  }

  const usage = normalizedUsage(response);
  return { exitCode: 0, frame: { ok: true, candidate, ...(usage ? { usage } : {}) } };
}
