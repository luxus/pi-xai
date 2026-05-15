/**
 * xAI Native Provider Extension (example)
 *
 * Provides native xAI Responses API streaming (not OpenAI compatible).
 *
 * Auth: supports XAI_API_KEY, Pi auth.json, and auto-detection of ~/.grok/auth.json.
 * For the best Grok Build experience with native OAuth (`/login grok-build`), use the main pi-xai-text extension instead.
 */

import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	calculateCost,
	createAssistantMessageEventStream,
	type Model,
	type SimpleStreamOptions,
	type StopReason,
	type TextContent,
	type ToolCall,
	type ToolResultMessage,
} from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { XaiClient } from "../xai-client.ts";
import { resolveXaiConfig } from "../xai-config.ts";
import { XAI_API_BASE } from "../xai-text-shared.ts";
import type { XaiResponseMessage, XaiTool } from "../xai-text.ts";

// =============================================================================
// Native xAI Types
// =============================================================================

interface XaiResponseStreamEvent {
	id?: string;
	object?: string;
	created?: number;
	model?: string;
	type?: string;
	delta?: {
		type?: string;
		text?: string;
		role?: string;
		content?: Array<{
			type?: string;
			text?: string;
			id?: string;
			name?: string;
			arguments?: string;
			call_id?: string;
			output?: string;
		}];
	};
	output?: Array<{
		type?: string;
		role?: string;
		content?: Array<{
			type?: string;
			text?: string;
		};
	}>;
	usage?: {
		input_tokens?: number;
		output_tokens?: number;
		total_tokens?: number;
		output_tokens_details?: {
			reasoning_tokens?: number;
		};
	};
	error?: {
		message?: string;
	};
}

// =============================================================================
// Message Conversion
// =============================================================================

function convertMessages(context: Context): XaiResponseMessage[] {
	const messages: XaiResponseMessage[] = [];

	// System prompt as developer message
	if (context.systemPrompt) {
		messages.push({ role: "developer", content: context.systemPrompt });
	}

	// Convert conversation messages
	for (const msg of context.messages) {
		if (msg.role === "user") {
			if (typeof msg.content === "string") {
				if (msg.content.trim()) {
					messages.push({ role: "user", content: msg.content });
				}
			} else {
				// Handle multi-modal content
				const textParts = msg.content
					.filter((c): c is { type: "text"; text: string } => c.type === "text")
					.map((c) => c.text)
					.join("\n");
				if (textParts.trim()) {
					messages.push({ role: "user", content: textParts });
				}
				// Note: Images would need base64 handling for native API
			}
		} else if (msg.role === "assistant") {
			let content = "";
			for (const block of msg.content) {
				if (block.type === "text") {
					content += block.text;
				} else if (block.type === "thinking") {
					content += block.thinking;
				}
				// Note: toolCall blocks handled separately in xAI format
			}
			if (content.trim()) {
				messages.push({ role: "assistant", content });
			}
		} else if (msg.role === "toolResult") {
			// Convert tool results to user messages with context
			const content = msg.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("\n");
			if (content.trim()) {
				messages.push({ role: "user", content: `Tool result: ${content}` });
			}
		}
	}

	return messages;
}

function convertTools(tools: NonNullable<Context["tools"]>): XaiTool[] {
	return tools.map((tool) => ({
		type: "function",
		function: {
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters as Record<string, unknown>,
		},
	}));
}

function mapStopReason(reason: string | null | undefined): StopReason {
	switch (reason) {
		case "stop":
		case "end_turn":
			return "stop";
		case "max_tokens":
			return "length";
		case "tool_calls":
			return "toolUse";
		default:
			return "error";
	}
}

// =============================================================================
// Native xAI Streaming
// =============================================================================

function streamNativeXai(
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();

	(async () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: "xai-responses",
			provider: "xai-native",
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};

		try {
			const resolved = resolveXaiConfig();
			const apiKey = options?.apiKey || resolved.xai.apiKey || "";
			if (!apiKey) {
				throw new Error("No xAI credentials found. Run `/login grok-build` (native OAuth, no binary), set XAI_API_KEY, or configure xai.apiKey.");
			}

			const client = new XaiClient({
				apiKey,
				baseUrl: model.baseUrl || XAI_API_BASE,
			});

			const messages = convertMessages(context);
			const tools = context.tools?.length ? convertTools(context.tools) : undefined;

			// Build request body
			const body: Record<string, unknown> = {
				model: model.id,
				input: messages,
				stream: true,
			};

			if (options?.maxTokens) {
				body.max_output_tokens = options.maxTokens;
			}
			if (options?.temperature !== undefined) {
				body.temperature = options.temperature;
			}
			if (tools?.length) {
				body.tools = tools;
			}
			// Reasoning support for compatible models
			if (options?.reasoning && model.reasoning) {
				const effortMap: Record<string, string> = {
					minimal: "low",
					low: "low",
					medium: "medium",
					high: "high",
					xhigh: "high",
				};
				body.reasoning = { effort: effortMap[options.reasoning] || "medium" };
			}

			// Start streaming request
			const response = await fetch(`${client.baseUrl}/responses`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${apiKey}`,
				},
				body: JSON.stringify(body),
				signal: options?.signal,
			});

			if (!response.ok) {
				const errorText = await response.text();
				throw new Error(`xAI API error: ${response.status} ${errorText.slice(0, 500)}`);
			}

			stream.push({ type: "start", partial: output });

			// Process SSE stream
			const reader = response.body?.getReader();
			if (!reader) {
				throw new Error("No response body");
			}

			const decoder = new TextDecoder();
			let buffer = "";
			let currentToolCall: (ToolCall & { partialArgs: string }) | null = null;

			while (true) {
				if (options?.signal?.aborted) {
					throw new Error("Request was aborted");
				}

				const { done, value } = await reader.read();
				if (done) break;

				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";

				for (const line of lines) {
					if (!line.trim() || !line.startsWith("data: ")) continue;

					const data = line.slice(6);
					if (data === "[DONE]") continue;

					try {
						const event = JSON.parse(data) as XaiResponseStreamEvent;

						// Handle content deltas
						if (event.delta?.type === "text_delta" && event.delta.text) {
							// Check if we have an existing text block
							const lastBlock = output.content[output.content.length - 1];
							if (lastBlock?.type === "text") {
								lastBlock.text += event.delta.text;
								stream.push({
									type: "text_delta",
									contentIndex: output.content.length - 1,
									delta: event.delta.text,
									partial: output,
								});
							} else {
								output.content.push({ type: "text", text: event.delta.text });
								stream.push({
									type: "text_start",
									contentIndex: output.content.length - 1,
									partial: output,
								});
								stream.push({
									type: "text_delta",
									contentIndex: output.content.length - 1,
									delta: event.delta.text,
									partial: output,
								});
							}
						}

						// Handle tool calls
						if (event.delta?.type === "tool_call_delta") {
							const toolContent = event.delta.content?.[0];
							if (toolContent?.type === "tool_call_arguments_delta" && toolContent.arguments) {
								if (!currentToolCall) {
									// Try to find existing tool call to continue
									const lastTool = output.content[output.content.length - 1];
									if (lastTool?.type === "toolCall") {
										currentToolCall = {
											...lastTool,
											partialArgs: JSON.stringify(lastTool.arguments),
										};
									} else {
										// Start new tool call
										currentToolCall = {
											type: "toolCall",
											id: toolContent.call_id || `call_${Date.now()}`,
											name: toolContent.name || "unknown",
											arguments: {},
											partialArgs: "",
										};
										output.content.push(currentToolCall);
										stream.push({
											type: "toolcall_start",
											contentIndex: output.content.length - 1,
											partial: output,
										});
									}
								}
								if (currentToolCall) {
									currentToolCall.partialArgs += toolContent.arguments;
									try {
										currentToolCall.arguments = JSON.parse(currentToolCall.partialArgs);
									} catch {
										// Partial JSON, keep accumulating
									}
									stream.push({
										type: "toolcall_delta",
										contentIndex: output.content.indexOf(currentToolCall),
										delta: toolContent.arguments,
										partial: output,
									});
								}
							}
						}

						// Handle usage updates
						if (event.usage) {
							output.usage.input = event.usage.input_tokens || 0;
							output.usage.output = event.usage.output_tokens || 0;
							output.usage.totalTokens = event.usage.total_tokens || 0;
							calculateCost(model, output.usage);
						}

						// Handle stop reason from output completion
						if (event.type === "response.completed" && event.output) {
							// Finalize any tool calls
							if (currentToolCall) {
								try {
									currentToolCall.arguments = JSON.parse(currentToolCall.partialArgs);
								} catch {
									// Keep partial if parse fails
								}
								delete (currentToolCall as { partialArgs?: string }).partialArgs;
								stream.push({
									type: "toolcall_end",
									contentIndex: output.content.indexOf(currentToolCall),
									toolCall: currentToolCall,
									partial: output,
								});
								currentToolCall = null;
							}
						}
					} catch (e) {
						// Skip malformed events
					}
				}
			}

			// Finalize
			if (options?.signal?.aborted) {
				throw new Error("Request was aborted");
			}

			output.stopReason = "stop";
			stream.push({ type: "done", reason: "stop", message: output });
			stream.end();
		} catch (error) {
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
}

// =============================================================================
// Extension Entry Point
// =============================================================================

export default function (pi: ExtensionAPI) {
	pi.registerProvider("xai-native", {
		baseUrl: XAI_API_BASE,
		apiKey: "XAI_API_KEY",
		api: "xai-responses", // Native xAI API, NOT OpenAI-compatible

		models: [
			{
				id: "grok-4",
				name: "Grok 4 (Native)",
				reasoning: false,
				input: ["text", "image"],
				cost: { input: 3.0, output: 15.0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 131072,
				maxTokens: 16384,
			},
			{
				id: "grok-4-fast",
				name: "Grok 4 Fast (Native)",
				reasoning: false,
				input: ["text"],
				cost: { input: 2.0, output: 10.0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 131072,
				maxTokens: 16384,
			},
			{
				id: "grok-4.20-reasoning",
				name: "Grok 4.20 Reasoning (Native)",
				reasoning: true,
				input: ["text", "image"],
				cost: { input: 3.0, output: 15.0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 131072,
				maxTokens: 32768,
			},
			{
				id: "grok-4.20-multi-agent",
				name: "Grok 4.20 Multi-Agent (Native)",
				reasoning: true,
				input: ["text"],
				cost: { input: 5.0, output: 25.0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 131072,
				maxTokens: 32768,
			},
			{
				id: "grok-3-mini",
				name: "Grok 3 Mini (Native)",
				reasoning: true,
				input: ["text"],
				cost: { input: 0.5, output: 2.0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 65536,
				maxTokens: 8192,
			},
		],

		// Native xAI streaming - NOT using OpenAI compatibility
		streamSimple: streamNativeXai,
	});

	console.log("[xai-native] Registered native xAI Responses API provider");
}
