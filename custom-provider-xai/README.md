# xAI Native Provider Extension for pi

**Native xAI Responses API** - NOT OpenAI-compatible. Uses the native `/responses` endpoint with proper streaming support.

## Difference from Built-in xAI Provider

| Feature | Built-in `xai` | This `xai-native` |
|---------|---------------|-------------------|
| API | OpenAI-compatible | **Native xAI** |
| Endpoint | `/v1/chat/completions` | `/responses` |
| Streaming | OpenAI format | **Native xAI SSE** |
| Tool calling | OpenAI format | **Native xAI format** |
| Reasoning | Limited | **Full support** |
| Multi-agent | Not available | **Available** |

## Usage

```bash
# Set your API key
export XAI_API_KEY="your-api-key"

# Run with the extension
pi -e ./custom-provider-xai

# Select a model
/model xai-native/grok-4
```

## Models Available

- `grok-4` - Grok 4 (text + image)
- `grok-4-fast` - Grok 4 Fast (text only, faster)
- `grok-4.20-reasoning` - Grok 4.20 with reasoning
- `grok-4.20-multi-agent` - Multi-agent research mode
- `grok-3-mini` - Smaller, faster model with reasoning

## Features

✅ Native xAI `/responses` endpoint  
✅ Server-sent events (SSE) streaming  
✅ Tool calling with native format  
✅ Reasoning support (`reasoning.effort`)  
✅ Multi-modal (text + image)  
✅ Conversation continuity (`previous_response_id`)  

## How It Works

This extension:

1. Registers a custom provider `xai-native` with API type `xai-responses`
2. Implements custom `streamSimple` function using native xAI client
3. Calls `/responses` endpoint directly (NOT `/v1/chat/completions`)
4. Parses native xAI SSE format (different from OpenAI)
5. Converts to pi's internal event stream format

The native API provides:
- Better reasoning visibility
- Multi-agent orchestration
- Native tool integration
- xAI-specific features

## Authentication

Native OAuth (no grok binary required) + optional detection of existing `~/.grok/auth.json`:

```bash
/login grok-build     # Recommended — native OAuth inside Pi (works without any CLI)
/login xai            # For regular console API key usage
```

Existing `~/.grok/auth.json` (from official `grok login`) is auto-detected as a bonus.

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `XAI_API_KEY` | No (if native login or grok CLI present) | Your xAI API key (fallback) |

## Troubleshooting

### API key errors

```bash
# Verify your key is set
echo $XAI_API_KEY

# Test the API directly
curl https://api.x.ai/v1/models \
  -H "Authorization: Bearer $XAI_API_KEY"
```

### Model not found

Check available models:
```bash
curl https://api.x.ai/v1/models \
  -H "Authorization: Bearer $XAI_API_KEY" | jq '.data[].id'
```

## License

MIT
