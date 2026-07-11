import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  resolveXaiConfig,
  getAgenticConfig,
  isMultiAgentToolEnabled,
  grokSupportsReasoningEffort,
  grokWantsEncryptedReasoningInclude,
  getPiSettingsPaths,
  type ResolvedXaiConfig,
} from "./xai-config.ts";
import { normalizeImageParts, rewriteFunctionCallOutputImages } from "./xai-images.ts";
import { registerXaiProvider } from "./xai-provider.ts";
import { registerGrokToolShims } from "./xai-tool-shims.ts";
import { isGrokCliProxyBaseUrl, xaiRequestHeaders } from "./xai-stream.ts";
import { registerXaiVision } from "./xai-vision.ts";
import {
  getEffectiveXaiApiKey,
  autoImportGrokCliIfNeeded,
  isXaiEntitlementError,
  isXaiStaleTokenError,
  fetchBillingUsage,
  formatGrokBuildBilling,
  GROK_USAGE_PAGE_URL,
} from "./xai-oauth.ts";

// Re-export credential helpers so sibling extensions (pi-xai-imagine, pi-xai-voice, etc.)
// can prefer Grok Build OAuth when the user has run `/login grok-build`.
export {
  getEffectiveXaiApiKey,
  autoImportGrokCliIfNeeded,
  isXaiEntitlementError,
  isXaiStaleTokenError,
  fetchBillingUsage,
  fetchGrokBuildBilling,
  formatQuota,
  formatGrokBuildBilling,
  GROK_USAGE_PAGE_URL,
  GROK_BUILD_BILLING_URL,
  type BillingUsage,
  type MonthlyUsage,
  type WeeklyUsage,
} from "./xai-oauth.ts";
export {
  resolveXaiConfig,
  getAgenticConfig,
  isMultiAgentToolEnabled,
  grokSupportsReasoningEffort,
  grokWantsEncryptedReasoningInclude,
  getPiSettingsPaths,
  XAI_API_BASE,
  XAI_CLI_BASE,
  type ResolvedXaiConfig,
} from "./xai-config.ts";
export {
  normalizeImageInput,
  normalizeImageParts,
  rewriteFunctionCallOutputImages,
} from "./xai-images.ts";
export {
  GROK_CLI_VERSION,
  grokCliModelHeaders,
  isGrokCliProxyBaseUrl,
  xaiRequestHeaders,
  streamGrokCli,
} from "./xai-stream.ts";

async function createRuntime(): Promise<{ apiKey: string; config: ResolvedXaiConfig }> {
  // Credential resolution now fully delegated to xai-oauth (grok-build OAuth priority,
  // auto-refresh via JWT exp, grok-cli import, env XAI_API_KEY, Pi auth).
  // xai-config only handles baseUrl + agentic settings (tiny).
  const effective = await getEffectiveXaiApiKey();
  if (!effective?.apiKey) {
    const paths = getPiSettingsPaths();
    throw new Error(
      `Missing xAI API key. Run \`/login grok-build\` (native OAuth, no binary required), set XAI_API_KEY, or configure xai.apiKey in ${paths.project} or ${paths.user}. Existing ~/.grok/auth.json is auto-detected if present.`,
    );
  }

  return { apiKey: effective.apiKey, config: resolveXaiConfig() };
}

const CITATION_GLUE_RE = /((?:https?:\/\/|www\.)[^\s<>\]]+)(\[\[\d+\]\]\([^)]+\))/g;

function glueCitationSpacing(text: string): string {
  return text.replace(CITATION_GLUE_RE, "$1 $2");
}

function citationsSummary(citations: string[] | undefined): string {
  if (!citations?.length) return "";
  const lines = citations.map((url, i) => `${i + 1}. ${url}`);
  return `\n\n**Sources consulted**\n${lines.join("\n")}`;
}

function formatResponseSummary(
  result: {
    model: string;
    output?: any[];
    usage?: any;
    citations?: string[];
    server_side_tool_usage?: Record<string, number>;
  },
  title: string,
): string {
  const items = result.output ?? [];
  const textParts: string[] = [];
  const toolCalls: string[] = [];

  for (const item of items) {
    if (item.type === "message" && Array.isArray(item.content)) {
      for (const c of item.content) {
        if (c.type === "output_text" && typeof c.text === "string") textParts.push(c.text);
      }
    } else if (item.type === "web_search_call") {
      // Show the query from action.query (search) or action.url (open_page/find_in_page)
      const action = item.action;
      const detail = action?.query
        ? ` "${action.query}"`
        : action?.url
          ? ` ${action.url}`
          : typeof item.name === "string"
            ? ` (${item.name})`
            : "";
      const status = item.status ? ` [${item.status}]` : "";
      toolCalls.push(`- Web search${detail}${status}`);
    } else if (item.type === "x_search_call") {
      const action = item.action;
      const detail = action?.query
        ? ` "${action.query}"`
        : typeof item.name === "string"
          ? ` (${item.name})`
          : "";
      const status = item.status ? ` [${item.status}]` : "";
      toolCalls.push(`- X search${detail}${status}`);
    } else if (item.type === "code_interpreter_call") {
      const lang = item.language ?? "python";
      const status = item.status ? ` [${item.status}]` : "";
      toolCalls.push(`- Code execution (${lang})${status}`);
    } else if (item.type === "function_call") {
      const name = typeof item.name === "string" ? item.name : "function_call";
      toolCalls.push(`- Tool call: ${name}`);
    }
  }

  const text = glueCitationSpacing(textParts.join("\n"));
  const toolCallText = toolCalls.join("\n");
  const usage = result.usage
    ? `Tokens: ${result.usage.input_tokens ?? "?"} in / ${result.usage.output_tokens ?? "?"} out`
    : "";
  const reasoning = result.usage?.output_tokens_details?.reasoning_tokens
    ? ` (reasoning: ${result.usage.output_tokens_details.reasoning_tokens})`
    : "";
  const tools = result.server_side_tool_usage
    ? `\nServer-side tools: ${Object.entries(result.server_side_tool_usage)
        .map(([k, v]) => {
          // Shorten SERVER_SIDE_TOOL_WEB_SEARCH → web_search (×N)
          const short = k.replace(/^SERVER_SIDE_TOOL_/, "").toLowerCase();
          return `${short}×${v}`;
        })
        .join(", ")}`
    : "";
  const body = [text, toolCallText].filter(Boolean).join("\n\n");
  return `**${title}** (${result.model})\n\n${body || "(no text output)"}\n\n${usage}${reasoning}${tools}${citationsSummary(result.citations)}`;
}

function textResult(text: string): {
  content: Array<{ type: "text"; text: string }>;
  details: string;
} {
  return { content: [{ type: "text" as const, text }], details: text };
}

/** Match Pi/openai-responses + xAI prompt cache key length limit. */
export const XAI_PROMPT_CACHE_KEY_MAX_LENGTH = 64;

/** Clamp a prompt_cache_key the same way Pi core does (max 64 code points). */
export function clampXaiPromptCacheKey(key: string | undefined | null): string | undefined {
  if (key == null) return undefined;
  const trimmed = String(key).trim();
  if (!trimmed) return undefined;
  const chars = Array.from(trimmed);
  if (chars.length <= XAI_PROMPT_CACHE_KEY_MAX_LENGTH) return trimmed;
  return chars.slice(0, XAI_PROMPT_CACHE_KEY_MAX_LENGTH).join("");
}

/**
 * Ensure Responses body has prompt_cache_key for server affinity / cache hits.
 * xAI recommends this on Responses; Chat Completions uses x-grok-conv-id instead.
 * Prefers an existing non-empty body key; otherwise uses the Pi session id.
 */
export function ensureXaiPromptCacheKey(
  body: Record<string, unknown>,
  sessionId?: string | null,
): void {
  const existing = body.prompt_cache_key;
  if (typeof existing === "string") {
    const clamped = clampXaiPromptCacheKey(existing);
    if (clamped) {
      body.prompt_cache_key = clamped;
      return;
    }
    delete body.prompt_cache_key;
  }
  const key = clampXaiPromptCacheKey(sessionId ?? undefined);
  if (key) body.prompt_cache_key = key;
}

async function callXaiResponses(
  apiKey: string,
  baseUrl: string,
  body: Record<string, unknown>,
  timeout?: number,
  sessionId?: string | null,
  cwd?: string,
): Promise<any> {
  const input = (body as any).input;
  if (Array.isArray(input)) {
    normalizeForXai(input);
    if (cwd) {
      const modelId = typeof body.model === "string" ? body.model : "";
      const supportsImages = !modelId.toLowerCase().includes("composer");
      let next = normalizeImageParts(input, cwd) as Record<string, unknown>[];
      next = rewriteFunctionCallOutputImages(next, supportsImages);
      (body as any).input = next;
    }
  }
  ensureXaiPromptCacheKey(body, sessionId);

  const modelId = typeof body.model === "string" ? body.model : "";
  const url = `${baseUrl.replace(/\/+$/, "")}/responses`;
  const init: RequestInit & { signal?: AbortSignal } = {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...xaiRequestHeaders(modelId, baseUrl, sessionId),
    },
    body: JSON.stringify(body),
  };
  if (timeout) init.signal = AbortSignal.timeout(timeout);

  const res = await fetch(url, init);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const err = new Error(`xAI API error: ${res.status} ${text.slice(0, 500)}`);
    if (
      res.status === 401 ||
      (res.status === 403 && isXaiStaleTokenError(text) && !isXaiEntitlementError(text))
    ) {
      (err as any).reloginRequired = true;
    }
    throw err;
  }
  return res.json();
}

const VALID_CONTENT_TYPES = new Set(["input_text", "output_text", "text", "input_image"]);

/** Fix empty/malformed role message content (xAI 400). Siblings: call on body.input before POST. */
export function normalizeForXai(input: unknown[]): unknown[] {
  if (!Array.isArray(input)) return input as any[];
  for (const item of input) {
    if (!item || typeof item !== "object" || !(item as any).role) continue;
    const c = (item as any).content;
    let needsFix =
      c === undefined || c === null || c === "" || (Array.isArray(c) && c.length === 0);
    if (!needsFix && Array.isArray(c)) {
      const hasValid = c.some(
        (p: any) =>
          p &&
          typeof p === "object" &&
          (typeof p.text === "string" || VALID_CONTENT_TYPES.has(p.type)),
      );
      if (!hasValid) needsFix = true;
    }
    if (!needsFix && typeof c === "string" && !String(c).trim()) needsFix = true;
    if (needsFix) {
      const partType =
        (item as any).type === "message" && (item as any).role === "assistant"
          ? "output_text"
          : "input_text";
      (item as any).content = [{ type: partType, text: "" }];
    }
  }
  return input;
}

function rewriteXaiProviderInput(
  payload: Record<string, unknown>,
  options?: { cwd?: string; modelId?: string },
): void {
  if (!Array.isArray(payload.input)) return;
  let input = payload.input as any[];
  normalizeForXai(input);

  const instructionParts: string[] = [];
  while (input.length > 0) {
    const first = input[0];
    if (
      !first ||
      typeof first !== "object" ||
      (first.role !== "developer" && first.role !== "system")
    )
      break;
    const txt =
      typeof first.content === "string"
        ? first.content.trim()
        : Array.isArray(first.content)
          ? first.content
              .map((p: any) => (typeof p === "string" ? p : p?.text || ""))
              .join(" ")
              .trim()
          : "";
    if (txt) instructionParts.push(txt);
    input.shift();
  }
  if (instructionParts.length > 0) {
    const prev = (payload as any).instructions;
    (payload as any).instructions = prev
      ? `${prev}\n\n${instructionParts.join("\n\n")}`
      : instructionParts.join("\n\n");
  }

  const cwd = options?.cwd || process.cwd();
  const modelId = (options?.modelId || String(payload.model || "")).toLowerCase();
  const supportsImages = !modelId.includes("composer");

  // Local path → data URI, image_url → input_image, then safe function_call_output rewrite.
  input = normalizeImageParts(input, cwd) as any[];
  input = rewriteFunctionCallOutputImages(input as Record<string, unknown>[], supportsImages);
  payload.input = input;
}

// ponytail: drops enums with '/', xAI 422; upgrade when xAI accepts slash enums
export function stripSlashEnums(tools: unknown[]): void {
  const walk = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    const rec = node as Record<string, unknown>;
    const en = rec.enum;
    if (Array.isArray(en) && en.some((v) => typeof v === "string" && v.includes("/"))) {
      delete rec.enum;
    }
    for (const v of Object.values(rec)) walk(v);
  };
  for (const tool of tools) walk(tool);
}

const XAI_BUILTIN_TOOL_TYPES = new Set([
  "web_search",
  "x_search",
  "code_interpreter",
  "collections_search",
]);

export function mergeXaiTools(existing: unknown[], builtins: unknown[]): unknown[] {
  const filtered = existing.filter((t) => {
    if (!t || typeof t !== "object") return true;
    const rec = t as { type?: string; name?: string };
    return !(rec.type === "function" && rec.name && XAI_BUILTIN_TOOL_TYPES.has(rec.name));
  });
  const seen = new Set<string>();
  return [...filtered, ...builtins].filter((t) => {
    if (!t || typeof t !== "object") return true;
    const key = (t as { name?: string; type?: string }).name ?? (t as { type?: string }).type;
    if (!key) return true;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// xAI public API: request reasoning.encrypted_content on reasoning models for multi-turn replay.
// Grok CLI proxy rejects that include — strip it when baseUrl is the proxy (pi-grok-cli parity).
function ensureXaiEncryptedReasoningInclude(
  payload: Record<string, unknown>,
  model: string | undefined,
  baseUrl?: string,
): void {
  if (isGrokCliProxyBaseUrl(baseUrl)) {
    if (Array.isArray((payload as any).include)) {
      (payload as any).include = (payload as any).include.filter(
        (item: unknown) => item !== "reasoning.encrypted_content",
      );
      if ((payload as any).include.length === 0) delete (payload as any).include;
    }
    return;
  }
  if (!grokWantsEncryptedReasoningInclude(model ?? "")) return;
  const want = "reasoning.encrypted_content";
  const inc = (payload as any).include;
  if (!Array.isArray(inc)) {
    (payload as any).include = [want];
    return;
  }
  if (!inc.includes(want)) (payload as any).include = [...inc, want];
}

export default async function (api: ExtensionAPI) {
  // Auto-import any existing Grok CLI credentials from ~/.grok/auth.json (if present)
  // into the "grok-build" slot. This is a convenience only — the primary way to
  // authenticate is the native `/login grok-build` OAuth flow (no binary needed).
  await autoImportGrokCliIfNeeded();

  // Register xAI (Grok Build) provider (subscription OAuth + Responses API)
  // The powerful xAI tools below work with both grok-build OAuth and regular XAI_API_KEY.
  registerXaiProvider(api);

  // Cursor/Composer Grep+Glob shims + arg aliases (activate on grok-build).
  // Inspired by kenryu42/pi-grok-cli — thanks @kenryu42.
  registerGrokToolShims(api);

  // Vision routing: default ON for Composer only; /xai-vision:on for all text-only.
  // Inspired by kenryu42/pi-grok-cli — thanks @kenryu42.
  registerXaiVision(api);

  // Grok CLI–style subscription usage (weekly/monthly limit % from Grok Build billing)
  api.registerCommand("xai-usage", {
    description: "Show Grok Build subscription usage limit and next reset",
    async handler(_args, ctx) {
      try {
        const effective = await getEffectiveXaiApiKey();
        if (!effective?.apiKey) {
          ctx.ui.notify(
            `No xAI credentials. Run /login grok-build (or import grok CLI login).\n${GROK_USAGE_PAGE_URL}`,
            "error",
          );
          return;
        }
        const billing = await fetchBillingUsage(effective.apiKey);
        ctx.ui.notify(formatGrokBuildBilling(billing), "info");
      } catch (err: any) {
        const msg = err?.message || String(err);
        ctx.ui.notify(`${msg}\n${GROK_USAGE_PAGE_URL}`, "error");
      }
    },
  });

  // Agentic mode: automatically inject xAI built-in tools into provider requests
  // when an xAI model (grok-*) is active. Controlled via settings: xai.text.agentic
  api.on("before_provider_request", async (event, ctx) => {
    const payload = event.payload as Record<string, unknown> | undefined;
    if (!payload) return;

    const model = payload.model as string | undefined;
    if (!model?.startsWith("grok-")) return;

    const config = resolveXaiConfig();
    const agentic = getAgenticConfig(config);
    if (agentic.enabled && agentic.tools.length) {
      // Append xAI server-side built-in tools alongside any client-side function tools
      // (bash, edit, read, etc.) that the Pi driver already placed in payload.tools.
      // Previously this *replaced* the whole array, which silently discarded all
      // client-side tools so Grok never saw bash/edit/find and couldn't call them.
      const builtins = agentic.tools.map((t) => ({ type: t }));
      const existing = Array.isArray((payload as any).tools) ? (payload as any).tools : [];
      payload.tools = mergeXaiTools(existing, builtins);
    }

    // Sanitize payload for xAI Responses compatibility.
    // The core "openai-responses" driver (used for grok-4.3* via our provider)
    // emits OpenAI-specific fields that xAI rejects with 422:
    //   - reasoning: { effort, summary: "auto" }  → keep only { effort }
    //   - include: ensure reasoning.encrypted_content (Hermes b4afc6546 replay)
    //   - seed, parallel_tool_calls, prompt_cache_retention, empty tools[], out-of-range temp/top_p
    //
    // This runs ONLY for grok-* models (narrow scope) + in-place mutation + implicit
    // return undefined (correct hook contract per source commit a5dbb7b lesson).
    // Ensures normal provider-driven usage of grok-* models (including reasoning
    // models grok-4.3*) produces xAI-compatible payloads, matching
    // the cleanliness already present in the hand-crafted bodies from custom tools.
    delete (payload as any).seed;
    delete (payload as any).parallel_tool_calls;
    delete (payload as any).prompt_cache_retention;
    delete (payload as any).service_tier;

    if (Array.isArray((payload as any).tools)) {
      stripSlashEnums((payload as any).tools);
      if ((payload as any).tools.length === 0) delete (payload as any).tools;
    }
    const temp = (payload as any).temperature;
    if (typeof temp === "number") {
      (payload as any).temperature = Math.max(0, Math.min(2, temp));
    }
    const topP = (payload as any).top_p;
    if (typeof topP === "number") {
      (payload as any).top_p = Math.max(0, Math.min(1, topP));
    }

    const reasoning = (payload as any).reasoning;
    if (reasoning && typeof reasoning === "object") {
      if (!grokSupportsReasoningEffort(model ?? "")) {
        delete (payload as any).reasoning;
      } else {
        const effort = (reasoning as Record<string, unknown>).effort;
        (payload as any).reasoning = typeof effort === "string" ? { effort } : undefined;
        if (!(payload as any).reasoning) delete (payload as any).reasoning;
      }
    }

    const baseUrl = resolveXaiConfig().xai.baseUrl;
    ensureXaiEncryptedReasoningInclude(payload, model, baseUrl);
    rewriteXaiProviderInput(payload, {
      cwd: ctx.cwd || process.cwd(),
      modelId: model,
    });
    // Pi openai-responses usually sets this already; re-assert for cache affinity if missing.
    ensureXaiPromptCacheKey(payload, ctx.sessionManager.getSessionId());
  });

  // Post-process final assistant text for grok-* (normal chat + agentic search tools).
  // The model sometimes places [[N]] citation markers directly after a URL it just
  // verbalized (e.g. "https://x.ai/cli.[[1]](https://x.com/...)" ). The simple marker
  // replacement in the core renderer then produces ugly glued output.
  // We insert a space so the citation renders as a clean trailing reference, exactly
  // like the other citations in the same response. Only touches grok-* messages.
  api.on("message_end", (event) => {
    const msg: any = event.message;
    if (!msg?.model?.startsWith?.("grok-")) return;

    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block?.type === "text" && typeof block.text === "string") {
          // Turn "url.[[N]](citation)" into "url [[N]](citation)" (and handle [[N]] without url too)
          block.text = glueCitationSpacing(block.text);
        }
      }
    }
  });

  api.registerTool(
    defineTool({
      name: "xai_generate_text",
      label: "xAI Generate Text",
      description:
        "Generate text via xAI Responses API. Supports reasoning models (optional reasoningEffort), structured output, built-in tools (web_search, x_search, code_interpreter, collections_search + advanced filters via object form), stateful conversations via previous_response_id, and encrypted reasoning content. Returns complete formatted summary (inline citations [[N]] appear in text by default per citations doc); for full streaming deltas use normal grok-* chat or direct Responses API stream=true (custom tools intentionally convenience-shaped, not raw stream).",
      parameters: Type.Object({
        prompt: Type.String({ description: "User prompt / message" }),
        model: Type.Optional(
          Type.String({
            description: "Model override (default: grok-4.5)",
          }),
        ),
        reasoningEffort: Type.Optional(
          Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")], {
            description:
              "grok-4.5 / grok-4.3: low/medium/high (API default high; cannot disable). Prefer low for latency-sensitive agentic use.",
          }),
        ),
        system: Type.Optional(Type.String({ description: "System/developer instruction" })),
        previousResponseId: Type.Optional(
          Type.String({ description: "Previous response ID for conversation continuity" }),
        ),
        maxOutputTokens: Type.Optional(Type.Number({ description: "Max output tokens" })),
        temperature: Type.Optional(Type.Number({ description: "Sampling temperature" })),
        store: Type.Optional(
          Type.Boolean({ description: "Store response server-side for 30 days (default: true)" }),
        ),
        include: Type.Optional(
          Type.Array(Type.String(), {
            description: "Additional data to include, e.g. reasoning.encrypted_content",
          }),
        ),
        tools: Type.Optional(
          Type.Array(Type.Any(), {
            description:
              'Built-in tools (Responses API names or full config objects): web_search, x_search, code_interpreter, collections_search. Simple strings for basic enable; pass objects e.g. {type:"web_search", enable_image_understanding:true} or {type:"x_search", from_date:"2025-01-01", allowed_x_handles:["..."]} for advanced filters/dates/understanding per official web-search & x-search docs. (Type.Any for power-user shapes; see Follow-up Discipline in workspace memory.)',
          }),
        ),
        responseFormat: Type.Optional(
          Type.String({ description: "JSON schema string for structured output" }),
        ),
        timeout: Type.Optional(
          Type.Number({
            description: "Request timeout in ms (default 300000, reasoning models need 3600000)",
          }),
        ),
      }),
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const {
          prompt,
          model,
          reasoningEffort,
          system,
          previousResponseId,
          maxOutputTokens,
          temperature,
          store,
          include,
          tools,
          responseFormat,
          timeout,
        } = params;
        const { apiKey, config } = await createRuntime();
        const input: Array<{ role: "user" | "developer"; content: string }> = [];
        if (system) {
          input.push({ role: "developer", content: system });
        }
        input.push({ role: "user", content: prompt });

        const mappedTools = tools?.map((t: any) => (typeof t === "string" ? { type: t } : t));
        let parsedFormat:
          | {
              type: "json_schema";
              json_schema: { name: string; schema: Record<string, unknown>; strict?: boolean };
            }
          | undefined;
        if (responseFormat) {
          try {
            const schema = JSON.parse(responseFormat) as Record<string, unknown>;
            parsedFormat = {
              type: "json_schema",
              json_schema: { name: "response", schema, strict: true },
            };
          } catch {
            throw new Error("responseFormat must be valid JSON schema string");
          }
        }

        const modelToUse = model || "grok-4.5";
        const isReasoningModel =
          grokSupportsReasoningEffort(modelToUse) ||
          modelToUse === "grok-build" ||
          modelToUse.startsWith("grok-build-") ||
          modelToUse.includes("reasoning");
        const effectiveTimeout = timeout ?? (isReasoningModel ? 3_600_000 : 300_000);

        const body: Record<string, unknown> = { model: modelToUse, input };
        if (previousResponseId) body.previous_response_id = previousResponseId;
        if (maxOutputTokens !== undefined) body.max_output_tokens = maxOutputTokens;
        if (temperature !== undefined) body.temperature = temperature;
        if (store !== undefined) body.store = store;
        if (include?.length) {
          body.include = include;
        } else if (store !== false && grokWantsEncryptedReasoningInclude(modelToUse)) {
          body.include = ["reasoning.encrypted_content"];
        }
        if (mappedTools?.length) body.tools = mappedTools;
        if (parsedFormat) body.text = { format: parsedFormat };
        if (reasoningEffort && isReasoningModel && !modelToUse.startsWith("grok-build")) {
          body.reasoning = { effort: reasoningEffort };
        }

        const result = await callXaiResponses(
          apiKey,
          config.xai.baseUrl,
          body,
          effectiveTimeout,
          ctx.sessionManager.getSessionId(),
          ctx.cwd,
        );

        return textResult(formatResponseSummary(result, "xAI Response"));
      },
    }),
  );

  // On by default (xai.text.multiAgent). Currently grok-4.20 multi-agent model id.
  // Disable: { "xai": { "text": { "multiAgent": false } } }
  if (isMultiAgentToolEnabled()) {
    api.registerTool(
      defineTool({
        name: "xai_multi_agent",
        label: "xAI Multi-Agent Research",
        description:
          "Deep research via xAI multi-agent model (grok-4.20-multi-agent). Orchestrates multiple agents with built-in tools (web_search, x_search + advanced via objects, collections_search). Returns formatted summary with progress via onUpdate; streaming content via core provider or raw API.",
        parameters: Type.Object({
          prompt: Type.String({ description: "Research query / question" }),
          reasoningEffort: Type.Optional(
            Type.Union(
              [
                Type.Literal("low"),
                Type.Literal("medium"),
                Type.Literal("high"),
                Type.Literal("xhigh"),
              ],
              { description: "low/medium=4 agents, high/xhigh=16 agents" },
            ),
          ),
          tools: Type.Optional(
            Type.Array(Type.Any(), {
              description:
                "Built-in tools (Responses API names or full config objects): web_search, x_search, code_interpreter, collections_search. Simple strings for basic; objects for advanced filters (allowed_x_handles, from_date/to_date, enable_image_understanding, enable_video_understanding, etc.) per x-search/web-search docs.",
            }),
          ),
          previousResponseId: Type.Optional(
            Type.String({ description: "Continue previous multi-agent conversation" }),
          ),
          store: Type.Optional(Type.Boolean({ description: "Store response server-side" })),
          include: Type.Optional(
            Type.Array(Type.String(), {
              description: "Include verbose_streaming or reasoning.encrypted_content",
            }),
          ),
          timeout: Type.Optional(Type.Number({ description: "Timeout in ms (default 3600000)" })),
        }),
        async execute(_toolCallId, params, _signal, onUpdate, ctx) {
          const { prompt, reasoningEffort, tools, previousResponseId, store, include, timeout } =
            params;
          const { apiKey, config } = await createRuntime();
          const agentCount = reasoningEffort === "high" || reasoningEffort === "xhigh" ? 16 : 4;

          onUpdate?.({
            content: [
              {
                type: "text" as const,
                text: `🔬 Starting multi-agent research with ${agentCount} agents...`,
              },
            ],
            details: `research-start: ${agentCount} agents`,
          });

          const input = [{ role: "user" as const, content: prompt }];
          const mappedTools = tools?.map((t: any) => (typeof t === "string" ? { type: t } : t));

          const body: Record<string, unknown> = {
            model: "grok-4.20-multi-agent-0309",
            input,
          };
          if (reasoningEffort) {
            body.reasoning = { effort: reasoningEffort };
          }
          if (previousResponseId) body.previous_response_id = previousResponseId;
          if (mappedTools?.length) body.tools = mappedTools;
          if (store !== undefined) body.store = store;
          if (include?.length) body.include = include;

          const effectiveTimeout = timeout ?? 3_600_000;
          const result = await callXaiResponses(
            apiKey,
            config.xai.baseUrl,
            body,
            effectiveTimeout,
            ctx.sessionManager.getSessionId(),
            ctx.cwd,
          );

          onUpdate?.({
            content: [
              {
                type: "text" as const,
                text: `✅ Research complete. ${result.usage?.output_tokens ?? "?"} output tokens (${result.usage?.output_tokens_details?.reasoning_tokens ?? 0} reasoning).`,
              },
            ],
            details: `research-done: ${result.id}`,
          });

          return textResult(formatResponseSummary(result, "xAI Multi-Agent"));
        },
      }),
    );
  }

  api.registerTool(
    defineTool({
      name: "xai_x_search",
      label: "xAI X Search",
      description:
        "Search X (Twitter) using Grok's live x_search built-in tool (real posts with citations).",
      parameters: Type.Object({
        query: Type.String({ description: "X search query" }),
        from_date: Type.Optional(
          Type.String({ description: "Filter posts on or after this date (YYYY-MM-DD, UTC)" }),
        ),
        to_date: Type.Optional(
          Type.String({ description: "Filter posts on or before this date (YYYY-MM-DD, UTC)" }),
        ),
      }),
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const { query, from_date, to_date } = params;
        const { apiKey, config } = await createRuntime();
        // Hardcoded 4.20 reasoning id from Grok CLI catalog; override later via settings if needed.
        const xSearchTool: Record<string, unknown> = { type: "x_search" };
        if (from_date?.trim()) xSearchTool.from_date = from_date.trim();
        if (to_date?.trim()) xSearchTool.to_date = to_date.trim();
        const body: Record<string, unknown> = {
          model: "grok-4.20-0309-reasoning",
          input: [{ role: "user" as const, content: query.trim() }],
          tools: [xSearchTool],
          store: false,
        };
        const result = await callXaiResponses(
          apiKey,
          config.xai.baseUrl,
          body,
          300_000,
          ctx.sessionManager.getSessionId(),
          ctx.cwd,
        );
        return textResult(formatResponseSummary(result, "xAI X Search"));
      },
    }),
  );
}
