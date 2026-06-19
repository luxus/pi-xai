# pi-xai

<p align="center">
  <img src="assets/pi-xai-logo.png" width="320" alt="pi-xai">
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/pi-xai"><img src="https://img.shields.io/npm/v/pi-xai.svg?style=flat-square" alt="npm version"></a>
  <a href="https://opensource.org/licenses/MIT"><img src="https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square" alt="License: MIT"></a>
  <a href="https://github.com/luxus/pi-xai"><img src="https://img.shields.io/github/stars/luxus/pi-xai?style=flat-square" alt="GitHub Stars"></a>
</p>

Pi extension for xAI Grok Build — Responses API, native OAuth, three tools, agentic built-ins.

Reference: [Hermes Agent](https://github.com/NousResearch/hermes-agent) (xAI OAuth, native `web_search` / `x_search`) and [xAI Responses docs](https://docs.x.ai).

**Grok Build** models need a SuperGrok or X (x.com) subscription — `/login grok-build`. `XAI_API_KEY` still works for API-key access.

## Quick start

```bash
pi install npm:pi-xai
/login grok-build
/model grok-build/grok-build-0.1
```

Live X news: agentic **`x_search`** or **`xai_x_search`** — not harness `x_semantic_search` / `x_keyword_search`.

## Tools

| Tool | Purpose |
| ---- | ------- |
| `xai_generate_text` | Full Responses API (`tools`, `previousResponseId`, JSON schema, `reasoningEffort`, `store`) |
| `xai_multi_agent` | `grok-4.20-multi-agent` research |
| `xai_x_search` | Native `x_search` (`grok-4.20-reasoning`, optional dates, `store: false`) |

Web search / code execution: `xai_generate_text` with `tools: ["web_search"]` or `["code_interpreter"]`, or agentic mode.

## Agentic mode

Default on. `~/.pi/agent/settings.json`:

```json
{
  "xai": {
    "text": {
      "agentic": true,
      "agenticTools": ["web_search", "x_search", "code_interpreter"]
    }
  }
}
```

## Provider payload

For all `grok-*` chat, `before_provider_request` sanitizes OpenAI-only fields, merges native built-ins with Pi tools (`mergeXaiTools`), fixes empty `content` (`normalizeForXai`), moves system/developer to `instructions`, and stringifies array `function_call_output`. Direct `/responses` from siblings: `import { normalizeForXai } from "pi-xai"`.

## xAI Responses (Pi defaults)

| | Pi chat | `xai_x_search` |
| --- | --- | --- |
| `store` | default true (30d) | `false` |
| `include: reasoning.encrypted_content` | reasoning models | omitted |
| Chain turns | `previous_response_id` / Pi history | one-shot |

## Development

```bash
npm install && npm run check && npm test
npm run verify:deps   # patched undici/ws/protobufjs until pi publishes dep fix (earendil-works/pi main)
```

`index.ts`, `xai-config.ts`, `xai-oauth.ts`, `xai-provider.ts`. Transitive audit noise: waiting on upstream [`fix: update vulnerable dependencies`](https://github.com/earendil-works/pi/commits/main/) after `0.79.7`. See `CHANGELOG.md`.