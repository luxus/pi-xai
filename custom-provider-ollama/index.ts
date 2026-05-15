/**
 * Ollama Custom Provider Extension
 *
 * Provides access to local Ollama servers via OpenAI-compatible API.
 * Supports configurable base URL and custom model definitions.
 *
 * Usage:
 *   pi -e ./custom-provider-ollama
 *   # Or with environment variables:
 *   OLLAMA_BASE_URL=http://ollama.internal:11434/v1 pi -e ./custom-provider-ollama
 *
 * Then use /model to select your Ollama models (e.g., ollama-custom/llama3.2)
 */

import {
	type Api,
	type AssistantMessageEventStream,
	type Context,
	type Model,
	type SimpleStreamOptions,
	streamSimpleOpenAICompletions,
} from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

// =============================================================================
// Configuration
// =============================================================================

const DEFAULT_OLLAMA_URL = "http://localhost:11434/v1";

function getOllamaBaseUrl(): string {
	return process.env.OLLAMA_BASE_URL || DEFAULT_OLLAMA_URL;
}

// =============================================================================
// Stream Function
// =============================================================================

function streamOllama(
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	// Override the baseUrl to point to the Ollama server
	const ollamaModel: Model<"openai-completions"> = {
		...model,
		api: "openai-completions",
		baseUrl: getOllamaBaseUrl(),
		provider: "ollama-custom",
	};

	// Pass through to the built-in OpenAI completions stream
	// Ollama doesn't need authentication for local/internal use,
	// but we can pass an apiKey if provided
	return streamSimpleOpenAICompletions(ollamaModel, context, {
		...options,
		// Ollama uses the OpenAI-compatible endpoint, no auth header needed
		// If you need auth, set OLLAMA_API_KEY env var
		apiKey: options?.apiKey || process.env.OLLAMA_API_KEY || "ollama",
	});
}

// =============================================================================
// Extension Entry Point
// =============================================================================

export default function (pi: ExtensionAPI) {
	const baseUrl = getOllamaBaseUrl();

	pi.registerProvider("ollama-custom", {
		baseUrl,
		apiKey: "OLLAMA_API_KEY", // Optional - only needed if your Ollama requires auth
		api: "openai-completions",

		// Define common Ollama models - add more as needed
		// Users can override via OLLAMA_MODELS env var if they want different models
		models: [
			{
				id: "llama3.2",
				name: "Llama 3.2 (Ollama)",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, // Local = free
				contextWindow: 131072,
				maxTokens: 8192,
			},
			{
				id: "llama3.1",
				name: "Llama 3.1 (Ollama)",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 131072,
				maxTokens: 8192,
			},
			{
				id: "llama3.1:70b",
				name: "Llama 3.1 70B (Ollama)",
				reasoning: true,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 131072,
				maxTokens: 8192,
			},
			{
				id: "qwen2.5-coder:14b",
				name: "Qwen 2.5 Coder 14B (Ollama)",
				reasoning: true,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 131072,
				maxTokens: 8192,
			},
			{
				id: "qwen2.5-coder:32b",
				name: "Qwen 2.5 Coder 32B (Ollama)",
				reasoning: true,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 131072,
				maxTokens: 8192,
			},
			{
				id: "mistral",
				name: "Mistral (Ollama)",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 32768,
				maxTokens: 8192,
			},
			{
				id: "codellama",
				name: "CodeLlama (Ollama)",
				reasoning: true,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 16384,
				maxTokens: 4096,
			},
			{
				id: "deepseek-coder-v2",
				name: "DeepSeek Coder V2 (Ollama)",
				reasoning: true,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 8192,
			},
			{
				id: "phi4",
				name: "Phi-4 (Ollama)",
				reasoning: true,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 16384,
				maxTokens: 4096,
			},
			{
				id: "gemma2",
				name: "Gemma 2 (Ollama)",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 8192,
				maxTokens: 4096,
			},
		],

		// No OAuth for internal Ollama - it's local/self-hosted
		// If you need auth, you can set OLLAMA_API_KEY

		streamSimple: streamOllama,
	});

	// Log that we've registered the provider
	console.log(`[ollama-custom] Registered with baseUrl: ${baseUrl}`);
}
