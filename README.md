# pi-xai-text

Pi extension for xAI text generation via Responses and Chat Completions API.

## Features

- **xAI Provider Override** — Replaces the built-in `xai` provider with Responses API support. Enables `/model` → `grok-4`, `grok-4.20-reasoning`, `grok-4.20-multi-agent` with stateful conversations, reasoning, and multi-agent research.
- **Responses API** (`xai_generate_text`) — Stateful conversations, reasoning models, structured outputs, built-in tools, server-side storage.
- **Multi-Agent Research** (`xai_multi_agent`) — Deep research with `grok-4.20-multi-agent`. 4 or 16 collaborating agents with web search, X search, code execution. Shows progress updates during research.

## Provider Models

This extension overrides the built-in `xai` provider. After install, these models are available via `/model`:

| Model | Type | Context | Max Tokens |
|-------|------|---------|-----------|
| `grok-4` | General | 131K | 16K |
| `grok-4-1-fast` | Fast | 131K | 16K |
| `grok-4.20-reasoning` | Reasoning | 131K | 32K |
| `grok-4.20-multi-agent` | Multi-Agent | 131K | 32K |
| `grok-3-mini` | Mini | 65K | 8K |

## Tools

| Tool | Description |
|------|-------------|
| `xai_generate_text` | Generate text via Responses API. Supports reasoning models (`grok-4.20-reasoning`), structured JSON output, built-in tools (`web_search`, `x_search`, `code_execution`), `previousResponseId`, `store`, `include`, custom timeout. Returns citations when tools are used. |
| `xai_multi_agent` | Deep research via multi-agent model. `reasoningEffort` controls agent count (low/medium=4, high/xhigh=16). Shows live progress updates. Supports built-in tools and multi-turn via `previousResponseId`. Returns citations. |
| `xai_web_search` | Web search via xAI's built-in `web_search` tool. Returns results with citations. Works with any pi model. |
| `xai_x_search` | X/Twitter search via xAI's built-in `x_search` tool. Returns posts and trends. Works with any pi model. |
| `xai_code_execution` | Execute Python code in xAI's sandbox via `code_execution` tool. Returns output and generated files. Works with any pi model. |
| `xai_collections_search` | Query uploaded document collections via `collections_search` tool. Works with any pi model. |

## Agentic Mode

When an xAI model (e.g. `grok-4.20-reasoning`) is active via `/model`, built-in tools are **automatically injected** into every request. The model decides autonomously when to search the web, browse X, or execute code — just like native xAI agentic behavior.

**Enabled by default.** All built-in tools: `web_search`, `x_search`, `code_execution`, `collections_search`.

### Disable Agentic Mode

```json
{
  "xai": {
    "text": {
      "agentic": false
    }
  }
}
```

### Select Specific Tools Only

```json
{
  "xai": {
    "text": {
      "agentic": true,
      "agenticTools": ["web_search", "x_search"]
    }
  }
}
```

Available tools: `web_search`, `x_search`, `code_execution`, `collections_search`.

### How It Works

- Select an xAI model via `/model` → `xai` → `grok-4.20-reasoning`
- Ask anything — "What are the latest updates from xAI?"
- The model autonomously decides to use `web_search`, gets results, cites sources
- Citations appear inline (`[[1]](url)`) and in the Sources footer
- No explicit tool calls needed — the model orchestrates itself

## Config

### Two xAI Providers (clear separation)

This extension registers **two** providers so you can easily tell which auth you're using:

| Provider       | Purpose                                              | Models available                          | Recommended for |
|----------------|------------------------------------------------------|-------------------------------------------|-----------------|
| `xai`          | General use + full model range                       | All Grok models (including fast/mini)     | When using your normal `XAI_API_KEY` (voice etc.) |
| `grok-build`   | **Focused high-power experience** (only the best)    | Only `grok-4.20-reasoning` + `grok-4.20-multi-agent` | When you want the Coding Plan subscription via native OAuth (`/login grok-build`) |

**Primary auth method (no binary required)**

Run this inside Pi:

```bash
/login grok-build
```

This performs a native OAuth login using the exact same public xAI client ID and endpoints as the official Grok CLI and desktop apps.  
**No `grok` binary is needed at all.**

After successful login:

- Use **`grok-build`** when you want the absolute best experience (Coding Plan)  
  → Only the two strongest models (`grok-4.20-reasoning` and `grok-4.20-multi-agent`)

- Use **`xai`** when you want the full range (including faster/cheaper models) or when using a regular console `XAI_API_KEY`

This separation keeps things clean.

### Subscriptions behavior (native OAuth)

- **`grok-build`** → **Appears** under Subscriptions / OAuth logins  
  (first-class native OAuth flow — run `/login grok-build`)

- **`xai`** → **Does NOT appear** under Subscriptions  
  (we intentionally removed the `oauth` block from the `xai` provider).  
  Your `XAI_API_KEY` stays as a normal API key in the separate API Keys section.

This gives you the clean separation you want.

You can still use the normal `xai` provider if you prefer:

```
/model xai/grok-4.20-multi-agent
```

**Credential priority (Grok Build / Coding Plan is preferred when available):**
1. `grok-build` entry in `~/.pi/agent/auth.json` (from `/login grok-build`)
2. Auto-detected token from `~/.grok/auth.json` (if you previously ran the official `grok login` elsewhere — convenient bonus, not required)
3. `xai` entry in `~/.pi/agent/auth.json` (from `/login xai`)
4. `XAI_API_KEY` environment variable
5. `xai.apiKey` in Pi settings

The extension performs a silent auto-import on startup if it finds a valid `~/.grok/auth.json` but no `grok-build` entry yet. This is purely a convenience — the recommended and fully supported path is the native `/login grok-build`.

The extension registers a full OAuth provider for `grok-build`, so token refresh, credential storage, and `/login grok-build` "just work" like GitHub Copilot or Anthropic Claude Pro in Pi — completely without any external binary.

### Manual configuration

Set API key via environment or Pi settings:

```json
{
  "xai": {
    "apiKey": "xai-...",
    "baseUrl": "https://api.x.ai/v1"
  }
}
```

## Install

```bash
pi install npm:pi-xai-text
```

After install, select an xAI model with `/model` → `xai` → `grok-4.20-multi-agent` for research tasks.
