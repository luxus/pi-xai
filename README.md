# pi-xai

Pi extension for xAI Grok Build (Coding Plan) — Responses API, native OAuth, 2 powerful tools + automatic agentic mode.

## Features

- **grok-build provider** — `/login grok-build` (native OAuth, no binary), Responses API (`openai-responses`), full reasoning
- `xai_generate_text` — stateful conversations, structured JSON output, built-in tools, `previousResponseId`, custom timeout
- `xai_multi_agent` — 4/16-agent research (`reasoningEffort`), live progress updates via `onUpdate`
- **Agentic mode** — when any `grok-*` model is active, the extension auto-injects web_search / x_search / code_execution; the model decides what to call (the "magic")
- Full OAuth implementation: device code flow, JWT expiry + refresh lock, optional import from `~/.grok/auth.json`

Models (via `/model grok-build/...`): `grok-build` (primary Coding Plan alias), `grok-4.3`, `grok-4.3-latest`.

Everything works with Grok Build OAuth or plain `XAI_API_KEY`.

## Quick start

```bash
pi install npm:pi-xai
# then in Pi:
/login grok-build
/model grok-build/grok-build
```

Ask anything. Agentic mode handles research for you, or call the two explicit tools for precise control.

## Tools

| Tool                | Description                                                      |
| ------------------- | ---------------------------------------------------------------- |
| `xai_generate_text` | Responses API text gen with reasoning, JSON schema, tools, state |
| `xai_multi_agent`   | Deep research (4 or 16 agents), progress, multi-turn             |

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
