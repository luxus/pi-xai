import { defineTool, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { XaiClient } from "./xai-client.ts";
import {
  getRequiredXaiApiKey,
  resolveXaiConfig,
  getAgenticConfig,
  type ResolvedXaiConfig,
} from "./xai-config.ts";
import { registerXaiProvider } from "./xai-provider.ts";
import {
  getEffectiveXaiApiKey,
  readGrokCliAuth,
  autoImportGrokCliIfNeeded,
} from "./xai-oauth.ts";
import {
  DEFAULT_XAI_TEXT_MODEL,
  summarizeError,
  type XaiTextLogger,
} from "./xai-text-shared.ts";
import {
  generateMultiAgentWithXai,
  generateResponseWithXai,
  type MultiAgentResult,
  type XaiResponseResult,
  type XaiTool,
} from "./xai-text.ts";

function createLogger(): XaiTextLogger {
  return console;
}

async function createRuntime(log = createLogger()): Promise<{
  apiKey: string;
  apiKeySource: string;
  config: ResolvedXaiConfig;
  client: XaiClient;
  log: XaiTextLogger;
}> {
  // Full resolution: env > Pi auth.json (including oauth + auto-refresh) > grok-cli file > settings
  const effective = await getEffectiveXaiApiKey();
  if (!effective?.apiKey) {
    // Fall back to the legacy sync path (will throw with a message suggesting /login grok-build)
    const legacy = getRequiredXaiApiKey();
    return {
      apiKey: legacy.apiKey,
      apiKeySource: legacy.source,
      config: legacy.config,
      client: new XaiClient({ apiKey: legacy.apiKey, baseUrl: legacy.config.xai.baseUrl, log }),
      log,
    };
  }

  const config = resolveXaiConfig();
  return {
    apiKey: effective.apiKey,
    apiKeySource: effective.source,
    config,
    client: new XaiClient({ apiKey: effective.apiKey, baseUrl: config.xai.baseUrl, log }),
    log,
  };
}

function citationsSummary(citations: string[] | undefined): string {
  if (!citations?.length) return "";
  const lines = citations.map((url, i) => `${i + 1}. ${url}`);
  return `\n\n**Sources consulted**\n${lines.join("\n")}`;
}

function responseSummary(result: XaiResponseResult): string {
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
  const body = [text, toolCallText].filter(Boolean).join("\n\n");
  return `**xAI Response** (${result.model})\n\n${body || "(no text output)"}\n\n${usage}${reasoning}${citationsSummary(result.citations)}`;
}

function multiAgentSummary(result: MultiAgentResult): string {
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
  return `**xAI Multi-Agent** (${result.model})\n\n${body || "(no text output)"}\n\n${usage}${reasoning}${tools}${citationsSummary(result.citations)}`;
}

function textResult(text: string): { content: Array<{ type: "text"; text: string }>; details: string } {
  return { content: [{ type: "text" as const, text }], details: text };
}

export default async function (api: ExtensionAPI) {
  // Auto-import any existing Grok CLI credentials from ~/.grok/auth.json (if present)
  // into the "grok-build" slot. This is a convenience only — the primary way to
  // authenticate is the native `/login grok-build` OAuth flow (no binary needed).
  await autoImportGrokCliIfNeeded();

  // Override built-in xAI provider with Responses API support + Grok Build OAuth
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
        model: Type.Optional(Type.String({ description: "Model override (default: grok-4, reasoning: grok-4.20-reasoning)" })),
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
        const { client, log } = await createRuntime();
        const input: Array<{ role: "user" | "developer"; content: string }> = [];
        if (system) {
          input.push({ role: "developer", content: system });
        }
        input.push({ role: "user", content: prompt });

        const mappedTools = tools?.map((t: string) => ({ type: t as XaiTool["type"] }));
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

        const result = await generateResponseWithXai(
          client,
          {
            model: model || DEFAULT_XAI_TEXT_MODEL,
            input,
            previousResponseId,
            maxOutputTokens,
            temperature,
            store,
            include,
            tools: mappedTools,
            responseFormat: parsedFormat,
            timeout: effectiveTimeout,
          },
          log,
        );
        return textResult(responseSummary(result));
      },
    }),
  );

  api.registerTool(
    defineTool({
      name: "xai_multi_agent",
      label: "xAI Multi-Agent Research",
      description:
        "Deep research via xAI grok-4.20-multi-agent. Orchestrates 4 or 16 agents with built-in tools (web_search, x_search). Use reasoningEffort high/xhigh for 16 agents, low/medium for 4 agents.",
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
        const { client, log } = await createRuntime();
        const agentCount = reasoningEffort === "high" || reasoningEffort === "xhigh" ? 16 : 4;
        
        onUpdate?.({
          content: [{ type: "text" as const, text: `🔬 Starting multi-agent research with ${agentCount} agents...` }],
          details: `research-start: ${agentCount} agents`,
        });

        const input = [{ role: "user" as const, content: prompt }];
        const mappedTools = tools?.map((t: string) => ({ type: t as XaiTool["type"] }));

        const result = await generateMultiAgentWithXai(
          client,
          {
            input,
            reasoningEffort: reasoningEffort || "medium",
            tools: mappedTools,
            previousResponseId,
            store,
            include,
            timeout: timeout ?? 3_600_000,
          },
          log,
        );
        
        onUpdate?.({
          content: [{ type: "text" as const, text: `✅ Research complete. ${result.usage?.output_tokens ?? "?"} output tokens (${result.usage?.output_tokens_details?.reasoning_tokens ?? 0} reasoning).` }],
          details: `research-done: ${result.id}`,
        });

        return textResult(multiAgentSummary(result));
      },
    }),
  );

  api.registerTool(
    defineTool({
      name: "xai_web_search",
      label: "xAI Web Search",
      description: "Search the web via xAI's built-in web_search tool. Returns search results with citations.",
      parameters: Type.Object({
        query: Type.String({ description: "Search query" }),
      }),
      async execute(_toolCallId, params) {
        const { query } = params;
        const { client, log } = await createRuntime();
        const result = await generateResponseWithXai(
          client,
          {
            model: DEFAULT_XAI_TEXT_MODEL,
            input: [{ role: "user", content: query }],
            tools: [{ type: "web_search" }],
          },
          log,
        );
        return textResult(responseSummary(result));
      },
    }),
  );

  api.registerTool(
    defineTool({
      name: "xai_code_execution",
      label: "xAI Code Execution",
      description: "Execute Python code in xAI's sandbox via the code_execution built-in tool. Returns execution output with any generated files or plots.",
      parameters: Type.Object({
        code: Type.String({ description: "Python code to execute" }),
        language: Type.Optional(Type.Literal("python", { description: "Programming language (only python supported)" })),
      }),
      async execute(_toolCallId, params) {
        const { code } = params;
        const { client, log } = await createRuntime();
        const result = await generateResponseWithXai(
          client,
          {
            model: DEFAULT_XAI_TEXT_MODEL,
            input: [{ role: "user", content: `Execute this code:\n\n\`\`\`python\n${code}\n\`\`\`` }],
            tools: [{ type: "code_execution" }],
          },
          log,
        );
        return textResult(responseSummary(result));
      },
    }),
  );

  api.registerTool(
    defineTool({
      name: "xai_collections_search",
      label: "xAI Collections Search",
      description: "Query uploaded document collections via xAI's collections_search built-in tool.",
      parameters: Type.Object({
        query: Type.String({ description: "Search query for the collection" }),
        collectionIds: Type.Optional(Type.Array(Type.String(), { description: "Collection IDs to search (if omitted, searches default collections)" })),
      }),
      async execute(_toolCallId, params) {
        const { query, collectionIds } = params;
        const { client, log } = await createRuntime();
        const result = await generateResponseWithXai(
          client,
          {
            model: DEFAULT_XAI_TEXT_MODEL,
            input: [{ role: "user", content: query }],
            tools: [{ type: "collections_search" }],
          },
          log,
        );
        return textResult(responseSummary(result));
      },
    }),
  );
}
