/**
 * Grok Build image_to_video for pi-xai (lean).
 * Protocol mirrors pi-xai-imagine / xai-org/grok-build video generations.
 * Opt out: xai.text.videoGen: false · auto-off when pi-xai-imagine is installed.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isVideoGenEnabled, resolveXaiConfig } from "./xai-config.ts";
import { resolveImagineImageRef } from "./xai-image-gen.ts";
import { getEffectiveXaiApiKey } from "./xai-oauth.ts";
import { GROK_CLI_VERSION, grokCliModelHeaders, isGrokCliProxyBaseUrl } from "./xai-stream.ts";

export const XAI_VIDEO_MODEL = "grok-imagine-video";
export const IMAGE_TO_VIDEO_TOOL = "image_to_video";

export function clampVideoDuration(raw: unknown): 6 | 10 {
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  if (n === 10) return 10;
  return 6;
}

export function imagineVideoUsageMessage(): string {
  return "Usage: /imagine-video <description>\nProvide a text description to generate a video (image first, then animate).";
}

export function imagineVideoInstruction(prompt: string): string {
  return (
    `# Imagine Video\n\n` +
    `Video starts from an image — there is no text-to-video-only path here.\n` +
    `Default to a **single clip**:\n` +
    `1. Create a source image with image_gen that stages the first frame.\n` +
    `2. Call image_to_video with that image path and a short motion prompt (1–2 sentences).\n` +
    `3. Duration 6 or 10 seconds (prefer 6). Mention the saved path after.\n\n` +
    `User prompt: ${prompt}`
  );
}

function headers(apiKey: string, baseUrl: string): Record<string, string> {
  const h: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
  if (isGrokCliProxyBaseUrl(baseUrl)) Object.assign(h, grokCliModelHeaders("image"));
  else h["User-Agent"] = `pi-xai/${GROK_CLI_VERSION}`;
  return h;
}

async function credentials(): Promise<{ apiKey: string; baseUrl: string }> {
  const effective = await getEffectiveXaiApiKey();
  if (!effective?.apiKey) {
    throw new Error("Missing xAI credentials. Run `/login grok-build` or set XAI_API_KEY.");
  }
  // Media often needs public API even when chat uses CLI proxy.
  const cfg = resolveXaiConfig().xai.baseUrl;
  const baseUrl = isGrokCliProxyBaseUrl(cfg) ? "https://api.x.ai/v1" : cfg;
  return { apiKey: effective.apiKey, baseUrl };
}

async function pollVideo(
  baseUrl: string,
  apiKey: string,
  requestId: string,
  timeoutMs = 300_000,
  intervalMs = 2_500,
): Promise<{ url: string; model?: string; duration?: number }> {
  const deadline = Date.now() + timeoutMs;
  const root = baseUrl.replace(/\/+$/, "");
  while (Date.now() < deadline) {
    const res = await fetch(`${root}/videos/${requestId}`, {
      headers: headers(apiKey, baseUrl),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      throw new Error(`Video status HTTP ${res.status}: ${t.slice(0, 300)}`);
    }
    const json = (await res.json()) as {
      status?: string;
      error?: string;
      model?: string;
      video?: { url?: string; duration?: number };
    };
    if (json.status === "done") {
      const url = json.video?.url?.trim();
      if (!url) throw new Error("Video done but no URL");
      return { url, model: json.model, duration: json.video?.duration };
    }
    if (json.status === "failed") throw new Error(json.error || "Video generation failed");
    if (json.status === "expired") throw new Error("Video request expired");
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error("Timed out waiting for video generation");
}

export async function imageToVideo(params: {
  image: string;
  prompt?: string;
  duration?: number | string;
  model?: string;
  cwd?: string;
}): Promise<{ path: string; requestId: string; model: string; duration?: number }> {
  const { apiKey, baseUrl } = await credentials();
  const imageUrl = resolveImagineImageRef(params.image, params.cwd || process.cwd());
  const duration = clampVideoDuration(params.duration);
  const model = params.model?.trim() || XAI_VIDEO_MODEL;
  const body: Record<string, unknown> = {
    model,
    duration,
    image: { url: imageUrl },
  };
  const prompt = params.prompt?.trim();
  if (prompt) body.prompt = prompt;

  const start = await fetch(`${baseUrl.replace(/\/+$/, "")}/videos/generations`, {
    method: "POST",
    headers: headers(apiKey, baseUrl),
    body: JSON.stringify(body),
  });
  if (!start.ok) {
    const t = await start.text().catch(() => "");
    throw new Error(`Video start HTTP ${start.status}: ${t.slice(0, 400)}`);
  }
  const started = (await start.json()) as { request_id?: string };
  const requestId = started.request_id?.trim();
  if (!requestId) throw new Error("No request_id from video API");

  const done = await pollVideo(baseUrl, apiKey, requestId);
  const bin = await fetch(done.url);
  if (!bin.ok) throw new Error(`Download failed HTTP ${bin.status}`);
  const dir = join(tmpdir(), "pi-xai", "videos");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${requestId}.mp4`);
  writeFileSync(path, Buffer.from(await bin.arrayBuffer()));
  return { path, requestId, model: done.model || model, duration: done.duration ?? duration };
}

export function registerXaiVideoGen(api: ExtensionAPI): void {
  if (!isVideoGenEnabled()) return;

  api.registerCommand("imagine-video", {
    description: "Generate a video (image_gen → image_to_video workflow)",
    async handler(args, ctx) {
      const prompt = (args ?? "").trim();
      if (!prompt) {
        ctx.ui.notify(imagineVideoUsageMessage(), "info");
        return;
      }
      const instruction = imagineVideoInstruction(prompt);
      const send = (ctx as { sendUserMessage?: (c: string) => Promise<void> }).sendUserMessage;
      if (typeof send === "function") await send.call(ctx, instruction);
      else ctx.ui.notify(instruction.slice(0, 200), "info");
    },
  });

  api.registerTool(
    defineTool({
      name: IMAGE_TO_VIDEO_TOOL,
      label: "image_to_video",
      description:
        "Generate a video from a single source image; returns the saved video path. Provide image (path/url/data URI) and optionally a prompt for motion. duration is 6 or 10 seconds (default 6).",
      parameters: Type.Object({
        image: Type.String({
          description: "Source image: filesystem path, https URL, or data:image URI.",
        }),
        prompt: Type.Optional(
          Type.String({
            description: "Optional motion/camera guidance (1–2 sentences, present tense).",
          }),
        ),
        duration: Type.Optional(Type.Number({ description: "6 or 10 seconds. Default 6." })),
        model: Type.Optional(Type.String({ description: `Default ${XAI_VIDEO_MODEL}.` })),
      }),
      async execute(_id, params, _signal, _onUpdate, ctx) {
        const p = params as {
          image: string;
          prompt?: string;
          duration?: number;
          model?: string;
        };
        const result = await imageToVideo({
          ...p,
          cwd: (ctx as { cwd?: string })?.cwd || process.cwd(),
        });
        return {
          content: [
            {
              type: "text",
              text: `Saved video: ${result.path}\nrequest: ${result.requestId}\nmodel: ${result.model}`,
            },
          ],
          details: result,
        };
      },
    }),
  );
}
