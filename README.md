# pi-xai

<p align="center">
  <img src="assets/pi-xai-logo.png" width="320" alt="pi-xai">
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/pi-xai"><img src="https://img.shields.io/npm/v/pi-xai.svg?style=flat-square" alt="npm version"></a>
  <a href="https://opensource.org/licenses/MIT"><img src="https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square" alt="License: MIT"></a>
  <a href="https://github.com/luxus/pi-xai"><img src="https://img.shields.io/github/stars/luxus/pi-xai?style=flat-square" alt="GitHub Stars"></a>
</p>

Pi extension for xAI Grok Build — Responses API, native OAuth, 5 tools + automatic agentic mode.

**Note:** Full access to Grok Build requires a **SuperGrok Heavy** subscription (see below).

## Features

- **grok-build provider** — `/login grok-build` (native Web PKCE OAuth recommended with browser + manual-paste fallback, or Device Code for headless; no binary), Responses API (`openai-responses`), full reasoning
- `xai_generate_text` — stateful conversations, structured JSON output, built-in tools (with advanced filters), `reasoningEffort`, `previousResponseId`, custom timeout
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

## Payload normalization modes (`compatible` vs `aggressive`)

The extension supports two payload normalization modes for grok-* models (via the `openai-responses` driver + our hook). Controlled by `xai.payloadMode` in `~/.pi/agent/settings.json` (or project `.pi/settings.json`):

```json
{
  "xai": {
    "payloadMode": "compatible"   // default — or "aggressive"
  }
}
```

### `compatible` (default)
- 100% unchanged behavior for existing users.
- Applies a defensive, enhanced content-element normalizer (catches `content: []`, `""`, whitespace-only, arrays of only malformed/empty/garbage parts, while safely preserving pure `input_image` vision messages and mixed content).
- Protects against the common 400 "Each message must have at least one content element" after tool turns or certain histories.
- Sufficient for the majority of users and the rich `xai_*` tools.

### `aggressive`
- **Opt-in only** (no default change ever).
- Runs the full rewrite in the provider chat/agentic path (`before_provider_request` for grok-*):
  - The complete `normalizeForXai` (content guarantee + **Hermes-like reasoning-item stripping**).
  - Relocates developer/system messages to top-level `instructions`.
  - Stricter `function_call_output.output` sanitization (arrays → text with `[image]` placeholders + JSON fallback to avoid 422s).
- **Hermes parity (substantially)**: The aggressive path now brings over the highest-impact anti-400 patterns from the 2026-05-19 exploration of the Hermes agent clone (`/tmp/hermes-agent-clone`):
  - Proactive stripping of every `type: "reasoning"` item in `input` (directly ports the `is_xai_responses=True` logic in `codex_responses_adapter.py:_chat_messages_to_responses_input` that skips replay of `codex_reasoning_items` / encrypted_content for xAI, plus the transport's `include:[]` behavior).
  - Eliminates "reasoning without following content item" (`missing_following_item`) and replay of encrypted blobs that xAI OAuth/SuperGrok rejects.
  - Post-strip content fix ensures any leftover pure-reasoning follower assistants are valid `[{type:"output_text", text:""}]`.
  - Matches the exact root cause of recurring 400s on high-reasoning (grok-4.3), long tool-using sessions, and news-search follow-ups that survived prior compatible hardening.
- Sibling extensions and direct `/responses` callers get the full benefit by calling the exported `normalizeForXai(inputArray)` helper (see JSDoc in `index.ts` for the exact usage recipe).

**When to switch to `aggressive`**:
- You hit 400s on complex/high-reasoning/tool-heavy conversations despite the default.
- Developing or using sibling packages (`pi-xai-imagine`, etc.) that do direct Responses calls.
- Long multi-turn agentic workflows or "imagine" workspaces with heavy reasoning.
- You want the closest experience to how Hermes (the reference) handles xAI paths.

**Important limitations** (transparent due to architectural constraints):
- The rich built-in tools (`xai_generate_text`, `xai_web_search`, `xai_x_search`, `xai_code_execution`, `xai_multi_agent`) and any code path that goes through the internal `callXaiResponses` (including many sibling direct calls during development) **always use only the enhanced-compatible normalization**, even if you set `payloadMode: "aggressive"`. They never receive the reasoning strip, relocation, or extra tool cleaning.
- For full aggressive/Hermes guarantees on *your own* direct Responses calls, explicitly call `normalizeForXai(...)` on the `input` array (the helper is the single source of truth and the recommended path for power users / siblings).
- Only the normal provider-driven grok-* chat + auto-injected agentic tools path gets the complete aggressive treatment.

See the detailed JSDoc on `normalizeForXai` and the payloadMode block in `index.ts` for implementation notes, every `(as any)` rationale, and the full constraint history (smallest possible diff, no new internal helpers, single grok-build provider, in-place only).

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
