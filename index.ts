import { defineTool, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import {
  resolveXaiConfig,
  getAgenticConfig,
  getPiSettingsPaths,
  type ResolvedXaiConfig,
} from "./xai-config.ts";
import { registerXaiProvider } from "./xai-provider.ts";
import {
  getEffectiveXaiApiKey,
  autoImportGrokCliIfNeeded,
} from "./xai-oauth.ts";

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

  for (const item of items) {
    if (item.type === "message" && Array.isArray(item.content)) {
      for (const c of item.content) {
        if (c.type === "output_text" && typeof c.text === "string") {
          textParts.push(c.text);
        }
      }
    } else if (["function_call", "web_search_call", "x_search_call", "code_interpreter_call"].includes(item.type)) {
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
    ? `\nTool calls: ${Object.entries(result.server_side_tool_usage).map(([k, v]) => `${k}=${v}`).join(", ")}`
    : "";
  const body = [text, toolCallText].filter(Boolean).join("\n\n");
  return `**${title}** (${result.model})\n\n${body || "(no text output)"}\n\n${usage}${reasoning}${tools}${citationsSummary(result.citations)}`;
}

function textResult(text: string): { content: Array<{ type: "text"; text: string }>; details: string } {
  return { content: [{ type: "text" as const, text }], details: text };
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
    if (!agentic.enabled || !agentic.tools.length) return;

    // Inject configured built-in tools into the request
    payload.tools = agentic.tools.map((t) => ({ type: t }));
  });

  api.registerTool(
    defineTool({
      name: "xai_generate_text",
      label: "xAI Generate Text",
      description:
        "Generate text via xAI Responses API. Supports reasoning models, structured output, built-in tools (web_search, x_search, code_execution), stateful conversations via previous_response_id, and encrypted reasoning content.",
      parameters: Type.Object({
        prompt: Type.String({ description: "User prompt / message" }),
        model: Type.Optional(Type.String({ description: "Model override (default: grok-4 via XAI_API_KEY fallback; grok-4.3 / grok-build recommended with /login grok-build)" })),
        system: Type.Optional(Type.String({ description: "System/developer instruction" })),
        previousResponseId: Type.Optional(
          Type.String({ description: "Previous response ID for conversation continuity" }),
        ),
        maxOutputTokens: Type.Optional(Type.Number({ description: "Max output tokens" })),
        temperature: Type.Optional(Type.Number({ description: "Sampling temperature" })),
        store: Type.Optional(Type.Boolean({ description: "Store response server-side for 30 days (default: true)" })),
        include: Type.Optional(Type.Array(Type.String(), { description: "Additional data to include, e.g. reasoning.encrypted_content" })),
        tools: Type.Optional(Type.Array(Type.String(), { description: "Built-in tools to enable: web_search, x_search, code_execution, collections_search" })),
        responseFormat: Type.Optional(Type.String({ description: "JSON schema string for structured output" })),
        timeout: Type.Optional(Type.Number({ description: "Request timeout in ms (default 300000, reasoning models need 3600000)" })),
      }),
      async execute(_toolCallId, params) {
        const { prompt, model, system, previousResponseId, maxOutputTokens, temperature, store, include, tools, responseFormat, timeout } = params;
        const { apiKey, config } = await createRuntime();
        const input: Array<{ role: "user" | "developer"; content: string }> = [];
        if (system) {
          input.push({ role: "developer", content: system });
        }
        input.push({ role: "user", content: prompt });

        const mappedTools = tools?.map((t: string) => ({ type: t }));
        let parsedFormat: { type: "json_schema"; json_schema: { name: string; schema: Record<string, unknown>; strict?: boolean } } | undefined;
        if (responseFormat) {
          try {
            const schema = JSON.parse(responseFormat) as Record<string, unknown>;
            parsedFormat = { type: "json_schema", json_schema: { name: "response", schema, strict: true } };
          } catch {
            throw new Error("responseFormat must be valid JSON schema string");
          }
        }

        const effectiveTimeout = timeout ?? (model?.includes("reasoning") ? 3_600_000 : 300_000);
        const modelToUse = model || "grok-4";

        const body: Record<string, unknown> = { model: modelToUse, input };
        if (previousResponseId) body.previous_response_id = previousResponseId;
        if (maxOutputTokens !== undefined) body.max_output_tokens = maxOutputTokens;
        if (temperature !== undefined) body.temperature = temperature;
        if (store !== undefined) body.store = store;
        if (include?.length) body.include = include;
        if (mappedTools?.length) body.tools = mappedTools;
        if (parsedFormat) body.text = { format: parsedFormat };

        const url = `${config.xai.baseUrl.replace(/\/+$/, "")}/responses`;
        const init: RequestInit = {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify(body),
        };
        if (effectiveTimeout) (init as any).signal = AbortSignal.timeout(effectiveTimeout);

        const res = await fetch(url, init);
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          const err = new Error(`xAI API error: ${res.status} ${text.slice(0, 500)}`);
          if (res.status === 401) (err as any).reloginRequired = true;
          throw err;
        }
        const result = await res.json();

        return textResult(formatResponseSummary(result, "xAI Response"));
      },
    }),
  );

  api.registerTool(
    defineTool({
      name: "xai_multi_agent",
      label: "xAI Multi-Agent Research",
      description:
        "Deep research via xAI Coding Plan models (grok-build / grok-4.3). Orchestrates multiple agents with built-in tools (web_search, x_search). Note: the special 'grok-build' model does not accept explicit reasoningEffort (it uses maximum reasoning internally).",
      parameters: Type.Object({
        prompt: Type.String({ description: "Research query / question" }),
        reasoningEffort: Type.Optional(Type.Union([
          Type.Literal("low"),
          Type.Literal("medium"),
          Type.Literal("high"),
          Type.Literal("xhigh"),
        ], { description: "low/medium=4 agents, high/xhigh=16 agents" })),
        tools: Type.Optional(Type.Array(Type.String(), { description: "Built-in tools: web_search, x_search, code_execution, collections_search" })),
        previousResponseId: Type.Optional(Type.String({ description: "Continue previous multi-agent conversation" })),
        store: Type.Optional(Type.Boolean({ description: "Store response server-side" })),
        include: Type.Optional(Type.Array(Type.String(), { description: "Include verbose_streaming or reasoning.encrypted_content" })),
        timeout: Type.Optional(Type.Number({ description: "Timeout in ms (default 3600000)" })),
      }),
      async execute(_toolCallId, params, _signal, onUpdate) {
        const { prompt, reasoningEffort, tools, previousResponseId, store, include, timeout } = params;
        const { apiKey, config } = await createRuntime();
        const agentCount = reasoningEffort === "high" || reasoningEffort === "xhigh" ? 16 : 4;
        
        onUpdate?.({
          content: [{ type: "text" as const, text: `🔬 Starting multi-agent research with ${agentCount} agents...` }],
          details: `research-start: ${agentCount} agents`,
        });

        const input = [{ role: "user" as const, content: prompt }];
        const mappedTools = tools?.map((t: string) => ({ type: t }));

        const body: Record<string, unknown> = { model: "grok-4.20-multi-agent", input };
        if (reasoningEffort) {
          body.reasoning = { effort: reasoningEffort };
        }
        if (previousResponseId) body.previous_response_id = previousResponseId;
        if (mappedTools?.length) body.tools = mappedTools;
        if (store !== undefined) body.store = store;
        if (include?.length) body.include = include;

        const effectiveTimeout = timeout ?? 3_600_000;
        const url = `${config.xai.baseUrl.replace(/\/+$/, "")}/responses`;
        const init: RequestInit = {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify(body),
        };
        if (effectiveTimeout) (init as any).signal = AbortSignal.timeout(effectiveTimeout);

        const res = await fetch(url, init);
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          const err = new Error(`xAI API error: ${res.status} ${text.slice(0, 500)}`);
          if (res.status === 401) (err as any).reloginRequired = true;
          throw err;
        }
        const result = await res.json();
        
        onUpdate?.({
          content: [{ type: "text" as const, text: `✅ Research complete. ${result.usage?.output_tokens ?? "?"} output tokens (${result.usage?.output_tokens_details?.reasoning_tokens ?? 0} reasoning).` }],
          details: `research-done: ${result.id}`,
        });

        return textResult(formatResponseSummary(result, "xAI Multi-Agent"));
      },
    }),
  );

}
