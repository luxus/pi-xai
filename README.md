# pi-xai

<p align="center">
  <img src="assets/pi-xai-logo.png" width="420" alt="pi-xai — Pi · xAI · Grok">
</p>

<p align="center">
  <strong>xAI / Grok extras for <a href="https://github.com/earendil-works/pi">Pi</a></strong><br>
  Grok Build protocol · Imagine · video · web_fetch · goal / plan · prompt ghost · usage
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/pi-xai"><img src="https://img.shields.io/npm/v/pi-xai.svg?style=flat-square" alt="npm"></a>
  <a href="https://opensource.org/licenses/MIT"><img src="https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square" alt="MIT"></a>
  <a href="https://github.com/luxus/pi-xai/actions"><img src="https://img.shields.io/github/actions/workflow/status/luxus/pi-xai/ci.yml?style=flat-square" alt="CI"></a>
  <a href="https://github.com/luxus/pi-xai"><img src="https://img.shields.io/github/stars/luxus/pi-xai?style=flat-square" alt="stars"></a>
</p>

---

## Direction

**Today:** Grok Build provider path for Pi (subscription **cli-chat-proxy**, OAuth, model catalog, payload/header parity with [open-source Grok Build](https://github.com/xai-org/grok-build)).

**Soon:** when Pi ships **native Grok**, the **provider + OAuth layer here is transitional** and can shrink. This package stays a **Grok / xAI flavor pack**: tools and QoL that core Pi will not own.

| Lives in **pi-xai** | Use other extensions (below) |
| --- | --- |
| Protocol, catalog, agentic xAI tools | Task / subagent harness → [pi-subagents](https://github.com/edxeth/pi-subagents) |
| Imagine / video / `web_fetch` | Live todos → [pi-tasks](https://github.com/edxeth/pi-tasks) |
| `/goal`, `/plan`, prompt ghost, `/xai-usage` | Recurring prompts (`/loop`-like) → [pi-schedule-prompt](https://github.com/tintinweb/pi-schedule-prompt) |
| Composer vision routing | MCP bridges → [pi-mcp-adapter](https://github.com/nicobailon/pi-mcp-adapter) |
| Voice / TTS / STT | **[pi-xai-voice](https://github.com/luxus/pi-xai-voice)** |

Requires **Pi ≥ 0.80**. Docs: [xAI Responses](https://docs.x.ai).

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
| `/login grok-build` | OAuth (web / device / import `grok login`) |
| `/model grok-build/…` | Catalog below |
| `/goal <objective>` | Goal mode (`status` / `pause` / `resume` / `clear`) + tool `update_goal` |
| `/plan` | Plan mode (`on` / `off` / `status` / `show`); tools `enter_plan_mode` / `exit_plan_mode` |
| `/imagine` | Image gen — prompt passed **verbatim** to `image_gen` |
| `/imagine-video` | Video workflow (`image_gen` → `image_to_video`) |
| `/xai-suggest` | Next-prompt ghost (`on` / `off` / `clear`); **Tab** commits (remap via `~/.pi/agent/keybindings.json`: `"ext.pi-xai.promptSuggest.accept": "ctrl+right"`, then `/reload`) |
| `/xai-usage` | Monthly/weekly subscription bars (`% left`) + reset |
| `/xai-usage statusbar` | Footer `Grok 40% left · 3d 12h` (Grok models only) |
| `/xai-vision:status` | Vision routing for text-only models (Composer default) |

> Live X posts: agentic **`x_search`** or tool **`xai_x_search`** — not Pi’s `x_semantic_search` / `x_keyword_search`.

---

## Companion extensions (Grok-like features we don’t reimplement)

Stack these next to pi-xai when you want a fuller Grok Build feel without bloating this package:

| Grok-ish need | Extension | Notes |
| --- | --- | --- |
| Subagents / parallel tasks | [edxeth/pi-subagents](https://github.com/edxeth/pi-subagents) | Replaces snacking Grok `task` / `wait_tasks` / kill-task harness |
| Structured todos / progress UI | [edxeth/pi-tasks](https://github.com/edxeth/pi-tasks) | Replaces snacking Grok `todo_write` |
| Recurring / scheduled prompts | [tintinweb/pi-schedule-prompt](https://github.com/tintinweb/pi-schedule-prompt) | Replaces snacking Grok `/loop` + `scheduler_*` |
| MCP servers as tools | [nicobailon/pi-mcp-adapter](https://github.com/nicobailon/pi-mcp-adapter) | Private APIs, extra tools Grok might cover via MCP |
| Voice / dictation / TTS | [luxus/pi-xai-voice](https://github.com/luxus/pi-xai-voice) | Sibling; uses pi-xai OAuth when present |
| Full Imagine studio / extra media | [luxus/pi-xai-imagine](https://github.com/luxus/pi-xai-imagine) | Dual-install: video tools auto-skip here if imagine is loaded |

Example `~/.pi/agent/settings.json` packages list:

```json
{
  "packages": [
    "npm:pi-xai",
    "github:luxus/pi-xai-voice",
    "github:edxeth/pi-subagents",
    "github:edxeth/pi-tasks",
    "github:tintinweb/pi-schedule-prompt",
    "github:nicobailon/pi-mcp-adapter"
  ]
}
```

(Paths like `../../projects/pi-xai` work for local checkouts.)

---

## Aligned with Grok Build

- Default base: **`https://cli-chat-proxy.grok.com/v1`**
- Client **`0.2.101`** / `grok-shell` headers + dynamic **`x-grok-conv-id`**
- **`include: reasoning.encrypted_content`** on reasoning models (proxy + public API)
- Official tool names: **`image_gen`**, **`image_edit`**, **`image_to_video`**, **`web_fetch`**, plan/goal tools
- **No** Cursor capital shims (`Grep`/`Glob`/`WebSearch`) — Pi natives + server `web_search`
- CLI import keeps **`refresh_token`** from `~/.grok/auth.json`

Public API override:

```json
// ~/.pi/agent/settings.json
{
  "xai": {
    "baseUrl": "https://api.x.ai/v1"
  }
}
```

| | CLI proxy (default) | Public API |
| --- | --- | --- |
| Base | `cli-chat-proxy.grok.com/v1` | `api.x.ai/v1` |
| Auth | `/login grok-build` | OAuth or `XAI_API_KEY` |
| Encrypted reasoning | yes (CLI headers) | yes |
| Media tools | often use `api.x.ai` when proxy lacks routes | same |

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

Pi cost numbers are **per-token UI estimates**. Real subscription allowance: `/xai-usage`.

---

## Features

### Goal mode

```text
/goal ship the feature end-to-end
/goal status | pause | resume | clear
```

Tool **`update_goal`**: `message` | `completed` | `blocked_reason`. Lean (no classifier harness).

### Plan mode

```text
/plan          # toggle
/plan on|off|status|show
```

Tools **`enter_plan_mode`** / **`exit_plan_mode`**. Plan file **`.pi/plan.md`**. While on: no `edit`/`write`; bash allowlist.

### Prompt ghost (next message)

After each turn, predicts the next user prompt (default model **`grok-composer-2.5-fast`**). Dim text **in the empty textbox**; **Tab** commits; Enter sends (ANSI stripped).

```text
/xai-suggest on|off|status|clear
```

`XAI_PROMPT_SUGGESTIONS=0` or `/xai-suggest off` disables. Model override: `XAI_PROMPT_SUGGESTIONS_MODEL`.

### Imagine & video

| Tool / cmd | Purpose |
| --- | --- |
| `/imagine` | Slash → `image_gen` with prompt **verbatim** |
| `image_gen` | Text → image |
| `image_edit` | Edit (paths → data URIs) |
| `/imagine-video` | Single-clip workflow |
| `image_to_video` | Animate one image (duration 6 or 10s) |

```json
{ "xai": { "text": { "imageGen": false, "videoGen": false } } }
```

Video tools **auto-skip** when **pi-xai-imagine** is in your packages list.

### `web_fetch`

Client fetch of a public URL → markdown/text. HTTPS upgrade, SSRF blocks (localhost / private / metadata), size + char caps. Not for authenticated private sites.

### Agentic server tools (default on)

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

### Responses tools

| Tool | Purpose |
| --- | --- |
| `xai_generate_text` | Full Responses API |
| `xai_x_search` | Native X search |
| `xai_multi_agent` | Multi-agent research (default on; 4.20 multi-agent) |

```json
{ "xai": { "text": { "multiAgent": false } } }
```

### Usage QoL

```text
/xai-usage
/xai-usage statusbar
```

Needs Grok Build OAuth. Web: [grok.com usage](https://grok.com/?_s=usage).

```json
{ "xai": { "text": { "usageStatus": true } } }
```

### Vision routing (Composer)

Default **`composer`**: images from `read` → describe via `grok-4.5` → text.

```text
/xai-vision:composer | on | off | status | cache-clear
```

Config: `~/.pi/xai-vision.json`

### Provider behavior (while present)

1. Strip OpenAI-only fields xAI rejects  
2. Merge server built-ins with Pi tools  
3. Normalize empty content; system → `instructions`  
4. Local image paths → data URIs  
5. `prompt_cache_key` (session)  
6. Request encrypted reasoning include  
7. CLI proxy headers + conv-id  

---

## Development

```bash
npm install
npm run check
npm test
npm run verify:deps
```

| File | Role |
| --- | --- |
| `index.ts` | Entry, tools, hooks |
| `xai-provider.ts` | Catalog + provider (transitional) |
| `xai-oauth.ts` | OAuth + `/xai-usage` (transitional core) |
| `xai-config.ts` | Settings + dual-install detection |
| `xai-stream.ts` | CLI proxy headers |
| `xai-images.ts` | Image path → data URI |
| `xai-image-gen.ts` | `image_gen` / `image_edit` + `/imagine` |
| `xai-video-gen.ts` | `image_to_video` + `/imagine-video` |
| `xai-web-fetch.ts` | `web_fetch` |
| `xai-goal.ts` | `/goal` + `update_goal` |
| `xai-plan-mode.ts` | `/plan` + enter/exit_plan_mode |
| `xai-prompt-suggest.ts` | Next-prompt ghost |
| `xai-vision.ts` | Text-only vision routing |
| `xai-usage-status.ts` | Footer quota |

See [CHANGELOG.md](./CHANGELOG.md).

---

## License

[MIT](./LICENSE)
