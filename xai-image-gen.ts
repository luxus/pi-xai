/**
 * Isolated Imagine image_gen / image_edit for pi-xai (no video/studio).
 * Protocol: xai-org/grok-build image_gen / image_edit.
 * Opt out: `xai.text.imageGen: false`.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isImageGenEnabled, resolveXaiConfig } from "./xai-config.ts";
import { getEffectiveXaiApiKey } from "./xai-oauth.ts";
import { GROK_CLI_VERSION, grokCliModelHeaders, isGrokCliProxyBaseUrl } from "./xai-stream.ts";

export const XAI_IMAGINE_MODEL = "grok-imagine-image-quality";

function requestHeaders(apiKey: string, baseUrl: string): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
  if (isGrokCliProxyBaseUrl(baseUrl)) {
    Object.assign(headers, grokCliModelHeaders("image"));
  } else {
    headers["User-Agent"] = `pi-xai/${GROK_CLI_VERSION}`;
  }
  return headers;
}

async function postImagine(
  baseUrl: string,
  apiKey: string,
  path: string,
  body: Record<string, unknown>,
): Promise<{ data?: Array<{ b64_json?: string }> }> {
  const res = await fetch(`${baseUrl.replace(/\/+$/, "")}${path}`, {
    method: "POST",
    headers: requestHeaders(apiKey, baseUrl),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Imagine API HTTP ${res.status}: ${text.slice(0, 400)}`);
  }
  return (await res.json()) as { data?: Array<{ b64_json?: string }> };
}

function saveB64(b64: string, prefix: string): string {
  const dir = join(tmpdir(), "pi-xai", "images");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${prefix}-${Date.now()}.jpg`);
  writeFileSync(path, Buffer.from(b64, "base64"));
  return path;
}

async function credentials(): Promise<{ apiKey: string; baseUrl: string }> {
  const effective = await getEffectiveXaiApiKey();
  if (!effective?.apiKey) {
    throw new Error("Missing xAI credentials. Run `/login grok-build` or set XAI_API_KEY.");
  }
  return { apiKey: effective.apiKey, baseUrl: resolveXaiConfig().xai.baseUrl };
}

/** Official image_gen: generations with quality model + b64_json. */
export async function generateImage(
  apiKey: string,
  baseUrl: string,
  params: { prompt: string; aspect_ratio?: string; model?: string },
): Promise<{ path: string; model: string }> {
  const prompt = params.prompt?.trim();
  if (!prompt) throw new Error("prompt is required");
  const model = params.model?.trim() || XAI_IMAGINE_MODEL;
  const json = await postImagine(baseUrl, apiKey, "/images/generations", {
    model,
    prompt,
    n: 1,
    aspect_ratio: params.aspect_ratio?.trim() || "auto",
    resolution: "1k",
    response_format: "b64_json",
  });
  const b64 = json.data?.[0]?.b64_json;
  if (!b64) throw new Error("Image generation returned no b64_json data");
  return { path: saveB64(b64, "gen"), model };
}

/**
 * Resolve one image_edit reference to an API-safe URL (https or data URI).
 * Mirrors xai-org/grok-build image_edit: local paths and file:// are read and
 * sent as data:image/...;base64,... — the Imagine API rejects bare filesystem paths.
 */
export function resolveImagineImageRef(value: string, cwd = process.cwd()): string {
  const cleaned = value.trim().replace(/^['"]|['"]$/g, "");
  if (!cleaned) throw new Error("empty image reference");
  if (/^https?:\/\//i.test(cleaned) || /^data:image\//i.test(cleaned)) return cleaned;

  let filePath = cleaned;
  if (cleaned.startsWith("file://")) {
    try {
      filePath = fileURLToPath(cleaned);
    } catch {
      throw new Error(`invalid file:// image reference: ${cleaned}`);
    }
  } else if (!isAbsolute(filePath)) {
    filePath = resolve(cwd, filePath);
  }

  if (!existsSync(filePath)) {
    throw new Error(`image reference not readable: ${cleaned}`);
  }

  const ext = extname(filePath).toLowerCase();
  const mime =
    ext === ".png"
      ? "image/png"
      : ext === ".webp"
        ? "image/webp"
        : ext === ".gif"
          ? "image/gif"
          : ext === ".jpg" || ext === ".jpeg"
            ? "image/jpeg"
            : undefined;
  if (!mime) {
    throw new Error(`unsupported image type for image_edit: ${ext || "(none)"}`);
  }

  const b64 = readFileSync(filePath).toString("base64");
  if (!b64) throw new Error(`image reference contained no data: ${cleaned}`);
  return `data:${mime};base64,${b64}`;
}

/** Official image_edit; aspect only for multi-ref. */
export async function editImage(
  apiKey: string,
  baseUrl: string,
  params: { prompt: string; image: string | string[]; aspect_ratio?: string; model?: string },
  cwd = process.cwd(),
): Promise<{ path: string; model: string }> {
  const prompt = params.prompt?.trim();
  if (!prompt) throw new Error("prompt is required");
  const refs = (Array.isArray(params.image) ? params.image : [params.image])
    .map((s) => s?.trim())
    .filter(Boolean) as string[];
  if (!refs.length) throw new Error("image_edit requires at least one reference image");

  // Always convert paths → data URIs before the API call (grok-build parity).
  const urls = refs.map((r) => resolveImagineImageRef(r, cwd));

  const model = params.model?.trim() || XAI_IMAGINE_MODEL;
  const body: Record<string, unknown> = {
    model,
    prompt,
    n: 1,
    resolution: "1k",
    response_format: "b64_json",
  };
  if (urls.length === 1) {
    body.image = { url: urls[0] };
  } else {
    body.images = urls.map((url) => ({ url }));
    body.aspect_ratio = params.aspect_ratio?.trim() || "auto";
  }

  const json = await postImagine(baseUrl, apiKey, "/images/edits", body);
  const b64 = json.data?.[0]?.b64_json;
  if (!b64) throw new Error("Image edit returned no b64_json data");
  return { path: saveB64(b64, "edit"), model };
}

export function registerXaiImageGen(api: ExtensionAPI): void {
  if (!isImageGenEnabled()) return;

  api.registerTool(
    defineTool({
      name: "image_gen",
      label: "image_gen",
      description:
        "Generate a new image from a text description using xAI Imagine; returns the saved image path. For one image, call once. Call multiple times only when the user explicitly requests multiple images.",
      parameters: Type.Object({
        prompt: Type.String({ description: "Text description of the image to generate." }),
        aspect_ratio: Type.Optional(
          Type.String({
            description: "Aspect ratio. Defaults to auto. Examples: 1:1, 16:9, 9:16.",
          }),
        ),
        model: Type.Optional(
          Type.String({
            description: `Model override. Default ${XAI_IMAGINE_MODEL}. Fast SKU: grok-imagine-image.`,
          }),
        ),
      }),
      async execute(_id, params) {
        const { apiKey, baseUrl } = await credentials();
        const p = params as { prompt: string; aspect_ratio?: string; model?: string };
        const result = await generateImage(apiKey, baseUrl, p);
        return {
          content: [{ type: "text", text: `Saved image: ${result.path}\nmodel: ${result.model}` }],
          details: result,
        };
      },
    }),
  );

  api.registerTool(
    defineTool({
      name: "image_edit",
      label: "image_edit",
      description:
        "Edit one or more existing images with xAI Imagine. Pass absolute/relative filesystem paths, https URLs, or data:image/...;base64,... URIs — local paths are converted to data URIs before the API call (same as grok-build). Prefer this over image_gen when the user provides reference photos.",
      parameters: Type.Object({
        prompt: Type.String({ description: "Describe changes to make." }),
        image: Type.Union([Type.String(), Type.Array(Type.String())], {
          description:
            "Reference image(s): filesystem path (preferred when you have a local file), https URL, or data:image/...;base64,... URI. Paths under /tmp and the project work.",
        }),
        aspect_ratio: Type.Optional(
          Type.String({
            description: "Output aspect for multi-image edits only. Defaults to auto.",
          }),
        ),
        model: Type.Optional(Type.String({ description: `Default ${XAI_IMAGINE_MODEL}.` })),
      }),
      async execute(_id, params) {
        const { apiKey, baseUrl } = await credentials();
        const p = params as {
          prompt: string;
          image: string | string[];
          aspect_ratio?: string;
          model?: string;
        };
        const result = await editImage(apiKey, baseUrl, p);
        return {
          content: [
            { type: "text", text: `Saved edited image: ${result.path}\nmodel: ${result.model}` },
          ],
          details: result,
        };
      },
    }),
  );
}
