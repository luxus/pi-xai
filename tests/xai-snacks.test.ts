import { describe, expect, test } from "vitest";
import { imagineInstruction, imagineUsageMessage } from "../xai-image-gen.ts";
import {
  clampVideoDuration,
  imagineVideoInstruction,
  imagineVideoUsageMessage,
} from "../xai-video-gen.ts";
import {
  htmlToRoughMarkdown,
  isPrivateIp,
  ssrfBlockReason,
  truncateText,
  upgradeToHttps,
} from "../xai-web-fetch.ts";

describe("/imagine slash", () => {
  test("usage and verbatim instruction", () => {
    expect(imagineUsageMessage()).toContain("/imagine");
    const text = imagineInstruction("a red cube");
    expect(text).toContain("image_gen");
    expect(text).toContain("verbatim");
    expect(text).toContain("a red cube");
  });
});

describe("video gen helpers", () => {
  test("duration clamp 6|10", () => {
    expect(clampVideoDuration(6)).toBe(6);
    expect(clampVideoDuration(10)).toBe(10);
    expect(clampVideoDuration(7)).toBe(6);
    expect(clampVideoDuration("10")).toBe(10);
    expect(clampVideoDuration(undefined)).toBe(6);
  });
  test("imagine-video instruction", () => {
    expect(imagineVideoUsageMessage()).toContain("/imagine-video");
    const t = imagineVideoInstruction("cat on piano");
    expect(t).toContain("image_gen");
    expect(t).toContain("image_to_video");
    expect(t).toContain("cat on piano");
  });
});

describe("web_fetch helpers", () => {
  test("https upgrade", () => {
    expect(upgradeToHttps("http://example.com/a")).toBe("https://example.com/a");
    expect(upgradeToHttps("https://example.com")).toBe("https://example.com");
  });
  test("ssrf blocks", () => {
    expect(ssrfBlockReason("http://127.0.0.1/")).toBeTruthy();
    expect(ssrfBlockReason("https://localhost/x")).toBeTruthy();
    expect(ssrfBlockReason("https://169.254.169.254/latest")).toBeTruthy();
    expect(ssrfBlockReason("https://10.0.0.5/")).toBeTruthy();
    expect(ssrfBlockReason("https://example.com/ok")).toBeNull();
  });
  test("private ip", () => {
    expect(isPrivateIp("192.168.1.1")).toBe(true);
    expect(isPrivateIp("8.8.8.8")).toBe(false);
  });
  test("html strip + truncate", () => {
    const md = htmlToRoughMarkdown(
      "<html><script>x</script><h1>Hi</h1><p>Body <a href='https://e.com'>e</a></p></html>",
    );
    expect(md).toContain("Hi");
    expect(md).toContain("[e](https://e.com)");
    expect(md).not.toContain("script");
    expect(truncateText("abcd", 3)).toContain("truncated");
  });
});
