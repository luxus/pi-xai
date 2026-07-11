import { describe, test, expect } from "vitest";
import {
  grokSupportsReasoningEffort,
  grokWantsEncryptedReasoningInclude,
  isMultiAgentToolEnabled,
} from "../xai-config.ts";
import {
  clampXaiPromptCacheKey,
  ensureXaiPromptCacheKey,
  mergeXaiTools,
  stripSlashEnums,
  XAI_PROMPT_CACHE_KEY_MAX_LENGTH,
} from "../index.ts";
import { isXaiEntitlementError, isXaiStaleTokenError } from "../xai-oauth.ts";
import { GROK_BUILD_MODELS } from "../xai-provider.ts";

describe("Hermes xAI parity", () => {
  test("grok-build model list", () => {
    expect(GROK_BUILD_MODELS.map((m) => m.id)).toEqual([
      "grok-composer-2.5-fast",
      "grok-build",
      "grok-4.5",
      "grok-4.3",
      "grok-4.20-0309-reasoning",
      "grok-4.20-0309-non-reasoning",
      "grok-4.20-multi-agent-0309",
    ]);
    expect(GROK_BUILD_MODELS.find((m) => m.id === "grok-4.5")?.contextWindow).toBe(500_000);
    expect(GROK_BUILD_MODELS.find((m) => m.id === "grok-build")?.contextWindow).toBe(512_000);
    expect(GROK_BUILD_MODELS.find((m) => m.id === "grok-4.3")?.contextWindow).toBe(1_000_000);
    expect(GROK_BUILD_MODELS.find((m) => m.id === "grok-composer-2.5-fast")?.contextWindow).toBe(
      200_000,
    );
    expect(GROK_BUILD_MODELS.find((m) => m.id === "grok-4.20-0309-reasoning")?.contextWindow).toBe(
      2_000_000,
    );
  });

  test("per-model costs are accurate estimates (not flat)", () => {
    expect(GROK_BUILD_MODELS.find((m) => m.id === "grok-4.5")?.cost).toEqual({
      input: 2,
      output: 6,
      cacheRead: 0.5,
      cacheWrite: 0,
    });
    expect(GROK_BUILD_MODELS.find((m) => m.id === "grok-build")?.cost).toEqual({
      input: 1,
      output: 2,
      cacheRead: 0.2,
      cacheWrite: 0.2,
    });
    expect(GROK_BUILD_MODELS.find((m) => m.id === "grok-composer-2.5-fast")?.cost.input).toBe(3);
  });

  test("grokSupportsReasoningEffort allowlist matches Hermes", () => {
    expect(grokSupportsReasoningEffort("grok-4.5")).toBe(true);
    expect(grokSupportsReasoningEffort("grok-4.3")).toBe(true);
    expect(grokSupportsReasoningEffort("grok-build")).toBe(false);
    expect(grokSupportsReasoningEffort("grok-build-0.1")).toBe(false);
    expect(grokSupportsReasoningEffort("grok-composer-2.5-fast")).toBe(false);
  });

  test("xai_multi_agent is opt-in (off by default)", () => {
    expect(isMultiAgentToolEnabled({ xai: { baseUrl: "https://api.x.ai/v1", text: {} } })).toBe(
      false,
    );
    expect(
      isMultiAgentToolEnabled({
        xai: { baseUrl: "https://api.x.ai/v1", text: { multiAgent: true } },
      }),
    ).toBe(true);
    expect(
      isMultiAgentToolEnabled({
        xai: { baseUrl: "https://api.x.ai/v1", text: { multiAgent: "true" } },
      }),
    ).toBe(true);
  });

  test("grokWantsEncryptedReasoningInclude follows xAI reasoning models", () => {
    expect(grokWantsEncryptedReasoningInclude("grok-4.5")).toBe(true);
    expect(grokWantsEncryptedReasoningInclude("grok-4.3")).toBe(true);
    expect(grokWantsEncryptedReasoningInclude("grok-composer-2.5-fast")).toBe(false);
    expect(grokWantsEncryptedReasoningInclude("grok-4.20-reasoning")).toBe(true);
    expect(grokWantsEncryptedReasoningInclude("grok-build")).toBe(false);
  });

  test("clampXaiPromptCacheKey matches Pi 64-code-point limit", () => {
    expect(clampXaiPromptCacheKey(undefined)).toBeUndefined();
    expect(clampXaiPromptCacheKey("")).toBeUndefined();
    expect(clampXaiPromptCacheKey("  ")).toBeUndefined();
    expect(clampXaiPromptCacheKey("session-abc")).toBe("session-abc");
    const long = "x".repeat(XAI_PROMPT_CACHE_KEY_MAX_LENGTH + 10);
    expect(clampXaiPromptCacheKey(long)).toBe("x".repeat(XAI_PROMPT_CACHE_KEY_MAX_LENGTH));
  });

  test("ensureXaiPromptCacheKey prefers existing key then session id", () => {
    const withExisting: Record<string, unknown> = { prompt_cache_key: "custom-key" };
    ensureXaiPromptCacheKey(withExisting, "session-1");
    expect(withExisting.prompt_cache_key).toBe("custom-key");

    const fromSession: Record<string, unknown> = {};
    ensureXaiPromptCacheKey(fromSession, "session-2");
    expect(fromSession.prompt_cache_key).toBe("session-2");

    const blankExisting: Record<string, unknown> = { prompt_cache_key: "   " };
    ensureXaiPromptCacheKey(blankExisting, "session-3");
    expect(blankExisting.prompt_cache_key).toBe("session-3");

    const noSession: Record<string, unknown> = {};
    ensureXaiPromptCacheKey(noSession, undefined);
    expect(noSession.prompt_cache_key).toBeUndefined();
  });

  test("stripSlashEnums removes slash-containing enum values", () => {
    const tools = [
      {
        type: "function",
        name: "pick_model",
        parameters: { type: "object", properties: { id: { enum: ["Qwen/Qwen3.5-0.8B"] } } },
      },
    ];
    stripSlashEnums(tools);
    expect((tools[0] as any).parameters.properties.id.enum).toBeUndefined();
  });

  test("WKE disambiguator separates stale token from entitlement (#29344)", () => {
    expect(
      isXaiStaleTokenError(
        "OAuth2 access token could not be validated. [WKE=unauthenticated:bad-credentials]",
      ),
    ).toBe(true);
    expect(isXaiEntitlementError("You do not have an active Grok subscription")).toBe(true);
    expect(
      isXaiEntitlementError(
        "OAuth2 access token could not be validated. [WKE=unauthenticated:bad-credentials]",
      ),
    ).toBe(false);
  });

  test("mergeXaiTools drops client web_search function, keeps native builtin", () => {
    const merged = mergeXaiTools(
      [
        { type: "function", name: "web_search", parameters: {} },
        { type: "function", name: "bash" },
      ],
      [{ type: "web_search" }, { type: "x_search" }],
    );
    expect(merged).toEqual([
      { type: "function", name: "bash" },
      { type: "web_search" },
      { type: "x_search" },
    ]);
  });

  test("mergeXaiTools dedupes duplicate built-in tools by type", () => {
    const merged = mergeXaiTools(
      [{ type: "function", name: "bash" }, { type: "web_search" }, { type: "x_search" }],
      [{ type: "web_search" }, { type: "x_search" }, { type: "code_interpreter" }],
    );
    expect(merged).toEqual([
      { type: "function", name: "bash" },
      { type: "web_search" },
      { type: "x_search" },
      { type: "code_interpreter" },
    ]);
  });
});
