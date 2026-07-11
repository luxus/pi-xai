import { describe, expect, test } from "vitest";
import {
  GROK_CLI_VERSION,
  grokCliModelHeaders,
  isGrokCliProxyBaseUrl,
  xaiRequestHeaders,
} from "../xai-stream.ts";
import { XAI_API_BASE, XAI_CLI_BASE } from "../xai-config.ts";

describe("Grok CLI proxy headers", () => {
  test("detects cli-chat-proxy base URL", () => {
    expect(isGrokCliProxyBaseUrl(XAI_CLI_BASE)).toBe(true);
    expect(isGrokCliProxyBaseUrl("https://cli-chat-proxy.grok.com/v1/")).toBe(true);
    expect(isGrokCliProxyBaseUrl(XAI_API_BASE)).toBe(false);
  });

  test("model headers include version gate fields", () => {
    const h = grokCliModelHeaders("grok-4.5");
    expect(h["x-grok-client-version"]).toBe(GROK_CLI_VERSION);
    expect(h["x-xai-token-auth"]).toBe("xai-grok-cli");
    expect(h["x-grok-model-override"]).toBe("grok-4.5");
    expect(h["User-Agent"]).toContain(GROK_CLI_VERSION);
  });

  test("xaiRequestHeaders only emits for proxy base", () => {
    expect(xaiRequestHeaders("grok-4.5", XAI_API_BASE, "sess")).toEqual({});
    const h = xaiRequestHeaders("grok-build", XAI_CLI_BASE, "sess-1");
    expect(h["x-grok-conv-id"]).toBe("sess-1");
    expect(h["x-grok-client-version"]).toBe(GROK_CLI_VERSION);
  });

  test("default constant is Grok CLI proxy", () => {
    expect(XAI_CLI_BASE).toBe("https://cli-chat-proxy.grok.com/v1");
    expect(isGrokCliProxyBaseUrl(XAI_CLI_BASE)).toBe(true);
    // Public API remains available as an override target.
    expect(XAI_API_BASE).toBe("https://api.x.ai/v1");
  });
});
