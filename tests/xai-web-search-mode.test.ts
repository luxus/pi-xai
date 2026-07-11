import { describe, expect, test } from "vitest";
import {
  getAgenticConfig,
  getWebSearchMode,
  wantsClientWebSearch,
  wantsNativeWebSearch,
  type ResolvedXaiConfig,
} from "../xai-config.ts";

function cfg(webSearch?: string, agenticTools?: string[]): ResolvedXaiConfig {
  return {
    xai: {
      baseUrl: "https://api.x.ai/v1",
      text: {
        ...(webSearch !== undefined ? { webSearch } : {}),
        ...(agenticTools ? { agenticTools } : {}),
      },
    },
  };
}

describe("getWebSearchMode", () => {
  test("defaults to native", () => {
    expect(getWebSearchMode(cfg())).toBe("native");
    expect(getWebSearchMode(cfg("native"))).toBe("native");
    expect(getWebSearchMode(cfg("nope"))).toBe("native");
  });

  test("accepts web-access aliases", () => {
    expect(getWebSearchMode(cfg("web-access"))).toBe("web-access");
    expect(getWebSearchMode(cfg("web_access"))).toBe("web-access");
    expect(getWebSearchMode(cfg("client"))).toBe("web-access");
    expect(getWebSearchMode(cfg("pi-web-access"))).toBe("web-access");
  });

  test("accepts both", () => {
    expect(getWebSearchMode(cfg("both"))).toBe("both");
  });
});

describe("wantsNative/client WebSearch", () => {
  test("native only", () => {
    expect(wantsNativeWebSearch("native")).toBe(true);
    expect(wantsClientWebSearch("native")).toBe(false);
  });
  test("web-access only", () => {
    expect(wantsNativeWebSearch("web-access")).toBe(false);
    expect(wantsClientWebSearch("web-access")).toBe(true);
  });
  test("both", () => {
    expect(wantsNativeWebSearch("both")).toBe(true);
    expect(wantsClientWebSearch("both")).toBe(true);
  });
});

describe("getAgenticConfig + webSearch mode", () => {
  test("native keeps web_search in agentic tools", () => {
    const { tools } = getAgenticConfig(cfg("native"));
    expect(tools).toContain("web_search");
  });

  test("web-access strips web_search from agentic tools", () => {
    const { tools } = getAgenticConfig(cfg("web-access"));
    expect(tools).not.toContain("web_search");
    expect(tools).toContain("x_search");
  });

  test("both keeps web_search", () => {
    const { tools } = getAgenticConfig(cfg("both"));
    expect(tools).toContain("web_search");
  });

  test("web-access filters custom agenticTools list", () => {
    const { tools } = getAgenticConfig(
      cfg("web-access", ["web_search", "x_search", "code_interpreter"]),
    );
    expect(tools).toEqual(["x_search", "code_interpreter"]);
  });
});
