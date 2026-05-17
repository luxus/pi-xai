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

  const text = textParts.join("\n");
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
