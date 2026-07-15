import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { resolveImagineImageRef } from "../xai-image-gen.ts";

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("resolveImagineImageRef", () => {
  test("passes through https and data URIs", () => {
    expect(resolveImagineImageRef("https://example.com/a.png")).toBe("https://example.com/a.png");
    expect(resolveImagineImageRef("data:image/png;base64,abc")).toBe("data:image/png;base64,abc");
  });

  test("reads absolute local jpg under /tmp", () => {
    const dir = mkdtempSync(join(tmpdir(), "imagine-ref-"));
    tempDirs.push(dir);
    const path = join(dir, "shot.jpg");
    writeFileSync(path, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    expect(resolveImagineImageRef(path)).toMatch(/^data:image\/jpeg;base64,/);
  });

  test("throws on missing file", () => {
    expect(() => resolveImagineImageRef("/tmp/no-such-image-xyz.jpg")).toThrow(/not readable/);
  });
});
