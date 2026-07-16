import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PROMPT_SUGGEST_ACCEPT_ID, resolveKeybindingKey } from "../xai-config.ts";

describe("resolveKeybindingKey", () => {
  it("reads string and first array entry; falls back", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-xai-kb-"));
    const path = join(dir, "keybindings.json");

    writeFileSync(path, JSON.stringify({ [PROMPT_SUGGEST_ACCEPT_ID]: "Ctrl+Right" }));
    expect(resolveKeybindingKey(PROMPT_SUGGEST_ACCEPT_ID, "tab", path)).toBe("ctrl+right");

    writeFileSync(path, JSON.stringify({ [PROMPT_SUGGEST_ACCEPT_ID]: ["alt+enter", "f6"] }));
    expect(resolveKeybindingKey(PROMPT_SUGGEST_ACCEPT_ID, "tab", path)).toBe("alt+enter");

    writeFileSync(path, "{}");
    expect(resolveKeybindingKey(PROMPT_SUGGEST_ACCEPT_ID, "tab", path)).toBe("tab");
  });
});
