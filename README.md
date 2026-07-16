# pi-xai

<p align="center">
  <img src="assets/pi-xai-logo.png" width="420" alt="pi-xai — Pi · xAI · Grok">
</p>

<p align="center">
  <strong>xAI / Grok extras for <a href="https://github.com/earendil-works/pi">Pi</a></strong><br>
  Grok Build protocol · Imagine tools · usage QoL · agentic xAI APIs
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/pi-xai"><img src="https://img.shields.io/npm/v/pi-xai.svg?style=flat-square" alt="npm"></a>
  <a href="https://opensource.org/licenses/MIT"><img src="https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square" alt="MIT"></a>
  <a href="https://github.com/luxus/pi-xai/actions"><img src="https://img.shields.io/github/actions/workflow/status/luxus/pi-xai/ci.yml?style=flat-square" alt="CI"></a>
  <a href="https://github.com/luxus/pi-xai"><img src="https://img.shields.io/github/stars/luxus/pi-xai?style=flat-square" alt="stars"></a>
</p>

---

## Direction

**Today:** full Grok Build provider path in Pi (subscription proxy, OAuth, catalog, payload parity with [open-source Grok Build](https://github.com/xai-org/grok-build)).

**Soon:** Pi is expected to ship **native Grok** support. When that lands, the **provider + OAuth core here becomes transitional** and can shrink or go away.

**What this package becomes:** a **Grok / xAI flavor pack** — tools and QoL that core Pi will not own:

| Keep / grow | Drop when Pi is native |
| --- | --- |
| Imagine `image_gen` / `image_edit` (+ video later) | Provider catalog / model registration |
| `/xai-usage` + optional statusbar | Login / OAuth plumbing (if Pi owns auth) |
| Agentic xAI tools, `xai_x_search`, multi-agent | Payload/header shims only needed for our provider |
| Composer vision routing, session QoL | Cursor/Composer name shims (**already removed**) |

Sibling packages: **[pi-xai-voice](https://github.com/luxus/pi-xai-voice)** (TTS/STT, Telegram voice). **pi-xai-imagine** is being folded in (thin Imagine already lives here).

Requires **Pi ≥ 0.80**. Protocol reference: open-source Grok Build. Docs: [xAI Responses](https://docs.x.ai).

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
| `/goal <objective>` | Grok Build–style goal mode (`status` / `pause` / `resume` / `clear`) |
| `/plan` | Plan mode on/off (`status` / `show`); tools `enter_plan_mode` / `exit_plan_mode` |
| `/xai-suggest` | Next-prompt ghost after turns (`on` / `off` / `clear`); **Tab** accepts |
| `/xai-usage` | Monthly/weekly subscription bars (`% left`) + reset |
| `/xai-usage statusbar` | Footer `Grok 40% left · 3d 12h` (Grok models only) |
| `/xai-vision:status` | Vision routing for text-only models (Composer default) |

> Live X posts: agentic **`x_search`** or tool **`xai_x_search`** — not Pi’s `x_semantic_search` / `x_keyword_search`.

---

## Aligned with Grok Build (current)

Wire protocol matches the official CLI / open-source Grok Build:

- Default base: **`https://cli-chat-proxy.grok.com/v1`** (subscription catalog)
- Client headers: Grok CLI **`0.2.101`**, `grok-shell`, token-auth middleware
- Dynamic **`x-grok-conv-id`** via `before_provider_headers`
- **`include: reasoning.encrypted_content`** on reasoning models (proxy + public API; do not strip)
- OAuth scopes + device-code surface aligned with official client
- Official tool names: **`image_gen`**, **`image_edit`** (Imagine)
- **No** Cursor capital tool shims (`Grep`/`Glob`/`WebSearch`) — use Pi natives + server `web_search`

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
| Encrypted reasoning | yes (with CLI headers) | yes |
| Imagine / TTS | prefer `api.x.ai` when tools need it | same |

CLI import keeps **`refresh_token`** from `~/.grok/auth.json` (0.16.1+). Dead access tokens are refreshed or skipped — never reused.

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

Pi cost numbers are **per-token UI estimates**, not subscription credits. Real allowance: `/xai-usage`.

---

## Features (flavor pack)

### Goal mode (Grok Build)

```text
/goal ship the feature end-to-end
/goal status
/goal pause | resume | clear
```

Registers tool **`update_goal`** (`message` | `completed` | `blocked_reason`). No classifier/subagent harness — pursue until done.

### Plan mode (Grok Build)

```text
/plan          # toggle
/plan on|off|status|show
```

Tools **`enter_plan_mode`** / **`exit_plan_mode`** (official ids). Writes **`.pi/plan.md`**. While on: disables `edit`/`write`, allowlists read-only bash. Exit surfaces the plan for approval before implement.

### Prompt ghost (next message)

After each agent turn, predicts what you are likely to type next (Grok Build prompt-suggestions idea). Shown as `💡 Tab → …` above the editor; **Tab** inserts it.

```text
/xai-suggest on|off|status|clear
```

Disable: `XAI_PROMPT_SUGGESTIONS=0` or `/xai-suggest off`. Model: `XAI_PROMPT_SUGGESTIONS_MODEL` (default `grok-4.5`).

### Imagine (in-package)

| Tool | Purpose |
| --- | --- |
| `image_gen` | Text → image (Grok Build name) |
| `image_edit` | Edit with local path / URL refs (paths → data URIs) |

**Dual-install:** if **pi-xai-imagine** is also loaded, it skips `image_gen` so only this package owns the official name (video/studio stay in imagine).

Opt out Imagine tools here:

```json
{ "xai": { "text": { "imageGen": false } } }
```

### Agentic server tools (on by default)

Merged into Grok chat next to Pi local tools:

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
| `xai_multi_agent` | Multi-agent research (**on by default**; 4.20 multi-agent) |

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

Only **Composer** is text-only among Grok models. Default mode `composer`: `read` images → describe via `grok-4.5` → text.

```text
/xai-vision:composer   # default
/xai-vision:on         # all text-only models
/xai-vision:off
```

Config: `~/.pi/xai-vision.json`

### What the provider still does (while it exists)

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
| `xai-config.ts` | Settings |
| `xai-stream.ts` | CLI proxy headers |
| `xai-images.ts` | Image path → data URI |
| `xai-image-gen.ts` | Imagine tools |
| `xai-goal.ts` | `/goal` + `update_goal` |
| `xai-plan-mode.ts` | `/plan` + enter/exit_plan_mode |
| `xai-prompt-suggest.ts` | Next-prompt ghost |
| `xai-vision.ts` | Text-only vision routing |
| `xai-usage-status.ts` | Footer quota |

See [CHANGELOG.md](./CHANGELOG.md).

---

## License

[MIT](./LICENSE)
