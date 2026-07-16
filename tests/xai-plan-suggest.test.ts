import { describe, expect, test } from "vitest";
import { isSafePlanBash } from "../xai-plan-mode.ts";
import {
  asGhostText,
  buildTranscript,
  filterSuggestion,
  stripAnsi,
} from "../xai-prompt-suggest.ts";

describe("plan mode bash allowlist", () => {
  test("allows read-only", () => {
    expect(isSafePlanBash("ls -la")).toBe(true);
    expect(isSafePlanBash("git status")).toBe(true);
    expect(isSafePlanBash("cat README.md | head")).toBe(true);
  });
  test("blocks destructive", () => {
    expect(isSafePlanBash("rm -rf /")).toBe(false);
    expect(isSafePlanBash("echo hi > file")).toBe(false);
    expect(isSafePlanBash("git commit -am x")).toBe(false);
  });
});

describe("prompt suggestion filter + ghost textbox", () => {
  test("filterSuggestion", () => {
    expect(filterSuggestion("NONE")).toBeUndefined();
    expect(filterSuggestion("run the tests")).toBe("run the tests");
    expect(filterSuggestion("yes")).toBe("yes");
    expect(filterSuggestion("xyzzy")).toBeUndefined();
    expect(filterSuggestion("Let me fix that")).toBeUndefined();
    expect(filterSuggestion('"commit this"')).toBe("commit this");
  });

  test("dim ghost wraps and strips", () => {
    const g = asGhostText("run the tests");
    expect(g).toContain("run the tests");
    expect(g).not.toBe("run the tests");
    expect(stripAnsi(g)).toBe("run the tests");
  });

  test("buildTranscript needs assistant", () => {
    expect(
      buildTranscript([
        { role: "user", content: "hi" },
        { role: "assistant", content: [{ type: "text", text: "done fixing" }] },
      ]),
    ).toContain("Agent: done fixing");
    expect(buildTranscript([{ role: "user", content: "only user" }])).toBeUndefined();
  });
});
