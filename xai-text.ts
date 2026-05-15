import { XaiClient, type XaiClientOptions } from "./xai-client.ts";
import { summarizeError, type XaiTextLogger } from "./xai-text-shared.ts";

// --- Shared Types ---

export interface XaiResponseMessage {
  role: "user" | "assistant" | "system" | "developer";
  content: string;
}

export interface XaiTool {
  type: "web_search" | "x_search" | "code_execution" | "collections_search" | "function";
  function?: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface XaiResponseFormat {
  type: "json_schema";
  json_schema: {
    name: string;
    schema: Record<string, unknown>;
    strict?: boolean;
  };
}

// --- Responses API ---

export interface GenerateResponseOptions {
  model?: string;
  input: XaiResponseMessage[];
  previousResponseId?: string;
  maxOutputTokens?: number;
  temperature?: number;
  topP?: number;
  store?: boolean;
  stream?: boolean;
  include?: string[];
  tools?: XaiTool[];
  responseFormat?: XaiResponseFormat;
  timeout?: number;
}

export interface XaiAnnotation {
  type: "url_citation";
  url: string;
  start_index?: number;
  end_index?: number;
  title?: string;
}

export interface XaiResponseOutputText {
  type: "output_text";
  text: string;
  annotations?: XaiAnnotation[];
}

export interface XaiResponseOutputMessage {
  type: "message";
  role: "assistant";
  content: Array<{ type: string; text?: string; [key: string]: unknown }>;
}

export interface XaiResponseUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  output_tokens_details?: {
    reasoning_tokens?: number;
  };
}

export interface XaiResponseResult {
  id: string;
  model: string;
  output: Array<{ type: string; [key: string]: unknown }>;
  usage?: XaiResponseUsage;
  citations?: string[];
}

export async function generateResponseWithXai(
  apiKey: string | XaiClient,
  options: GenerateResponseOptions,
  log?: XaiTextLogger,
): Promise<XaiResponseResult> {
  const client = apiKey instanceof XaiClient ? apiKey : new XaiClient({ apiKey, log });
  const body: Record<string, unknown> = {
    model: options.model || "grok-4",
    input: options.input,
  };
  if (options.previousResponseId) body.previous_response_id = options.previousResponseId;
  if (options.maxOutputTokens !== undefined) body.max_output_tokens = options.maxOutputTokens;
  if (options.temperature !== undefined) body.temperature = options.temperature;
  if (options.topP !== undefined) body.top_p = options.topP;
  if (options.store !== undefined) body.store = options.store;
  if (options.stream !== undefined) body.stream = options.stream;
  if (options.include?.length) body.include = options.include;
  if (options.tools?.length) body.tools = options.tools;
  if (options.responseFormat) body.text = { format: options.responseFormat };

  const init: RequestInit = { method: "POST", body: JSON.stringify(body) };
  if (options.timeout) init.signal = AbortSignal.timeout(options.timeout);

  try {
    const result = await client.fetchJson<XaiResponseResult>("/responses", init);
    log?.info?.(`[xai-text] response ${result.id} via ${result.model}`);
    return result;
  } catch (error) {
    log?.error?.(`[xai-text] generateResponse failed: ${summarizeError(error)}`);
    throw error;
  }
}

// --- Multi-Agent ---

export interface MultiAgentOptions {
  model?: string;
  input: XaiResponseMessage[];
  previousResponseId?: string;
  reasoningEffort?: "low" | "medium" | "high" | "xhigh";
  tools?: XaiTool[];
  store?: boolean;
  stream?: boolean;
  include?: string[];
  timeout?: number;
}

export interface MultiAgentResult extends XaiResponseResult {
  server_side_tool_usage?: Record<string, number>;
}

export async function generateMultiAgentWithXai(
  apiKey: string | XaiClient,
  options: MultiAgentOptions,
  log?: XaiTextLogger,
): Promise<MultiAgentResult> {
  const client = apiKey instanceof XaiClient ? apiKey : new XaiClient({ apiKey, log });
  const body: Record<string, unknown> = {
    model: options.model || "grok-4.20-multi-agent",
    input: options.input,
  };
  if (options.reasoningEffort) {
    body.reasoning = { effort: options.reasoningEffort };
  }
  if (options.previousResponseId) body.previous_response_id = options.previousResponseId;
  if (options.tools?.length) body.tools = options.tools;
  if (options.store !== undefined) body.store = options.store;
  if (options.stream !== undefined) body.stream = options.stream;
  if (options.include?.length) body.include = options.include;

  const init: RequestInit = { method: "POST", body: JSON.stringify(body) };
  if (options.timeout) init.signal = AbortSignal.timeout(options.timeout);

  try {
    const result = await client.fetchJson<MultiAgentResult>("/responses", init);
    log?.info?.(`[xai-text] multi-agent ${result.id} via ${result.model}`);
    return result;
  } catch (error) {
    log?.error?.(`[xai-text] multiAgent failed: ${summarizeError(error)}`);
    throw error;
  }
}


