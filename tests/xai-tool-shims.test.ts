import { describe, expect, test } from "vitest";
import {
  nextActiveToolsWithShims,
  prepareEditArgs,
  prepareGlobArgs,
  prepareGrepArgs,
  prepareWriteArgs,
} from "../xai-tool-shims.ts";

describe("prepareGrepArgs", () => {
  test("maps Cursor-ish filters to pi grep fields", () => {
    expect(
      prepareGrepArgs({
        pattern: "foo",
        include: "*.ts",
        head_limit: 10,
        "-i": true,
      }),
    ).toMatchObject({
      pattern: "foo",
      glob: "*.ts",
      limit: 10,
      ignoreCase: true,
    });
  });

  test("prefers glob over include", () => {
    expect(prepareGrepArgs({ pattern: "x", glob: "*.md", include: "*.ts" }).glob).toBe("*.md");
  });
});

describe("prepareGlobArgs", () => {
  test("maps glob_pattern → pattern", () => {
    expect(prepareGlobArgs({ glob_pattern: "**/*.ts", path: "src" })).toMatchObject({
      pattern: "**/*.ts",
      path: "src",
    });
  });
});

describe("prepareWriteArgs", () => {
  test("maps contents and file_path", () => {
    expect(prepareWriteArgs({ file_path: "/tmp/a.txt", contents: "hi" })).toEqual({
      file_path: "/tmp/a.txt",
      contents: "hi",
      path: "/tmp/a.txt",
      content: "hi",
    });
  });
});

describe("prepareEditArgs", () => {
  test("strips replace_all and maps old_string", () => {
    const out = prepareEditArgs({
      path: "a.ts",
      edits: [{ old_string: "a", new_string: "b", replace_all: true }],
    }) as { edits: Array<Record<string, unknown>> };

    expect(out.edits[0]).toEqual({ oldText: "a", newText: "b" });
    expect(out.edits[0]).not.toHaveProperty("replace_all");
    expect(out.edits[0]).not.toHaveProperty("old_string");
  });

  test("maps file_path and top-level old_str", () => {
    const out = prepareEditArgs({
      file_path: "b.ts",
      old_str: "x",
      new_str: "y",
    }) as Record<string, unknown>;
    expect(out.path).toBe("b.ts");
    expect(out.oldText).toBe("x");
    expect(out.newText).toBe("y");
  });
});

describe("nextActiveToolsWithShims", () => {
  test("adds Grep/Glob/grep/find for grok-build", () => {
    expect(
      nextActiveToolsWithShims(["read", "bash", "edit", "write"], "grok-build").sort(),
    ).toEqual(["Glob", "Grep", "bash", "edit", "find", "grep", "read", "write"].sort());
  });

  test("removes only capital shims for other providers", () => {
    expect(nextActiveToolsWithShims(["read", "bash", "Grep", "Glob", "grep"], "anthropic")).toEqual(
      ["read", "bash", "grep"],
    );
  });

  test("optional WebSearch: activates and suppresses client web_search on grok-build", () => {
    const next = nextActiveToolsWithShims(["read", "bash", "web_search"], "grok-build", {
      clientWebSearch: true,
    });
    expect(next).toContain("WebSearch");
    expect(next).not.toContain("web_search");
    expect(next).toContain("Grep");
  });

  test("optional WebSearch: no WebSearch when client mode off (default native)", () => {
    const next = nextActiveToolsWithShims(["read", "web_search"], "grok-build", {
      clientWebSearch: false,
    });
    expect(next).not.toContain("WebSearch");
    expect(next).toContain("web_search");
  });

  test("optional WebSearch: strips WebSearch for other providers (restores multi-model web_search)", () => {
    expect(
      nextActiveToolsWithShims(["read", "WebSearch", "web_search"], "anthropic", {
        clientWebSearch: true,
      }),
    ).toEqual(["read", "web_search"]);
  });
});
