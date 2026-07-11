/**
 * Normalize image parts for xAI Responses payloads.
 * Resolves local .png/.jpg paths to data:image/...;base64,... URIs and rewrites
 * OpenAI image shapes to xAI `input_image`.
 *
 * Inspired by kenryu42/pi-grok-cli and BlockedPath/pi-xai-oauth (MIT).
 */

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { extname, isAbsolute, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

function stripShellQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function unescapeShellPath(value: string): string {
  return stripShellQuotes(value).replace(/\\([\\\s'"()&;@])/g, "$1");
}

function imageMimeTypeForPath(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    default:
      throw new Error("xAI image understanding supports local .jpg, .jpeg, and .png files only");
  }
}

function ensurePathWithinWorkspace(cwd: string, filePath: string): string {
  const realCwd = realpathSync(cwd);
  const realPath = realpathSync(filePath);
  if (realPath !== realCwd && !realPath.startsWith(`${realCwd}${sep}`)) {
    throw new Error("Image path is outside the workspace");
  }
  return realPath;
}

function resolveLocalImagePath(value: string, cwd: string): string | undefined {
  const cleaned = unescapeShellPath(value);
  if (!cleaned) return undefined;

  if (cleaned.startsWith("file://")) {
    try {
      const filePath = fileURLToPath(cleaned);
      return existsSync(filePath) ? ensurePathWithinWorkspace(cwd, filePath) : undefined;
    } catch {
      return undefined;
    }
  }

  const candidate = isAbsolute(cleaned) ? cleaned : resolve(cwd, cleaned);
  return existsSync(candidate) ? ensurePathWithinWorkspace(cwd, candidate) : undefined;
}

/** Normalize a single image_url value (http, data URI, or local path) to a URL string. */
export function normalizeImageInput(value: unknown, cwd: string): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const cleaned = stripShellQuotes(value);

  if (/^https?:\/\//i.test(cleaned) || /^data:image\//i.test(cleaned)) {
    return cleaned;
  }

  const localPath = resolveLocalImagePath(cleaned, cwd);
  if (!localPath) {
    throw new Error(`Image file does not exist or is not a valid URL: ${cleaned}`);
  }

  const mimeType = imageMimeTypeForPath(localPath);
  const data = readFileSync(localPath).toString("base64");
  return `data:${mimeType};base64,${data}`;
}

function isInputImagePart(value: unknown): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === "object" &&
    (value as Record<string, unknown>).type === "input_image"
  );
}

function getImageUrlAndDetail(obj: Record<string, unknown>): {
  imageUrl: unknown;
  detail: unknown;
} {
  if (typeof obj.image_url === "object" && obj.image_url) {
    const imageUrl = obj.image_url as Record<string, unknown>;
    return { imageUrl: imageUrl.url, detail: imageUrl.detail };
  }
  return { imageUrl: obj.image_url, detail: obj.detail };
}

/** Recursively normalize image parts in a payload tree. */
export function normalizeImageParts(value: unknown, cwd: string): unknown {
  if (Array.isArray(value)) return value.map((item) => normalizeImageParts(item, cwd));
  if (!value || typeof value !== "object") return value;

  const obj = { ...(value as Record<string, unknown>) };

  if (obj.type === "image" && typeof obj.data === "string" && typeof obj.mimeType === "string") {
    return {
      type: "input_image",
      image_url: `data:${obj.mimeType};base64,${obj.data}`,
      detail: typeof obj.detail === "string" && obj.detail ? obj.detail : "auto",
    };
  }

  if (obj.type === "image_url") {
    const { imageUrl, detail } = getImageUrlAndDetail(obj);
    obj.type = "input_image";
    obj.image_url = imageUrl;
    if (typeof detail === "string" && detail) obj.detail = detail;
  }

  if (obj.type === "input_image") {
    const { imageUrl, detail } = getImageUrlAndDetail(obj);
    const normalized = normalizeImageInput(imageUrl, cwd);
    if (normalized) obj.image_url = normalized;
    if (typeof detail === "string" && detail) obj.detail = detail;
    if (typeof obj.detail !== "string" || !obj.detail) obj.detail = "auto";
  }

  if (Array.isArray(obj.content)) obj.content = normalizeImageParts(obj.content, cwd) as unknown[];
  if (Array.isArray(obj.output)) obj.output = normalizeImageParts(obj.output, cwd) as unknown[];
  return obj;
}

/**
 * Rewrite function_call_output arrays: text-only output, re-attach images as a
 * following user message (xAI rejects image arrays in function_call_output).
 */
export function rewriteFunctionCallOutputImages(
  input: Record<string, unknown>[],
  supportsImages: boolean,
): Record<string, unknown>[] {
  const rewritten: Record<string, unknown>[] = [];

  for (const item of input) {
    if (
      !item ||
      typeof item !== "object" ||
      item.type !== "function_call_output" ||
      !Array.isArray(item.output)
    ) {
      rewritten.push(item);
      continue;
    }

    const outputParts = item.output as unknown[];
    const imageParts = outputParts.filter(isInputImagePart);
    const textParts = outputParts.filter((p) => !isInputImagePart(p));

    const textChunks: string[] = [];
    for (const part of textParts) {
      if (typeof part === "string") {
        textChunks.push(part);
      } else if (part && typeof part === "object") {
        const p = part as Record<string, unknown>;
        if (typeof p.text === "string") textChunks.push(p.text);
        else if (p.type === "input_image") {
          /* already filtered */
        } else textChunks.push(JSON.stringify(p));
      }
    }

    const imageCount = imageParts.length;
    const outputText =
      textChunks.join("\n") ||
      (imageCount > 0
        ? `[${imageCount} image${imageCount === 1 ? "" : "s"} attached]`
        : "(tool returned no text output)");
    rewritten.push({ ...item, output: outputText });

    if (supportsImages && imageCount > 0) {
      const callId = item.call_id ? ` (${String(item.call_id)})` : "";
      const label = `The previous tool result${callId} included ${imageCount} image${imageCount === 1 ? "" : "s"}. Use the attached image${imageCount === 1 ? "" : "s"} as the visual output from that tool.`;
      rewritten.push({
        role: "user",
        content: [{ type: "input_text", text: label }, ...imageParts],
      });
    }
  }

  return rewritten;
}
