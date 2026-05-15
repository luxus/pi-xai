# Ollama Custom Provider Extension for pi

This extension connects pi to a local or internal Ollama server using its OpenAI-compatible API.

## Features

- ✅ OpenAI-compatible API (uses `/v1/chat/completions` endpoint)
- ✅ Configurable base URL (for local or internal servers)
- ✅ No authentication required (optional API key support)
- ✅ Pre-configured with popular Ollama models
- ✅ Uses built-in `streamSimpleOpenAICompletions` from `@mariozechner/pi-ai`

## Usage

### Basic (Local Ollama)

```bash
# Start Ollama locally (default: http://localhost:11434)
ollama serve

# Run pi with the extension
pi -e ./custom-provider-ollama

# Select a model
/model ollama-custom/llama3.2
```

### With Custom Server

```bash
# Point to an internal Ollama server
OLLAMA_BASE_URL=http://ollama.internal:11434/v1 pi -e ./custom-provider-ollama
```

### With Authentication (if your Ollama requires it)

```bash
OLLAMA_BASE_URL=https://ollama.company.com/v1 \
OLLAMA_API_KEY=your-api-key \
pi -e ./custom-provider-ollama
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `OLLAMA_BASE_URL` | Ollama server base URL | `http://localhost:11434/v1` |
| `OLLAMA_API_KEY` | Optional API key for authentication | (none) |

## Pre-configured Models

The extension includes these popular Ollama models:

- `llama3.2` - Llama 3.2 (latest, 3B params)
- `llama3.1` - Llama 3.1 (8B params)
- `llama3.1:70b` - Llama 3.1 (70B params, reasoning)
- `qwen2.5-coder:14b` - Qwen 2.5 Coder (14B, reasoning)
- `qwen2.5-coder:32b` - Qwen 2.5 Coder (32B, reasoning)
- `mistral` - Mistral 7B
- `codellama` - CodeLlama (code-focused)
- `deepseek-coder-v2` - DeepSeek Coder V2 (reasoning)
- `phi4` - Microsoft Phi-4 (reasoning)
- `gemma2` - Google Gemma 2

To add more models, edit the `models` array in `index.ts`.

## How It Works

This extension:

1. Registers a provider named `ollama-custom` with pi
2. Uses the `openai-completions` API type (Ollama is OpenAI-compatible)
3. Delegates streaming to the built-in `streamSimpleOpenAICompletions` helper
4. Overrides the `baseUrl` to point to your Ollama server

The built-in helper handles:
- Message format conversion
- Tool calling
- Streaming responses
- Usage tracking

## Troubleshooting

### Connection refused

Make sure Ollama is running:
```bash
ollama serve
```

Or check your custom URL:
```bash
curl $OLLAMA_BASE_URL/models
```

### Model not found

Pull the model first:
```bash
ollama pull llama3.2
```

## License

MIT
