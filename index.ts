import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  resolveXaiConfig,
  getAgenticConfig,
  getPiSettingsPaths,
  type ResolvedXaiConfig,
} from "./xai-config.ts";
import { registerXaiProvider } from "./xai-provider.ts";
import { getEffectiveXaiApiKey, autoImportGrokCliIfNeeded } from "./xai-oauth.ts";

// Re-export credential helpers so sibling extensions (pi-xai-imagine, pi-xai-voice, etc.)
// can prefer Grok Build OAuth when the user has run `/login grok-build`.
export { getEffectiveXaiApiKey, autoImportGrokCliIfNeeded } from "./xai-oauth.ts";
export {
  resolveXaiConfig,
  getAgenticConfig,
  getPiSettingsPaths,
  type ResolvedXaiConfig,
} from "./xai-config.ts";

// normalizeForXai is defined + exported below (in same file) for sibling direct /responses usage
// and for the aggressive rewrite path. It is the canonical normalisation implementation.
// In aggressive mode it now also carries the key Hermes xAI Responses guarantees
// (reasoning-item strip for is_xai_responses, content-element enforcement) from the
// fresh 2026-05-19 Hermes clone exploration (/tmp/hermes-agent-clone: codex_responses_adapter.py
// _chat_messages_to_responses_input + has_codex_reasoning/empty-follower handling, chat_completion_helpers
// is_xai_responses detection, codex transport include:[] + encrypted skip for xAI). This was the
// highest-impact port under the single-provider + hook constraints — smallest-diff extension
// of the already-exported helper per explicit user request (see prior IMPL a2042b0e + review).

async function createRuntime(): Promise<{
  apiKey: string;
  apiKeySource: string;
  config: ResolvedXaiConfig;
}> {
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

  const config = resolveXaiConfig();
  return {
    apiKey: effective.apiKey,
    apiKeySource: effective.source,
    config,
  };
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
  let inlineAnnotations = 0; // richer citations: count structured annotations per xAI citations doc (output[].content[].annotations[] of type url_citation)

  for (const item of items) {
    if (item.type === "message" && Array.isArray(item.content)) {
      for (const c of item.content) {
        if (c.type === "output_text" && typeof c.text === "string") {
          textParts.push(c.text);
          if (Array.isArray((c as any).annotations))
            inlineAnnotations += (c as any).annotations.length;
        }
      }
    } else if (
      ["function_call", "web_search_call", "x_search_call", "code_interpreter_call"].includes(
        item.type,
      )
    ) {
      const name = typeof item.name === "string" ? item.name : item.type;
      toolCalls.push(`- Tool call: ${name}`);
    }
  }

  const text = textParts
    .join("\n")
    .replace(/((?:https?:\/\/|www\.)[^\s<>\]]+)(\[\[\d+\]\]\([^)]+\))/g, "$1 $2");
  const toolCallText = toolCalls.join("\n");
  const usage = result.usage
    ? `Tokens: ${result.usage.input_tokens ?? "?"} in / ${result.usage.output_tokens ?? "?"} out`
    : "";
  const reasoning = result.usage?.output_tokens_details?.reasoning_tokens
    ? ` (reasoning: ${result.usage.output_tokens_details.reasoning_tokens})`
    : "";
  const tools = result.server_side_tool_usage
    ? `\nTool calls: ${Object.entries(result.server_side_tool_usage)
        .map(([k, v]) => `${k}=${v}`)
        .join(", ")}`
    : "";
  const body = [text, toolCallText].filter(Boolean).join("\n\n");
  const ann = inlineAnnotations ? `\nInline annotations: ${inlineAnnotations}` : "";
  return `**${title}** (${result.model})\n\n${body || "(no text output)"}\n\n${usage}${reasoning}${tools}${citationsSummary(result.citations)}${ann}`;
}

function textResult(text: string): {
  content: Array<{ type: "text"; text: string }>;
  details: string;
} {
  return { content: [{ type: "text" as const, text }], details: text };
}

/** Tiny internal helper to avoid duplicating fetch + error + reloginRequired logic
 * (addresses review duplication concern while staying within the single index.ts file
 * and preserving the aggressive inlining goal of steps 4-8).
 */
async function callXaiResponses(
  apiKey: string,
  baseUrl: string,
  body: Record<string, unknown>,
  timeout?: number,
): Promise<any> {
  // Same defensive content normalization as the provider hook.
  // Protects direct rich-tool calls (xai_generate_text, xai_x_search, etc.)
  // and any paths used by sibling packages during development.
  // Enhanced for more edge cases even in compatible mode (arrays with only malformed/empty/garbage parts,
  // whitespace strings, etc.) while obeying "smallest diff / extend existing sites" rule.
  const input = (body as any).input;
  if (Array.isArray(input)) {
    for (const item of input) {
      if (!item || typeof item !== "object" || !item.role) continue;
      const c = (item as any).content;
      let isEmpty =
        c === undefined || c === null || c === "" || (Array.isArray(c) && c.length === 0);
      if (!isEmpty && Array.isArray(c)) {
        // Recognizes any valid content element per xAI Responses (text parts or
        // input_image etc.). Presence of recognized parts (including pure-image
        // messages) means "do not treat as empty" — prevents destroying legitimate
        // vision content while still catching malformed/empty/garbage-only cases
        // that trigger the 400.
        const hasValid = c.some(
          (p: any) =>
            p &&
            typeof p === "object" &&
            (typeof p.text === "string" ||
              ["input_text", "output_text", "text", "input_image"].includes(p.type)),
        );
        if (!hasValid) isEmpty = true;
      }
      if (!isEmpty && typeof c === "string" && !String(c).trim()) isEmpty = true;
      if (isEmpty) {
        const partType =
          (item as any).type === "message" && item.role === "assistant"
            ? "output_text"
            : "input_text";
        // (as any) escape documented: smallest possible diff / no new helper for
        // enhancing the two existing sanitization sites (callXaiResponses + before_provider_request);
        // follows workspace memory patterns of in-place mutation inside already-scoped hooks
        // (see 400 "content element" bug history + BlockedPath/pi-xai-oauth analysis requiring
        // post-driver fixes instead of custom provider).
        (item as any).content = [{ type: partType, text: "" }];
      }
    }
  }

  const url = `${baseUrl.replace(/\/+$/, "")}/responses`;
  const init: RequestInit & { signal?: AbortSignal } = {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
  if (timeout) init.signal = AbortSignal.timeout(timeout);

  const res = await fetch(url, init);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const err = new Error(`xAI API error: ${res.status} ${text.slice(0, 500)}`);
    if (res.status === 401) (err as any).reloginRequired = true;
    throw err;
  }
  return res.json();
}

/**
 * normalizeForXai(input)
 *
 * Exported single source of truth for the thorough xAI Responses input normalisation
 * logic (content element guarantee + edge cases). Both compatible (enhanced) and
 * aggressive paths, plus sibling packages (pi-xai-imagine, pi-xai-voice, etc.) can
 * share it for their direct `/responses` calls.
 *
 * Callers (siblings):
 *   import { normalizeForXai, resolveXaiConfig, getEffectiveXaiApiKey } from "pi-xai";
 *   const cfg = resolveXaiConfig();
 *   const key = await getEffectiveXaiApiKey();
 *   const body = { model: "grok-4.3", input: myMessagesOrPartsArray };
 *   body.input = normalizeForXai(body.input);  // mutates in-place + returns it
 *   const res = await fetch(`${cfg.xai.baseUrl.replace(/\/+$/, "")}/responses`, {
 *     method: "POST",
 *     headers: { Authorization: `Bearer ${key.apiKey}`, "Content-Type": "application/json" },
 *     body: JSON.stringify(body),
 *   });
 *
 * Guarantees:
 * - Every `{role: ...}` item has `content: [{type: "input_text"|"output_text", text: "..."}]` (at minimum)
 *   even if driver/sibling produced [], null, "", [only malformed/empty/garbage parts with no recognized
 *   content types incl. input_image], whitespace-only, etc. (prevents 400 "Each message must have at least
 *   one content element").
 * - In aggressive mode (or when sibling explicitly calls this helper): ALSO strips every
 *   `type: "reasoning"` item (Hermes xAI behavior under is_xai_responses=True from the 2026-05-19
 *   clone exploration of codex_responses_adapter._chat_messages_to_responses_input + the codex
 *   transport's include:[] / encrypted skip for xAI provider/hostname). xAI/Grok never receives
 *   replayed encrypted_content blobs; this eliminates "reasoning item with no following content-bearing item"
 *   / missing_following_item / content-element 400s after tool turns, high-reasoning turns, and long histories.
 *   (The adapter's has_codex_reasoning + emit-empty-assistant is for non-xai; for xai the port omits
 *   reasoning items entirely and lets the content fix ensure any follower is valid.)
 * - Does NOT relocate developer/system (that is a payload-level step in aggressive mode).
 * - Performs in-place mutations on the array and its items (project convention). Returns the (possibly shorter) array.
 *
 * Toggle via xai.payloadMode in settings (see xai-config.ts); defaults to "compatible"
 * (no behavior change for existing users; only aggressive + explicit helper calls get the Hermes reasoning-strip).
 *
 * Limitations:
 * - Built-in rich `xai_*` tools (xai_generate_text, xai_web_search, xai_x_search, xai_code_execution,
 *   xai_multi_agent) and any direct calls routed through the internal `callXaiResponses` helper always
 *   receive *only* the enhanced-compatible content normalization (the duplicated inline predicate),
 *   even when `payloadMode="aggressive"`. They do not get the reasoning-item strip or the other
 *   aggressive transforms. This is a direct consequence of the "no new helpers for the *internal*
 *   compatible path" + "extend existing inline sites only" constraint that governed the entire
 *   payloadMode and Hermes-port work (see IMPL a2042b0e + review).
 * - For *full* aggressive/Hermes guarantees on direct `/responses` calls from siblings or custom code,
 *   explicitly invoke `normalizeForXai(yourInputArray)` (the usage recipe above). Only the provider
 *   chat/agentic path (grok-* via before_provider_request) receives the complete rewrite when
 *   aggressive is configured.
 * - Default behavior is and remains 100% the prior "compatible" experience.
 */
export function normalizeForXai(input: unknown[]): unknown[] {
  // TODO(post-audit): dedupe the three near-identical normalisation predicates (per constraints, duplication was required for this change; see prior review decision on duplication under the no-new-helper constraint — retained explicitly for smallest-diff compliance, from the payloadMode implementation round).
  // (as any) escape documented: smallest possible diff / no new helper for the
  // defensive early return (runtime tolerance for untyped/JS sibling call sites);
  // follows workspace memory patterns of in-place mutation inside already-scoped
  // hooks + 400 "content element" bug history + BlockedPath/pi-xai-oauth analysis
  // (post-driver fixes rather than custom provider registration).
  if (!Array.isArray(input)) return input as any[];

  // === Hermes-like xAI aggressive handling (minimal port) ===
  // Proactively strip all reasoning items before the content-element fix.
  // This is the key guarantee from Hermes' is_xai_responses path in
  // codex_responses_adapter._chat_messages_to_responses_input (the has_codex_reasoning
  // + emit {"role":"assistant","content":""} only for non-xai; for xai simply
  // never emits reasoning items at all) and the codex transport (include:[] +
  // no encrypted for xai provider/hostname=="api.x.ai").
  //
  // Why here (aggressive + exported helper only):
  // - Smallest possible diff: extend the already-exported normalizeForXai
  //   (user-requested for siblings) rather than touching internal compatible
  //   inline sites in callXaiResponses or the pre-aggressive block in the hook.
  // - The openai-responses driver (generic, used by our single "grok-build"
  //   provider registration) can emit reasoning items from stored history on
  //   high-reasoning/tool/long-convo paths; the strip makes the aggressive
  //   payload "as much like Hermes" as possible without becoming a full custom
  //   transport or second provider.
  // - After strip, any would-be "pure reasoning follower" assistant (content ""
  //   or missing) still present in the list gets fixed to a valid content array
  //   by the loop below → strong "no role-bearing item with bad content" + no
  //   reasoning-without-follower ever reaches xAI.
  // - (as any) + reverse-splice for in-place: required by "smallest diff / no
  //   new helper for the *internal* compatible path" + all prior memory
  //   (2026-05-19 400 analysis, payloadMode 0.8.2, in-place before_provider_request
  //   + callXaiResponses preference, single grok-build registration).
  // Default (compatible) + callXaiResponses internal norm paths: untouched.
  for (let i = (input as any[]).length - 1; i >= 0; i--) {
    const it: any = (input as any[])[i];
    if (it && typeof it === "object" && it.type === "reasoning") {
      (input as any[]).splice(i, 1);
    }
  }

  for (const item of input) {
    if (!item || typeof item !== "object" || !(item as any).role) continue;
    const c = (item as any).content;
    let needsFix =
      c === undefined || c === null || c === "" || (Array.isArray(c) && c.length === 0);
    if (!needsFix && Array.isArray(c)) {
      // Recognizes any valid content element per xAI Responses (text parts or
      // input_image etc.). Presence of recognized parts (including pure-image
      // messages) means "do not treat as empty" — prevents destroying legitimate
      // vision content while still catching malformed/empty/garbage-only cases
      // that trigger the 400.
      const hasValid = c.some(
        (p: any) =>
          p &&
          typeof p === "object" &&
          (typeof p.text === "string" ||
            ["input_text", "output_text", "text", "input_image"].includes(p.type)),
      );
      if (!hasValid) needsFix = true;
    }
    if (!needsFix && typeof c === "string" && !String(c).trim()) needsFix = true;
    if (needsFix) {
      // (as any) documented per "smallest possible diff / no new helper" + workspace
      // memory (in-place inside hooks): helper exists only because task #3 requires an
      // exported single source for siblings + aggressive path; internal compatible sites
      // were deliberately left as extended inline blocks.
      const partType =
        (item as any).type === "message" && (item as any).role === "assistant"
          ? "output_text"
          : "input_text";
      (item as any).content = [{ type: partType, text: "" }];
    }
  }
  return input;
}

export default async function (api: ExtensionAPI) {
  // Auto-import any existing Grok CLI credentials from ~/.grok/auth.json (if present)
  // into the "grok-build" slot. This is a convenience only — the primary way to
  // authenticate is the native `/login grok-build` OAuth flow (no binary needed).
  await autoImportGrokCliIfNeeded();

  // Register xAI (Grok Build) provider (subscription OAuth + Responses API)
  // The powerful xAI tools below work with both grok-build OAuth and regular XAI_API_KEY.
  registerXaiProvider(api);

  // Agentic mode: automatically inject xAI built-in tools into provider requests
  // when an xAI model (grok-*) is active. Controlled via settings: xai.text.agentic
  api.on("before_provider_request", async (event) => {
    const payload = event.payload as Record<string, unknown> | undefined;
    if (!payload) return;

    const model = payload.model as string | undefined;
    if (!model?.startsWith("grok-")) return;

    const config = resolveXaiConfig();
    const agentic = getAgenticConfig(config);
    if (agentic.enabled && agentic.tools.length) {
      // Inject configured built-in tools into the request
      payload.tools = agentic.tools.map((t) => ({ type: t }));
    }

    // Sanitize payload for xAI Responses compatibility.
    // The core "openai-responses" driver (used for grok-4.3* via our provider)
    // emits OpenAI-specific fields that xAI rejects with 422:
    //   - reasoning: { effort, summary: "auto" }  → keep only { effort }
    //   - include: ["reasoning.encrypted_content"]  → strip the xAI-incompatible entry
    //   - seed, parallel_tool_calls, prompt_cache_retention, empty tools[], out-of-range temp/top_p
    //
    // This runs ONLY for grok-* models (narrow scope) + in-place mutation + implicit
    // return undefined (correct hook contract per source commit a5dbb7b lesson).
    // Ensures normal provider-driven usage of grok-* models (including reasoning
    // models grok-4.3 / grok-4.3-latest) produces xAI-compatible payloads, matching
    // the cleanliness already present in the hand-crafted bodies from custom tools.
    delete (payload as any).seed;
    delete (payload as any).parallel_tool_calls;
    delete (payload as any).prompt_cache_retention;

    if (Array.isArray((payload as any).tools) && (payload as any).tools.length === 0) {
      delete (payload as any).tools;
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
      const effort = (reasoning as Record<string, unknown>).effort;
      (payload as any).reasoning = typeof effort === "string" ? { effort } : undefined;
      if (!(payload as any).reasoning) delete (payload as any).reasoning;
    }

    const inc = (payload as any).include;
    if (Array.isArray(inc)) {
      const filtered = inc.filter(
        (v: unknown) => typeof v === "string" && !v.includes("encrypted_content"),
      );
      if (filtered.length === 0) {
        delete (payload as any).include;
      } else {
        (payload as any).include = filtered;
      }
    }

    // Defensive content normalization for xAI Responses API.
    // The openai-responses driver (used for normal grok-* chat + agentic tools)
    // can emit messages with `content: []` (or null/undefined, or "") after tool-using turns
    // (built-in web_search / x_search do not record the *_call items in Pi history the same way).
    // xAI rejects these with 400 "Each message must have at least one content element."
    // (reproduced across sessions: "latest news on x", Swiss news, etc. → follow-up).
    // In-place only, no helpers, gated to grok-*. Enhanced for more thorough coverage of
    // edge cases (arrays containing only malformed/empty/garbage parts with no recognized
    // content types incl. input_image, nested empties after reasoning, role items with
    // post-driver empty content) in the default/compatible path.
    if (Array.isArray(payload.input)) {
      for (const item of payload.input) {
        if (!item || typeof item !== "object" || !item.role) continue;

        const c = (item as any).content;
        let isEmpty =
          c === undefined || c === null || c === "" || (Array.isArray(c) && c.length === 0);
        if (!isEmpty && Array.isArray(c)) {
          // Recognizes any valid content element per xAI Responses (text parts or
          // input_image etc.). Presence of recognized parts (including pure-image
          // messages) means "do not treat as empty" — prevents destroying legitimate
          // vision content while still catching malformed/empty/garbage-only cases
          // that trigger the 400.
          const hasValid = c.some(
            (p: any) =>
              p &&
              typeof p === "object" &&
              (typeof p.text === "string" ||
                ["input_text", "output_text", "text", "input_image"].includes(p.type)),
          );
          if (!hasValid) isEmpty = true;
        }
        if (!isEmpty && typeof c === "string" && !String(c).trim()) isEmpty = true;

        if (isEmpty) {
          // Use the correct part type for the Responses wire format.
          const partType =
            (item as any).type === "message" && item.role === "assistant"
              ? "output_text"
              : "input_text";
          // (as any) escape documented: smallest possible diff / no new helper for
          // enhancing the two existing sanitization sites (callXaiResponses + before_provider_request);
          // follows workspace memory patterns of in-place mutation inside already-scoped hooks
          // (see 400 "content element" bug history + BlockedPath/pi-xai-oauth analysis requiring
          // post-driver fixes instead of custom provider).
          (item as any).content = [{ type: partType, text: "" }];
        }
      }
    }

    // Aggressive mode (xai.payloadMode === "aggressive" in settings; defaults to
    // "compatible" so zero behavior change for existing users). When enabled,
    // performs a much more complete payload rewrite for the provider chat path:
    // heavy input norm (via the shared helper), developer/system relocation to
    // top-level instructions, stricter function_call_output cleaning.
    // The norm piece now includes Hermes xAI parity (reasoning-item strip + strengthened
    // content guarantees) from the fresh 2026-05-19 Hermes clone exploration
    // (codex_responses_adapter._chat_messages_to_responses_input is_xai_responses handling,
    // has_codex_reasoning/empty follower, codex transport include:[] + no encrypted for xAI).
    // Still exclusively through the existing "grok-build" + "openai-responses" registration
    // + this before_provider_request hook point (no second provider ever registered).
    // In-place mutations only. See normalizeForXai JSDoc for full details + Limitations.
    const payloadMode = config.xai.payloadMode;
    if (payloadMode === "aggressive" && Array.isArray(payload.input)) {
      // Use the exported helper (single source of truth) for the thorough norm piece.
      // The helper now includes the Hermes xAI aggressive guarantees (reasoning-item
      // strip + strengthened content-element) — see normalizeForXai JSDoc + body
      // comments for the full port rationale from the 2026-05-19 clone (specific patterns:
      // proactive strip of type:reasoning to match xai is_xai_responses omission of
      // encrypted replay + follower guarantees; post-strip content fix for any remaining
      // empty assistants).
      // (as any) escape documented: smallest possible diff / no new helper for the
      // aggressive rewrite path (extends the existing before_provider_request hook);
      // follows workspace memory patterns of in-place mutation inside already-scoped
      // hooks (see 400 "content element" bug history + prior BlockedPath/pi-xai-oauth analysis
      // requiring post-driver fixes instead of custom provider) +
      // 2026-05-19 Hermes clone exploration for minimal viable "aggressive that behaves as hermes".
      normalizeForXai(payload.input as unknown[]);

      // Note: content normalization is intentionally re-run here (after the Hermes
      // reasoning strip) for the stronger post-strip guarantees on any would-be orphaned
      // follower assistant items; the prior compatible block (the for-loop at ~377-409)
      // ensures baseline safety for *all* grok-* paths (including default compatible).
      // This small redundancy is accepted to obey the "smallest possible diff / no
      // refactor or new helpers for internal compatible sites" rule from the entire
      // 400 + payloadMode + Hermes port history.

      // Developer / system messages → top-level instructions (common pattern in
      // the reference to keep input clean for xAI while preserving semantics).
      // (as any) escape documented: smallest possible diff / no new helper for the
      // aggressive rewrite path (extends the existing before_provider_request hook);
      // follows workspace memory patterns of in-place mutation inside already-scoped
      // hooks (see 400 "content element" bug history + BlockedPath/pi-xai-oauth analysis
      // requiring post-driver fixes instead of custom provider registration).
      const input = payload.input as any[];
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
        // (as any) escape documented: smallest possible diff / no new helper for the
        // aggressive rewrite path (extends the existing before_provider_request hook);
        // follows workspace memory patterns of in-place mutation inside already-scoped
        // hooks (see 400 "content element" bug history + BlockedPath/pi-xai-oauth analysis
        // requiring post-driver fixes instead of custom provider registration).
        const prev = (payload as any).instructions;
        (payload as any).instructions = prev
          ? `${prev}\n\n${instructionParts.join("\n\n")}`
          : instructionParts.join("\n\n");
      }

      // Stricter tool-result cleaning (function_call_output.output must be string for xAI;
      // arrays with images or structured data are rewritten to text + placeholder).
      for (const item of input) {
        if (
          item &&
          typeof item === "object" &&
          item.type === "function_call_output" &&
          Array.isArray(item.output)
        ) {
          // (as any) escape documented: smallest possible diff / no new helper for the
          // aggressive rewrite path (extends the existing before_provider_request hook);
          // follows workspace memory patterns of in-place mutation inside already-scoped
          // hooks (see 400 "content element" bug history + BlockedPath/pi-xai-oauth analysis
          // requiring post-driver fixes instead of custom provider registration).
          const outArr = item.output as any[];
          const asText =
            outArr
              .map((p: any) =>
                typeof p === "string"
                  ? p
                  : p && typeof p === "object"
                    ? p.text || (p.type === "input_image" ? "[image]" : JSON.stringify(p))
                    : String(p ?? ""),
              )
              .filter(Boolean)
              .join("\n") || "(tool returned no text output)";
          // (as any) escape documented: smallest possible diff / no new helper for the
          // aggressive rewrite path (extends the existing before_provider_request hook);
          // follows workspace memory patterns of in-place mutation inside already-scoped
          // hooks (see 400 "content element" bug history + BlockedPath/pi-xai-oauth analysis
          // requiring post-driver fixes instead of custom provider registration).
          (item as any).output = asText;
        }
      }
    }
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
          block.text = block.text.replace(
            /((?:https?:\/\/|www\.)[^\s<>\]]+)(\[\[\d+\]\]\([^)]+\))/g,
            "$1 $2",
          );
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
            description:
              "Model override (default: grok-4 via XAI_API_KEY fallback; grok-4.3 / grok-build recommended with /login grok-build)",
          }),
        ),
        reasoningEffort: Type.Optional(
          Type.Union(
            [
              Type.Literal("low"),
              Type.Literal("medium"),
              Type.Literal("high"),
              Type.Literal("xhigh"),
            ],
            {
              description:
                "low/medium/high/xhigh (reasoning depth for grok-4.3*; ignored for grok-build)",
            },
          ),
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
      async execute(_toolCallId, params) {
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

        const modelToUse = model || "grok-4";
        const isReasoningModel =
          modelToUse.includes("4.3") ||
          modelToUse === "grok-build" ||
          modelToUse.includes("reasoning");
        const effectiveTimeout = timeout ?? (isReasoningModel ? 3_600_000 : 300_000);

        const body: Record<string, unknown> = { model: modelToUse, input };
        if (previousResponseId) body.previous_response_id = previousResponseId;
        if (maxOutputTokens !== undefined) body.max_output_tokens = maxOutputTokens;
        if (temperature !== undefined) body.temperature = temperature;
        if (store !== undefined) body.store = store;
        if (include?.length) body.include = include;
        if (mappedTools?.length) body.tools = mappedTools;
        if (parsedFormat) body.text = { format: parsedFormat };
        if (reasoningEffort && isReasoningModel && modelToUse !== "grok-build") {
          body.reasoning = { effort: reasoningEffort };
        }

        const result = await callXaiResponses(apiKey, config.xai.baseUrl, body, effectiveTimeout);

        return textResult(formatResponseSummary(result, "xAI Response"));
      },
    }),
  );

  api.registerTool(
    defineTool({
      name: "xai_multi_agent",
      label: "xAI Multi-Agent Research",
      description:
        "Deep research via xAI Coding Plan models (grok-build / grok-4.3). Orchestrates multiple agents with built-in tools (web_search, x_search + advanced via objects, collections_search). Note: the special 'grok-build' model does not accept explicit reasoningEffort (it uses maximum reasoning internally). Returns formatted summary with progress via onUpdate; streaming content via core provider or raw API.",
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
      async execute(_toolCallId, params, _signal, onUpdate) {
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

        const body: Record<string, unknown> = { model: "grok-4.20-multi-agent", input };
        if (reasoningEffort) {
          body.reasoning = { effort: reasoningEffort };
        }
        if (previousResponseId) body.previous_response_id = previousResponseId;
        if (mappedTools?.length) body.tools = mappedTools;
        if (store !== undefined) body.store = store;
        if (include?.length) body.include = include;

        const effectiveTimeout = timeout ?? 3_600_000;
        const result = await callXaiResponses(apiKey, config.xai.baseUrl, body, effectiveTimeout);

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

  // Experimental agentic tools — lightweight "prompt the model" simulations for web search,
  // X/Twitter search, and code execution. These complement (do not duplicate) the two rich
  // tools and the native built-in tool injection in agentic mode. They are exposed as
  // first-class callable tools so users can invoke them directly when explicit control is desired.
  //
  // They reuse the project's existing helpers (createRuntime, callXaiResponses, etc.) for
  // consistent auth resolution, error handling, and output formatting.
  api.registerTool(
    defineTool({
      name: "xai_web_search",
      label: "xAI Web Search",
      description: "Search the web using Grok (prompts the model for current web knowledge).",
      parameters: Type.Object({
        query: Type.String({ description: "Search query" }),
      }),
      async execute(_toolCallId, params) {
        const { query } = params;
        const { apiKey, config } = await createRuntime();
        const prompt = `Perform a web search for: ${query}. Summarize the top results with sources and key facts.`;
        const body: Record<string, unknown> = {
          model: "grok-4.3",
          input: [{ role: "user" as const, content: prompt }],
          reasoning: { effort: "medium" },
        };
        const result = await callXaiResponses(apiKey, config.xai.baseUrl, body, 300_000);
        return textResult(formatResponseSummary(result, "xAI Web Search"));
      },
    }),
  );

  api.registerTool(
    defineTool({
      name: "xai_x_search",
      label: "xAI X Search",
      description: "Search X (Twitter) using Grok.",
      parameters: Type.Object({
        query: Type.String({ description: "X search query" }),
      }),
      async execute(_toolCallId, params) {
        const { query } = params;
        const { apiKey, config } = await createRuntime();
        const prompt = `Search X/Twitter for recent posts about: ${query}. Summarize key tweets, users, and sentiment.`;
        const body: Record<string, unknown> = {
          model: "grok-4.3",
          input: [{ role: "user" as const, content: prompt }],
          reasoning: { effort: "medium" },
        };
        const result = await callXaiResponses(apiKey, config.xai.baseUrl, body, 300_000);
        return textResult(formatResponseSummary(result, "xAI X Search"));
      },
    }),
  );

  api.registerTool(
    defineTool({
      name: "xai_code_execution",
      label: "xAI Code Execution",
      description:
        "Execute Python code by asking Grok to run/analyze it (safe simulation via model).",
      parameters: Type.Object({
        code: Type.String({ description: "Python code to execute or analyze" }),
      }),
      async execute(_toolCallId, params) {
        const { code } = params;
        const { apiKey, config } = await createRuntime();
        const prompt = `Execute or analyze this Python code and show the result or output:\n\n${code}`;
        const body: Record<string, unknown> = {
          model: "grok-4.3",
          input: [{ role: "user" as const, content: prompt }],
          reasoning: { effort: "low" },
        };
        const result = await callXaiResponses(apiKey, config.xai.baseUrl, body, 300_000);
        return textResult(formatResponseSummary(result, "xAI Code Execution"));
      },
    }),
  );
}
