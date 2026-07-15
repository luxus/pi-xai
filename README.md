# pi-xai

<p align="center">
  <img src="assets/pi-xai-logo.png" width="420" alt="pi-xai — Pi · xAI · Grok">
</p>

<p align="center">
  <strong>xAI Grok for <a href="https://github.com/earendil-works/pi">Pi</a></strong><br>
  cli-chat-proxy · OAuth · Agentic tools · Multi-agent · Composer / Build / 4.5 / 4.20
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/pi-xai"><img src="https://img.shields.io/npm/v/pi-xai.svg?style=flat-square" alt="npm"></a>
  <a href="https://opensource.org/licenses/MIT"><img src="https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square" alt="MIT"></a>
  <a href="https://github.com/luxus/pi-xai/actions"><img src="https://img.shields.io/github/actions/workflow/status/luxus/pi-xai/ci.yml?style=flat-square" alt="CI"></a>
  <a href="https://github.com/luxus/pi-xai"><img src="https://img.shields.io/github/stars/luxus/pi-xai?style=flat-square" alt="stars"></a>
</p>

---

## Why

Use Grok models inside Pi on the **Grok CLI subscription proxy** by default:

- Default base URL is **`cli-chat-proxy.grok.com`** (subscription catalog + OAuth)
- Encrypted multi-turn reasoning works on the proxy with CLI client headers
- **OAuth** via `/login grok-build` (SuperGrok / X entitlement)
- **Agentic** server-side `web_search`, `x_search`, `code_interpreter`
- **`xai_multi_agent`** research tool on by default
- Optional vision routing for text-only models

Prefer the public API / API key? Set `xai.baseUrl` to `https://api.x.ai/v1`.

Requires **Pi ≥ 0.80**.

Inspired by [Hermes Agent](https://github.com/NousResearch/hermes-agent) and [pi-grok-cli](https://github.com/kenryu42/pi-grok-cli). Docs: [xAI Responses](https://docs.x.ai).

---

## Quick start

```bash
pi install npm:pi-xai
```

```text
/login grok-build
/model grok-build/grok-4.5
```

| Command | What it does |
| --- | --- |
| `/login grok-build` | OAuth for subscription models |
| `/model grok-build/…` | Pick a model from the catalog below |
| `/xai-usage` | Codex-style monthly/weekly bars (`% left`) + credits + reset |
| `/xai-usage statusbar` | Toggle footer status: `Grok 40% left · 3d 12h` (Grok models only) |
| `/xai-vision:status` | Vision routing mode for text-only models |

> Live X posts: use agentic **`x_search`** or the **`xai_x_search`** tool — not Pi’s `x_semantic_search` / `x_keyword_search`.

---

## Models

| ID | Context | Input | Role |
| --- | ---: | --- | --- |
| `grok-composer-2.5-fast` | 200K | text | Fast coding; vision routing on by default |
| `grok-build` | 500K | text + image | Coding |
| `grok-4.5` | 500K | text + image | Flagship reasoning |
| `grok-4.3` | 1M | text + image | Long context |
| `grok-4.20-0309-reasoning` | 2M | text + image | Auto reasoning |
| `grok-4.20-0309-non-reasoning` | 2M | text + image | Fast 4.20 |
| `grok-4.20-multi-agent-0309` | 2M | text + image | Multi-agent research |

Pi cost numbers are **per-token UI estimates**, not subscription credits. Check real allowance with `/xai-usage`.

---

## Endpoint & auth

| | Default (CLI proxy) | Public API override |
| --- | --- | --- |
| Base URL | `https://cli-chat-proxy.grok.com/v1` | `https://api.x.ai/v1` |
| Auth | `/login grok-build` | OAuth or `XAI_API_KEY` |
| Encrypted reasoning | yes (CLI headers) | yes |
| Headers | Grok CLI client (`0.2.101`) | not required |

```json
// ~/.pi/agent/settings.json  — only if you want the public API instead
{
  "xai": {
    "baseUrl": "https://api.x.ai/v1"
  }
}
```

---

## Usage (subscription quota)

```text
/xai-usage
```

Shows **monthly** credits used and **weekly** limit % from the same billing surface as Grok CLI `/usage`.

- Needs Grok Build OAuth (`/login grok-build` or imported `grok login`)
- Plain `XAI_API_KEY` is usually not enough for this endpoint
- Web view: [grok.com usage](https://grok.com/?_s=usage)

### Optional footer status

```text
/xai-usage statusbar
```

Toggles a Pi footer line such as `Grok 40% left · 3d 12h` (tighter of monthly/weekly) when a **Grok** model is selected. Off by default. `/xai-usage` also shows a tip to enable it when the statusbar is off.

```json
// ~/.pi/agent/settings.json
{
  "xai": {
    "text": {
      "usageStatus": true
    }
  }
}
```

Subscription credits only — no split by product (API vs Build vs chat).

---

## Features

### Agentic mode (on by default)

Server-side built-ins on every Grok turn:

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

### Tools

| Tool | Purpose |
| --- | --- |
| `xai_generate_text` | Full Responses API — tools, schema, reasoning, store |
| `xai_x_search` | Native X search (`grok-4.20-0309-reasoning`) |
| `xai_multi_agent` | Multi-agent research — **on by default** (currently 4.20 multi-agent) |

Disable multi-agent:

```json
{
  "xai": {
    "text": {
      "multiAgent": false
    }
  }
}
```

### Composer search shims

On `grok-build`, capital **`Grep`** / **`Glob`** wrap Pi `grep` / `find` so Composer first-tries don’t fail with “Tool not found”. Arg aliases (`contents` → `content`, etc.) are normalized.

Not a full Cursor toolkit — only what Composer actually needs.

### Vision routing (Composer)

Among Grok models, **only Composer is text-only**. 4.5 / 4.3 / Build / 4.20 take images natively.

**Default: `composer`** — when Composer is active, images from `read` / `Read` are described by `grok-4.5` and replaced with text.

```text
/xai-vision:status
/xai-vision:composer   # default
/xai-vision:on         # all text-only models
/xai-vision:off
/xai-vision:cache-clear
```

Config: `~/.pi/xai-vision.json` · Cache: `~/.pi/xai-vision-cache.json`

### Agentic server tools (Responses API)

Default on for `grok-*` chat: injects server-side `{ type: "web_search" | "x_search" | "code_interpreter" }` **alongside** Pi’s local tools (`read`, `bash`, …). Opt out: `xai.text.agentic: false`. Custom list: `xai.text.agenticTools`.

Local coding tools are Pi’s (not Grok Build’s `read_file` / `search_replace` names).

---

## What the provider does

On every `grok-*` chat request:

1. Strip OpenAI-only fields that xAI rejects  
2. Merge server-side built-ins with Pi client tools  
3. Normalize empty `content` and system → `instructions`  
4. Convert local image paths to data URIs  
5. Set `prompt_cache_key` (Pi session id)  
6. Request `reasoning.encrypted_content` on reasoning models (api + CLI proxy)  

---

## Development

```bash
npm install
npm run check
npm test
npm run verify:deps   # undici / ws / protobufjs pins until upstream is fixed
```

| File | Role |
| --- | --- |
| `index.ts` | Extension entry, tools, hooks |
| `xai-provider.ts` | Model catalog + provider registration |
| `xai-oauth.ts` | OAuth, token refresh, `/xai-usage` |
| `xai-config.ts` | Settings resolution |
| `xai-stream.ts` | CLI proxy headers |
| `xai-images.ts` | Image path → data URI |
| `xai-image-gen.ts` | Imagine `image_gen` / `image_edit` |
| `xai-vision.ts` | Text-only vision routing |

See [CHANGELOG.md](./CHANGELOG.md) for release notes.

---

## License

[MIT](./LICENSE)
