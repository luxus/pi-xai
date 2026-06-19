import { describe, test, expect } from "vitest";
import { grokSupportsReasoningEffort, grokWantsEncryptedReasoningInclude } from "../xai-config.ts";
import { mergeXaiTools, stripSlashEnums } from "../index.ts";
import { isXaiEntitlementError, isXaiStaleTokenError } from "../xai-oauth.ts";
import { GROK_BUILD_MODELS } from "../xai-provider.ts";

describe("Hermes xAI parity", () => {
  test("grok-build model list", () => {
    expect(GROK_BUILD_MODELS.map((m) => m.id)).toEqual([
      "grok-build-0.1",
      "grok-4.3",
      "grok-composer-2.5-fast",
    ]);
    expect(GROK_BUILD_MODELS.find((m) => m.id === "grok-build-0.1")?.contextWindow).toBe(256_000);
    expect(GROK_BUILD_MODELS.find((m) => m.id === "grok-4.3")?.contextWindow).toBe(1_000_000);
    expect(GROK_BUILD_MODELS.find((m) => m.id === "grok-composer-2.5-fast")?.contextWindow).toBe(
      200_000,
    );
  });

  test("grokSupportsReasoningEffort allowlist matches Hermes", () => {
    expect(grokSupportsReasoningEffort("grok-4.3")).toBe(true);
    expect(grokSupportsReasoningEffort("grok-build")).toBe(false);
    expect(grokSupportsReasoningEffort("grok-build-0.1")).toBe(false);
    expect(grokSupportsReasoningEffort("grok-composer-2.5-fast")).toBe(false);
  });

  test("grokWantsEncryptedReasoningInclude follows xAI reasoning models", () => {
    expect(grokWantsEncryptedReasoningInclude("grok-4.3")).toBe(true);
    expect(grokWantsEncryptedReasoningInclude("grok-composer-2.5-fast")).toBe(false);
    expect(grokWantsEncryptedReasoningInclude("grok-4.20-reasoning")).toBe(true);
    expect(grokWantsEncryptedReasoningInclude("grok-build-0.1")).toBe(false);
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
});
