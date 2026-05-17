# pi-xai

Pi extension for xAI Grok Build — Responses API, native OAuth, 5 tools + automatic agentic mode.

**Note:** Full access to Grok Build requires a **SuperGrok Heavy** subscription (see below).

## Features

- **grok-build provider** — `/login grok-build` (native Web PKCE OAuth recommended with browser + manual-paste fallback, or Device Code for headless; no binary), Responses API (`openai-responses`), full reasoning
- `xai_generate_text` — stateful conversations, structured JSON output, built-in tools, `previousResponseId`, custom timeout
- `xai_multi_agent` — 4/16-agent research (`reasoningEffort`), live progress updates via `onUpdate`
- **Agentic mode** — when any `grok-*` model is active, the extension auto-injects web_search / x_search / code_execution; the model decides what to call (the "magic")
- Full OAuth implementation: Web PKCE (OIDC discovery, PKCE, callback server with CORS + manual input) + Device Code fallback, JWT expiry + per-key refresh lock, improved ~/.grok/auth.json parsing (canonical + legacy), optional import from Grok CLI

Models (via `/model grok-build/...`): `grok-build` (primary Coding Plan alias), `grok-4.3`, `grok-4.3-latest`.

Everything works with Grok Build OAuth or plain `XAI_API_KEY`.

## Getting Grok Build Access

The `grok-build` provider and model require a **SuperGrok Heavy** subscription.

- SuperGrok has a free 3-day trial.
- When upgrading from SuperGrok, look for the limited offer to get **SuperGrok Heavy** for $99/month for the first 6 months.

![SuperGrok Heavy offer](assets/supergrok-heavy-offer.png)

## Quick start

```bash
pi install npm:pi-xai
# then in Pi:
/login grok-build
/model grok-build/grok-build
```

Ask anything. Agentic mode handles research for you, or call any of the five explicit tools (`xai_generate_text`, `xai_multi_agent`, `xai_web_search`, `xai_x_search`, `xai_code_execution`) for precise/direct control.

## Tools

| Tool                 | Description                                                      |
| -------------------- | ---------------------------------------------------------------- |
| `xai_generate_text`  | Responses API text gen with reasoning, JSON schema, tools, state |
| `xai_multi_agent`    | Deep research (4 or 16 agents), progress, multi-turn             |
| `xai_web_search`     | Web search via Grok (prompt simulation for current knowledge)    |
| `xai_x_search`       | X/Twitter search via Grok (prompt simulation)                    |
| `xai_code_execution` | Python code analysis/execution simulation via Grok               |

## Agentic mode config (optional)

`~/.pi/agent/settings.json` (or `.pi/settings.json`):

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

Default = enabled with all three built-in tools.

## Development

Zero-config modern stack (oxfmt default, oxlint zero-config, tsgo only):

```bash
npm install
npm run check      # tsgo --noEmit
npm run lint       # oxlint .
npm run format     # oxfmt --write .
npm test
```

Husky + lint-staged runs `oxfmt --write`, `oxlint`, `tsgo --noEmit` on every commit.

Exactly 4 source files. See CHANGELOG.md.
