/**
 * Wire contracts we know from open-source Grok Build + live proxy probes.
 */
import { describe, expect, test } from "vitest";
import {
  XAI_API_BASE,
  XAI_CLI_BASE,
  getAgenticConfig,
  isImageGenEnabled,
  grokSupportsReasoningEffort,
  grokWantsEncryptedReasoningInclude,
} from "../xai-config.ts";
import {
  GROK_CLI_CLIENT_IDENTIFIER,
  GROK_CLI_VERSION,
  grokCliModelHeaders,
  isGrokCliProxyBaseUrl,
  xaiRequestHeaders,
} from "../xai-stream.ts";
import { registerGrokCliConvHeaders, GROK_BUILD_MODELS } from "../xai-provider.ts";
import { ensureXaiEncryptedReasoningInclude, mergeXaiTools } from "../index.ts";
import { XAI_IMAGINE_MODEL } from "../xai-image-gen.ts";

describe("defaults (official Grok Build shape)", () => {
  test("default base is CLI proxy", () => {
    // resolveXaiConfig may pick up user settings; constants define product default.
    expect(XAI_CLI_BASE).toBe("https://cli-chat-proxy.grok.com/v1");
    expect(XAI_API_BASE).toBe("https://api.x.ai/v1");
    expect(isGrokCliProxyBaseUrl(XAI_CLI_BASE)).toBe(true);
    expect(isGrokCliProxyBaseUrl(XAI_API_BASE)).toBe(false);
  });

  test("client version gate + identity", () => {
    expect(GROK_CLI_VERSION).toBe("0.2.101");
    expect(GROK_CLI_CLIENT_IDENTIFIER).toBe("grok-shell");
  });

  test("agentic server tools default on", () => {
    expect(getAgenticConfig({ xai: { baseUrl: XAI_CLI_BASE, text: {} } })).toEqual({
      enabled: true,
      tools: ["web_search", "x_search", "code_interpreter"],
    });
    expect(
      getAgenticConfig({ xai: { baseUrl: XAI_CLI_BASE, text: { agentic: false } } }).enabled,
    ).toBe(false);
  });

  test("image_gen default model + enabled", () => {
    expect(XAI_IMAGINE_MODEL).toBe("grok-imagine-image-quality");
    expect(isImageGenEnabled({ xai: { baseUrl: XAI_CLI_BASE, text: {} } })).toBe(true);
  });
});

describe("CLI proxy request headers", () => {
  test("static headers match official SamplingClient / inject_proxy_headers", () => {
    const h = grokCliModelHeaders("grok-4.5");
    expect(h).toMatchObject({
      "x-grok-client-version": "0.2.101",
      "x-grok-client-identifier": "grok-shell",
      "x-xai-token-auth": "xai-grok-cli",
      "x-authenticateresponse": "authenticate-response",
      "x-grok-client-mode": "interactive",
      "x-grok-model-override": "grok-4.5",
    });
    expect(h["User-Agent"]).toMatch(/^grok-shell\/0\.2\.101 \([^;]+; [^)]+\)$/);
  });

  test("xaiRequestHeaders only on proxy; conv-id when session present", () => {
    expect(xaiRequestHeaders("grok-4.5", XAI_API_BASE, "sess")).toEqual({});
    const h = xaiRequestHeaders("grok-4.5", XAI_CLI_BASE, "sess-1");
    expect(h["x-grok-conv-id"]).toBe("sess-1");
    expect(h["x-grok-client-version"]).toBe(GROK_CLI_VERSION);
  });

  test("before_provider_headers injects conv-id only for grok-build + proxy", () => {
    const handlers: Array<(e: any, c: any) => void> = [];
    registerGrokCliConvHeaders({
      on: (_ev: string, h: any) => handlers.push(h),
    } as any);
    expect(handlers).toHaveLength(1);
    const run = (provider: string, baseUrl: string, sessionId: string) => {
      const event = { headers: {} as Record<string, string> };
      handlers[0](event, {
        model: { provider, baseUrl },
        sessionManager: { getSessionId: () => sessionId },
      });
      return event.headers;
    };
    expect(run("grok-build", XAI_CLI_BASE, "s1")["x-grok-conv-id"]).toBe("s1");
    expect(run("grok-build", XAI_API_BASE, "s1")["x-grok-conv-id"]).toBeUndefined();
    expect(run("openai", XAI_CLI_BASE, "s1")["x-grok-conv-id"]).toBeUndefined();
    expect(run("grok-build", XAI_CLI_BASE, "")["x-grok-conv-id"]).toBeUndefined();
  });
});

describe("Responses payload helpers", () => {
  test("encrypted include on reasoning models (proxy + public — live-verified)", () => {
    const p: Record<string, unknown> = {};
    ensureXaiEncryptedReasoningInclude(p, "grok-4.5");
    expect(p.include).toEqual(["reasoning.encrypted_content"]);
    ensureXaiEncryptedReasoningInclude(p, "grok-4.5"); // idempotent
    expect(p.include).toEqual(["reasoning.encrypted_content"]);

    const build: Record<string, unknown> = {};
    ensureXaiEncryptedReasoningInclude(build, "grok-build");
    expect(build.include).toBeUndefined();
  });

  test("reasoning model gates", () => {
    expect(grokSupportsReasoningEffort("grok-4.5")).toBe(true);
    expect(grokSupportsReasoningEffort("grok-build")).toBe(false);
    expect(grokWantsEncryptedReasoningInclude("grok-4.5")).toBe(true);
    expect(grokWantsEncryptedReasoningInclude("grok-build")).toBe(false);
    expect(grokWantsEncryptedReasoningInclude("grok-4.20-reasoning")).toBe(true);
  });

  test("mergeXaiTools: client web_search function yields to server builtin", () => {
    expect(
      mergeXaiTools(
        [
          { type: "function", name: "web_search" },
          { type: "function", name: "bash" },
        ],
        [{ type: "web_search" }, { type: "x_search" }],
      ),
    ).toEqual([{ type: "function", name: "bash" }, { type: "web_search" }, { type: "x_search" }]);
  });
});

describe("model catalog", () => {
  test("ids + context windows from official/live catalog knowledge", () => {
    const byId = Object.fromEntries(GROK_BUILD_MODELS.map((m) => [m.id, m]));
    expect(byId["grok-4.5"]?.contextWindow).toBe(500_000);
    expect(byId["grok-build"]?.contextWindow).toBe(500_000);
    expect(byId["grok-composer-2.5-fast"]?.contextWindow).toBe(200_000);
    expect(byId["grok-composer-2.5-fast"]?.name).toBe("Composer 2.5");
    expect(byId["grok-4.20-multi-agent-0309"]?.contextWindow).toBe(2_000_000);
  });
});
