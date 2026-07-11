import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../xai-oauth.ts", () => ({
  getEffectiveXaiApiKey: vi.fn(async () => ({ apiKey: "provider-token", source: "env" })),
}));

import { getEffectiveXaiApiKey } from "../xai-oauth.ts";
import {
  DEFAULT_CONFIG,
  DEFAULT_DESCRIBE_MODEL,
  describableModels,
  getCachePath,
  getConfigPath,
  handleReadResult,
  isComposerModel,
  loadConfig,
  makeCacheKey,
  normalizeConfig,
  pruneCache,
  resolveVisionMode,
  shouldRouteVision,
  type CacheFile,
  type VisionImage,
} from "../xai-vision.ts";
import { GROK_BUILD_MODELS } from "../xai-provider.ts";

const PNG = Buffer.from("fake-png-bytes").toString("base64");

const originalFetch = globalThis.fetch;
const originalHome = process.env.HOME;
const tempDirs: string[] = [];
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "xai-vision-"));
  mkdirSync(join(dir, ".pi"), { recursive: true });
  tempDirs.push(dir);
  process.env.HOME = dir;
  vi.mocked(getEffectiveXaiApiKey).mockResolvedValue({
    apiKey: "provider-token",
    source: "env",
  } as any);
  fetchMock = vi.fn<typeof fetch>(async () =>
    Response.json({ output_text: "a screenshot of a button" }),
  );
  globalThis.fetch = fetchMock;
  // Routing tests use mode=all so non-composer text-only models also route.
  writeFileSync(getConfigPath(), JSON.stringify({ mode: "all" }));
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.clearAllMocks();
});

interface CtxOverrides {
  modelId?: string;
  modelInput?: ("text" | "image")[];
  signal?: AbortSignal;
  withKey?: boolean;
}

function buildCtx(overrides: CtxOverrides = {}): ExtensionContext {
  if (overrides.withKey === false) {
    vi.mocked(getEffectiveXaiApiKey).mockResolvedValue(null as any);
  }
  return {
    model: {
      id: overrides.modelId ?? "text-only-other",
      input: overrides.modelInput ?? ["text"],
    },
    ui: { notify: vi.fn() },
    signal: overrides.signal,
  } as unknown as ExtensionContext;
}

function readEvent(content: unknown[], toolName = "read"): ToolResultEvent {
  return {
    type: "tool_result",
    toolName,
    toolCallId: "call-1",
    input: {},
    content,
    isError: false,
    details: undefined,
  } as unknown as ToolResultEvent;
}

function imageBlock(data = PNG): unknown {
  return { type: "image", data, mimeType: "image/png" };
}

function lastBody(): Record<string, unknown> {
  const init = fetchMock.mock.calls.at(-1)?.[1] as RequestInit | undefined;
  return JSON.parse(String(init?.body)) as Record<string, unknown>;
}

describe("normalizeConfig / loadConfig", () => {
  it("defaults to composer-only mode", () => {
    expect(DEFAULT_CONFIG.mode).toBe("composer");
    expect(DEFAULT_CONFIG.model).toBe(DEFAULT_DESCRIBE_MODEL);
  });

  it("rejects non-vision describer models", () => {
    const warnings: string[] = [];
    const config = normalizeConfig({ model: "grok-composer-2.5-fast" }, warnings);
    expect(config.model).toBe(DEFAULT_DESCRIBE_MODEL);
    expect(warnings[0]).toMatch(/Unknown model/);
  });

  it("accepts image-capable models and legacy enabled:true → mode all", () => {
    const config = normalizeConfig({ model: "grok-4.5", enabled: true });
    expect(config.model).toBe("grok-4.5");
    expect(config.mode).toBe("all");
  });

  it("legacy enabled:false → mode off", () => {
    expect(normalizeConfig({ enabled: false }).mode).toBe("off");
  });

  it("describable models are vision-capable (exclude composer)", () => {
    expect(describableModels()).toContain("grok-4.5");
    expect(describableModels()).toContain("grok-4.3");
    expect(describableModels()).not.toContain("grok-composer-2.5-fast");
  });

  it("loadConfig returns composer default when file missing", () => {
    rmSync(getConfigPath(), { force: true });
    const { config } = loadConfig();
    expect(config.mode).toBe("composer");
    expect(resolveVisionMode(config)).toBe("composer");
  });

  it("shouldRouteVision: composer default vs all vs off", () => {
    const composerCfg = normalizeConfig({ mode: "composer" });
    expect(shouldRouteVision(composerCfg, "grok-composer-2.5-fast", ["text"])).toBe(true);
    expect(shouldRouteVision(composerCfg, "other-text", ["text"])).toBe(false);
    expect(shouldRouteVision(composerCfg, "grok-4.5", ["text", "image"])).toBe(false);

    const allCfg = normalizeConfig({ mode: "all" });
    expect(shouldRouteVision(allCfg, "other-text", ["text"])).toBe(true);

    const offCfg = normalizeConfig({ mode: "off" });
    expect(shouldRouteVision(offCfg, "grok-composer-2.5-fast", ["text"])).toBe(false);
  });

  it("isComposerModel detects composer ids", () => {
    expect(isComposerModel("grok-composer-2.5-fast")).toBe(true);
    expect(isComposerModel("grok-build/grok-composer-2.5-fast")).toBe(true);
    expect(isComposerModel("grok-4.5")).toBe(false);
  });
});

describe("composer model input", () => {
  it("marks grok-composer-2.5-fast as text-only", () => {
    const composer = GROK_BUILD_MODELS.find((m) => m.id === "grok-composer-2.5-fast");
    expect(composer?.input).toEqual(["text"]);
    expect(composer?.input.includes("image")).toBe(false);
  });

  it("keeps native vision on flagship models", () => {
    for (const id of ["grok-4.5", "grok-4.3"]) {
      const m = GROK_BUILD_MODELS.find((x) => x.id === id);
      expect(m?.input).toContain("image");
    }
  });
});

describe("handleReadResult — no-op cases", () => {
  it("does nothing when the active model handles images natively", async () => {
    const result = await handleReadResult(
      readEvent([imageBlock()]),
      buildCtx({ modelInput: ["text", "image"] }),
    );
    expect(result).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("routes when the model has no declared input (treated as non-vision)", async () => {
    const result = await handleReadResult(readEvent([imageBlock()]), buildCtx({ modelInput: [] }));
    expect(result?.content[0]).toMatchObject({ type: "text" });
    expect((result?.content[0] as { text: string }).text).toContain(
      `described by ${DEFAULT_DESCRIBE_MODEL}`,
    );
  });

  it("does nothing for a non-read tool", async () => {
    const result = await handleReadResult(readEvent([imageBlock()], "bash"), buildCtx());
    expect(result).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does nothing when the read result has no images", async () => {
    const result = await handleReadResult(
      readEvent([{ type: "text", text: "just text" }]),
      buildCtx(),
    );
    expect(result).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does nothing when routing is disabled", async () => {
    writeFileSync(getConfigPath(), JSON.stringify({ mode: "off" }));
    const result = await handleReadResult(
      readEvent([imageBlock()]),
      buildCtx({ modelId: "grok-composer-2.5-fast" }),
    );
    expect(result).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("default composer mode skips non-composer text-only models", async () => {
    rmSync(getConfigPath(), { force: true });
    const result = await handleReadResult(
      readEvent([imageBlock()]),
      buildCtx({ modelId: "some-other-text-model", modelInput: ["text"] }),
    );
    expect(result).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("default composer mode routes for Composer", async () => {
    rmSync(getConfigPath(), { force: true });
    const result = await handleReadResult(
      readEvent([imageBlock()]),
      buildCtx({ modelId: "grok-composer-2.5-fast", modelInput: ["text"] }),
    );
    expect(result?.content[0]).toMatchObject({ type: "text" });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("accepts capital Read tool name", async () => {
    const result = await handleReadResult(readEvent([imageBlock()], "Read"), buildCtx());
    expect(result?.content[0]).toMatchObject({ type: "text" });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

describe("handleReadResult — image routing", () => {
  it("describes an image via grok-4.5 and replaces it with text", async () => {
    const ctx = buildCtx();
    const result = await handleReadResult(readEvent([imageBlock()]), ctx);

    expect(fetchMock).toHaveBeenCalledOnce();
    // Default base is Grok CLI proxy (settings may override in real installs).
    expect(String(fetchMock.mock.calls[0]?.[0])).toMatch(/\/responses$/);

    const body = lastBody();
    expect(body.model).toBe(DEFAULT_DESCRIBE_MODEL);
    expect(body.stream).toBe(false);
    expect(body.store).toBe(false);
    const content = (body.input as Array<{ content: Array<Record<string, unknown>> }>)[0].content;
    expect(content[1]).toEqual({
      type: "input_image",
      image_url: `data:image/png;base64,${PNG}`,
      detail: "auto",
    });

    const headers = (fetchMock.mock.calls[0]?.[1] as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer provider-token");

    expect(result?.content).toHaveLength(1);
    expect(result?.content[0]).toEqual({
      type: "text",
      text: `[Image 1 — described by ${DEFAULT_DESCRIBE_MODEL}]\na screenshot of a button`,
    });
  });

  it("reuses a cached description without calling the API on the second sight", async () => {
    const ctx = buildCtx();
    await handleReadResult(readEvent([imageBlock()]), ctx);
    await handleReadResult(readEvent([imageBlock()]), ctx);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("describes multiple images with preserved order and labels", async () => {
    const result = await handleReadResult(
      readEvent([
        imageBlock(Buffer.from("img-a").toString("base64")),
        imageBlock(Buffer.from("img-b").toString("base64")),
      ]),
      buildCtx(),
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result?.content).toEqual([
      {
        type: "text",
        text: `[Image 1 — described by ${DEFAULT_DESCRIBE_MODEL}]\na screenshot of a button`,
      },
      {
        type: "text",
        text: `[Image 2 — described by ${DEFAULT_DESCRIBE_MODEL}]\na screenshot of a button`,
      },
    ]);
  });

  it("preserves text when replacing images in mixed read results", async () => {
    const result = await handleReadResult(
      readEvent([{ type: "text", text: "file metadata" }, imageBlock()]),
      buildCtx(),
    );

    expect(result?.content).toEqual([
      { type: "text", text: "file metadata" },
      {
        type: "text",
        text: `[Image 1 — described by ${DEFAULT_DESCRIBE_MODEL}]\na screenshot of a button`,
      },
    ]);
  });

  it("writes the cache file", async () => {
    await handleReadResult(readEvent([imageBlock()]), buildCtx());
    const cachePath = getCachePath();
    expect(existsSync(cachePath)).toBe(true);
    const cache = JSON.parse(readFileSync(cachePath, "utf-8"));
    expect(Object.keys(cache.entries)).toHaveLength(1);
  });
});

describe("handleReadResult — failure handling", () => {
  it("returns a text error and warns when the API rejects the request", async () => {
    fetchMock = vi.fn<typeof fetch>(async () => new Response("bad model", { status: 400 }));
    globalThis.fetch = fetchMock;

    const ctx = buildCtx();
    const result = await handleReadResult(readEvent([imageBlock()]), ctx);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(result?.content).toHaveLength(1);
    expect((result?.content[0] as { text: string }).text).toMatch(
      /Image 1 — description unavailable/,
    );
    expect((result?.content[0] as { text: string }).text).toMatch(/HTTP 400/);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringMatching(/description failed/),
      "warning",
    );
  });

  it("returns a not-authenticated note and never calls the API without a key", async () => {
    const ctx = buildCtx({ withKey: false });
    const result = await handleReadResult(readEvent([imageBlock()]), ctx);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result?.content).toEqual([
      { type: "text", text: "[xai-vision: image not described — not authenticated]" },
    ]);
  });
});

describe("cache helpers", () => {
  it("makeCacheKey differs by image bytes", () => {
    const a: VisionImage = { data: Buffer.from("a").toString("base64"), mimeType: "image/png" };
    const b: VisionImage = { data: Buffer.from("b").toString("base64"), mimeType: "image/png" };
    expect(makeCacheKey(a, "m", "p")).not.toBe(makeCacheKey(b, "m", "p"));
  });

  it("pruneCache keeps newest entries", () => {
    const cache: CacheFile = {
      version: 1,
      entries: {
        old: {
          createdAt: "2020-01-01T00:00:00.000Z",
          description: "old",
          imageHash: "1",
          mediaType: "image/png",
          model: "m",
          promptHash: "p",
        },
        neu: {
          createdAt: "2024-01-01T00:00:00.000Z",
          description: "new",
          imageHash: "2",
          mediaType: "image/png",
          model: "m",
          promptHash: "p",
        },
      },
    };
    pruneCache(cache, 1);
    expect(Object.keys(cache.entries)).toEqual(["neu"]);
  });
});
