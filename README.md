# pi-xai

<p align="center">
  <img src="assets/pi-xai-logo.png" width="320" alt="pi-xai">
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/pi-xai"><img src="https://img.shields.io/npm/v/pi-xai.svg?style=flat-square" alt="npm version"></a>
  <a href="https://opensource.org/licenses/MIT"><img src="https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square" alt="License: MIT"></a>
  <a href="https://github.com/luxus/pi-xai"><img src="https://img.shields.io/github/stars/luxus/pi-xai?style=flat-square" alt="GitHub Stars"></a>
</p>

Pi extension for xAI Grok — **Grok CLI proxy** by default, native OAuth, agentic built-ins, and focused tools on Grok 4.5 / Composer / Build / 4.20.

Reference: [Hermes Agent](https://github.com/NousResearch/hermes-agent) (xAI OAuth, native `web_search` / `x_search`) and [xAI Responses docs](https://docs.x.ai).

**Grok Build / subscription models** need an entitled Grok / X subscription — `/login grok-build`. `XAI_API_KEY` still works when you point `xai.baseUrl` at the public API.

Requires **pi 0.80+**.

## Quick start

```bash
pi install npm:pi-xai
/login grok-build
/model grok-build/grok-4.5
```

Live X news: agentic **`x_search`** or **`xai_x_search`** — not harness `x_semantic_search` / `x_keyword_search`.

## Endpoint

| | Default | Public API override |
| --- | --- | --- |
| Base URL | `https://cli-chat-proxy.grok.com/v1` | `https://api.x.ai/v1` |
| Auth | OAuth (`/login grok-build`) | OAuth or `XAI_API_KEY` |
| Client headers | Grok CLI version gate (`0.2.91`) | not required |

```json
{
  "xai": {
    "baseUrl": "https://api.x.ai/v1"
  }
}
```

in `~/.pi/agent/settings.json` or project `.pi/settings.json` to use the public API instead.

## Usage (subscription quota)

```text
/xai-usage
```

Shows Grok Build **monthly** credits used and **weekly** limit % (same billing surface as Grok CLI `/usage`). Also: [grok.com usage](https://grok.com/?_s=usage).

Requires `/login grok-build` (or imported `grok login`) — plain `XAI_API_KEY` is usually not enough for subscription billing.

## Models

| Model ID | Context | Input | Notes |
| --- | ---: | --- | --- |
| `grok-composer-2.5-fast` | 200K | text | Fast coding; vision routing **on by default** |
| `grok-build` | 512K | text + image | Coding model |
| `grok-4.5` | 500K | text + image | Flagship reasoning |
| `grok-4.3` | 1M | text + image | Long context |
| `grok-4.20-0309-reasoning` | 2M | text + image | Auto reasoning |
| `grok-4.20-0309-non-reasoning` | 2M | text + image | Fast 4.20 |
| `grok-4.20-multi-agent-0309` | 2M | text + image | Multi-agent research |

Costs shown in pi are **per-token estimates** for UI only — not a conversion of Grok subscription credits. Use `/xai-usage` for account limits.

## Tools

| Tool | Purpose |
| ---- | ------- |
| `xai_generate_text` | Full Responses API (`tools`, `previousResponseId`, JSON schema, `reasoningEffort`, `store`) |
| `xai_x_search` | Native `x_search` (`grok-4.20-0309-reasoning`, optional dates, `store: false`) |

### Composer / Cursor search compatibility

On provider `grok-build`, pi-xai activates pi `grep`/`find` and capital **`Grep`/`Glob`** aliases so Grok Composer first-tries do not hit “Tool not found”. Also normalizes a few arg aliases (`contents`→`content`, strip `replace_all` on edit). Inspired by [kenryu42/pi-grok-cli](https://github.com/kenryu42/pi-grok-cli) — thanks @kenryu42. Not a full Cursor tool surface (file/shell shims not needed after testing).

### Vision for Composer (default)

Among Grok models, **only Composer is text-only**. `grok-4.5` / `grok-4.3` / Build / 4.20 accept images natively.

**Default mode: `composer`** — when Composer is active, images from pi `read` / `Read` are described by **`grok-4.5`** and replaced with text. Other text-only models are **not** auto-routed.

```text
/xai-vision:status
/xai-vision:composer   # default — Composer only
/xai-vision:on         # all text-only models
/xai-vision:off
/xai-vision:cache-clear
```

Config: `~/.pi/xai-vision.json` — `mode`: `"composer"` | `"all"` | `"off"`. Cache: `~/.pi/xai-vision-cache.json`. Inspired by [kenryu42/pi-grok-cli](https://github.com/kenryu42/pi-grok-cli).

Web search / code execution: `xai_generate_text` with `tools: ["web_search"]` or `["code_interpreter"]`, or agentic mode (xAI **server-side** built-ins — default).

#### Optional: Cursor `WebSearch` via pi-web-access

```bash
pi install npm:pi-web-access
```

| `xai.text.webSearch` | On `grok-build` | Other models |
| --- | --- | --- |
| `native` (**default**) | xAI server-side `web_search` only | pi-web-access left alone |
| `web-access` | Replace native with Cursor `WebSearch` | Leaving grok-build restores client search |
| `both` | Native agentic **and** `WebSearch` | same restore |

`xai_multi_agent` is **off by default**. Opt in:

```json
{
  "xai": {
    "text": {
      "multiAgent": true
    }
  }
}
```

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

For all `grok-*` chat, `before_provider_request` sanitizes OpenAI-only fields, merges native built-ins with Pi tools (`mergeXaiTools`), fixes empty `content` (`normalizeForXai`), moves system/developer to `instructions`, normalizes **local image paths** to data URIs, rewrites image-bearing `function_call_output`, and ensures `prompt_cache_key` (Pi session id). On the CLI proxy, `reasoning.encrypted_content` is stripped (proxy-incompatible); on `api.x.ai` it is requested for reasoning models.

## Development

```bash
npm install && npm run check && npm test
npm run verify:deps   # patched undici/ws/protobufjs until pi publishes dep fix
```

`index.ts`, `xai-config.ts`, `xai-oauth.ts`, `xai-provider.ts`, `xai-stream.ts`, `xai-images.ts`, `xai-tool-shims.ts`, `xai-vision.ts`, optional `xai-web-search-*.ts`. See `CHANGELOG.md`.
