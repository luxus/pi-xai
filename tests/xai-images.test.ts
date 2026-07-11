import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  normalizeImageInput,
  normalizeImageParts,
  rewriteFunctionCallOutputImages,
} from "../xai-images.ts";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "xai-images-"));
  tempDirs.push(dir);
  return dir;
}

describe("normalizeImageInput", () => {
  test("passes through https and data URIs", () => {
    expect(normalizeImageInput("https://example.com/a.png", "/tmp")).toBe(
      "https://example.com/a.png",
    );
    expect(normalizeImageInput("data:image/png;base64,abc", "/tmp")).toBe(
      "data:image/png;base64,abc",
    );
  });

  test("reads local png into data URI within workspace", () => {
    const cwd = tempWorkspace();
    const pngPath = join(cwd, "shot.png");
    // Minimal non-empty file is enough for base64 conversion.
    writeFileSync(pngPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const out = normalizeImageInput(pngPath, cwd);
    expect(out).toMatch(/^data:image\/png;base64,/);
  });

  test("rejects paths outside workspace", () => {
    const cwd = tempWorkspace();
    mkdirSync(cwd, { recursive: true });
    expect(() => normalizeImageInput("/etc/hosts", cwd)).toThrow(
      /outside the workspace|not a valid/,
    );
  });
});

describe("normalizeImageParts", () => {
  test("converts image_url shape to input_image", () => {
    const cwd = tempWorkspace();
    const result = normalizeImageParts(
      {
        role: "user",
        content: [
          {
            type: "image_url",
            image_url: { url: "https://example.com/x.png", detail: "high" },
          },
        ],
      },
      cwd,
    ) as { content: Array<Record<string, unknown>> };
    expect(result.content[0]).toEqual({
      type: "input_image",
      image_url: "https://example.com/x.png",
      detail: "high",
    });
  });
});

describe("rewriteFunctionCallOutputImages", () => {
  test("stringifies tool output and re-attaches images for vision models", () => {
    const input = [
      {
        type: "function_call_output",
        call_id: "c1",
        output: [
          { type: "input_text", text: "meta" },
          { type: "input_image", image_url: "data:image/png;base64,aa", detail: "auto" },
        ],
      },
    ];
    const rewritten = rewriteFunctionCallOutputImages(input, true);
    expect(rewritten).toHaveLength(2);
    expect(rewritten[0]).toMatchObject({
      type: "function_call_output",
      call_id: "c1",
      output: "meta",
    });
    expect(rewritten[1]).toMatchObject({ role: "user" });
    expect((rewritten[1] as any).content).toHaveLength(2);
  });

  test("does not re-attach images when model lacks vision", () => {
    const input = [
      {
        type: "function_call_output",
        output: [{ type: "input_image", image_url: "data:image/png;base64,aa" }],
      },
    ];
    const rewritten = rewriteFunctionCallOutputImages(input, false);
    expect(rewritten).toHaveLength(1);
    expect(rewritten[0].output).toMatch(/image/);
  });
});
