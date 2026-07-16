/**
 * Client-side web_fetch (Grok Build–style) for pi-xai.
 * URL → text/markdown with basic SSRF guards. No new dependencies.
 */

import { isIP } from "node:net";
import { Type } from "typebox";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const MAX_BYTES = 1_500_000;
const MAX_CHARS = 80_000;
const TIMEOUT_MS = 20_000;

export function upgradeToHttps(url: string): string {
  const u = url.trim();
  if (/^http:\/\//i.test(u)) return `https://${u.slice(7)}`;
  return u;
}

/** Returns error message if blocked, else null. */
export function ssrfBlockReason(urlStr: string): string | null {
  let u: URL;
  try {
    u = new URL(urlStr);
  } catch {
    return "Invalid URL";
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") {
    return `Unsupported protocol: ${u.protocol}`;
  }
  const host = u.hostname.toLowerCase();
  if (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "0.0.0.0" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local")
  ) {
    return "Blocked host (localhost)";
  }
  if (
    host === "metadata.google.internal" ||
    host === "metadata" ||
    host.startsWith("169.254.") ||
    host === "metadata.aws.internal"
  ) {
    return "Blocked metadata host";
  }
  // Literal IP
  const ipVersion = isIP(host);
  if (ipVersion) {
    if (isPrivateIp(host)) return `Blocked private IP: ${host}`;
  }
  return null;
}

export function isPrivateIp(ip: string): boolean {
  if (ip.includes(":")) {
    // v6: unique local, link-local, loopback
    const h = ip.toLowerCase();
    return (
      h === "::1" ||
      h.startsWith("fc") ||
      h.startsWith("fd") ||
      h.startsWith("fe80") ||
      h.startsWith("::ffff:127.") ||
      h.startsWith("::ffff:10.") ||
      h.startsWith("::ffff:192.168.") ||
      h.startsWith("::ffff:169.254.")
    );
  }
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return true;
  const [a, b] = parts as [number, number, number, number];
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  return false;
}

export function htmlToRoughMarkdown(html: string): string {
  let s = html;
  s = s.replace(/<script[\s\S]*?<\/script>/gi, " ");
  s = s.replace(/<style[\s\S]*?<\/style>/gi, " ");
  s = s.replace(/<!--[\s\S]*?-->/g, " ");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<\/(p|div|h[1-6]|li|tr|section|article)>/gi, "\n\n");
  s = s.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, level, body) => {
    const n = Number(level) || 1;
    return `\n${"#".repeat(n)} ${stripTags(body).trim()}\n\n`;
  });
  s = s.replace(/<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href, body) => {
    const t = stripTags(body).trim() || href;
    return `[${t}](${href})`;
  });
  s = s.replace(/<li[^>]*>/gi, "- ");
  s = stripTags(s);
  s = s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
  s = s
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return s;
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, "");
}

export function truncateText(s: string, max = MAX_CHARS): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + "\n\n…[truncated]";
}

export async function webFetch(urlInput: string): Promise<{
  url: string;
  finalUrl: string;
  contentType: string;
  text: string;
}> {
  let url = upgradeToHttps(urlInput);
  const blocked = ssrfBlockReason(url);
  if (blocked) throw new Error(blocked);

  const res = await fetch(url, {
    method: "GET",
    redirect: "follow",
    headers: {
      Accept: "text/markdown, text/plain, text/html;q=0.9, */*;q=0.1",
      "User-Agent": "pi-xai-web-fetch/1.0",
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  const finalUrl = res.url || url;
  const finalBlock = ssrfBlockReason(finalUrl);
  if (finalBlock) throw new Error(`Redirect blocked: ${finalBlock}`);

  if (!res.ok) throw new Error(`HTTP ${res.status} for ${finalUrl}`);

  const contentType = (res.headers.get("content-type") || "").toLowerCase();
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.byteLength > MAX_BYTES) {
    throw new Error(`Response too large (${buf.byteLength} bytes; max ${MAX_BYTES})`);
  }
  let text = new TextDecoder("utf-8", { fatal: false }).decode(buf);
  if (contentType.includes("html")) text = htmlToRoughMarkdown(text);
  text = truncateText(text);

  return { url, finalUrl, contentType, text };
}

export function registerXaiWebFetch(api: ExtensionAPI): void {
  api.registerTool(
    defineTool({
      name: "web_fetch",
      label: "web_fetch",
      description:
        "Fetch a URL and return content as text/markdown. Fails for private/auth-only URLs. Prefer for public docs/pages; use specialized tools for private GitHub/Jira/etc.",
      parameters: Type.Object({
        url: Type.String({ description: "The URL to fetch (http upgraded to https)." }),
      }),
      async execute(_id, params) {
        const url = String((params as { url?: string }).url || "");
        const result = await webFetch(url);
        return {
          content: [
            {
              type: "text",
              text: `Fetched ${result.finalUrl}\nContent-Type: ${result.contentType}\n\n${result.text}`,
            },
          ],
          details: {
            url: result.url,
            finalUrl: result.finalUrl,
            contentType: result.contentType,
            chars: result.text.length,
          },
        };
      },
    }),
  );
}
