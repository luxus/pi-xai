# pi-xai

Pi extension for xAI (Grok Build) via the modern Responses API — subscription OAuth, reasoning, multi-agent research, and powerful built-in tools.

## Features

- **xAI (Grok Build) Provider** — Dedicated `grok-build` provider for xAI Coding Plan subscribers. Uses Responses API (`openai-responses`) for native tool calling and full reasoning. Run `/login grok-build` to activate. The built-in `xai` provider in Pi handles regular API key users.
- **Responses API** (`xai_generate_text`) — Stateful conversations, reasoning models, structured outputs, built-in tools, server-side storage.
- **Multi-Agent Research** (`xai_multi_agent`) — Deep research with `grok-4.20-multi-agent`. 4 or 16 collaborating agents with web search, X search, code execution. Shows progress updates during research.

## Provider Models (via grok-build)

After `/login grok-build`, these models are available via `/model grok-build/...`:

| Model | Type | Context | Max Tokens |
|-------|------|---------|-----------|
| `grok-build` | Primary (Coding Plan) | 131K | 32K |
| `grok-4.3` | Build | 131K | 32K |
| `grok-4.3-latest` | Build Latest | 131K | 32K |

(The full Grok model range including fast/mini variants is available via Pi's built-in `xai` provider + `XAI_API_KEY`.)

The `xai_multi_agent` tool uses the specialized `grok-4.20-multi-agent` backend model (4–16 agents) and is available to all authenticated users (via grok-build OAuth or XAI_API_KEY fallback) regardless of the active `/model` selection.

## Tools

| Tool | Description |
|------|-------------|
| `xai_generate_text` | Generate text via Responses API. Supports reasoning models (e.g. `grok-4.3`), structured JSON output, built-in tools (`web_search`, `x_search`, `code_execution`), `previousResponseId`, `store`, `include`, custom timeout. Returns citations when tools are used. |
| `xai_multi_agent` | Deep research via xAI Coding Plan models (grok-build / grok-4.3). `reasoningEffort` controls agent count (low/medium=4, high/xhigh=16). Shows live progress updates. Supports built-in tools and multi-turn via `previousResponseId`. Returns citations. |
| `xai_web_search` | Web search via xAI's built-in `web_search` tool. Returns results with citations. Works with any pi model. |
| `xai_code_execution` | Execute Python code in xAI's sandbox via `code_execution` tool. Returns output and generated files. Works with any pi model. |
| `xai_collections_search` | Query uploaded document collections via `collections_search` tool. Works with any pi model. |

## Agentic Mode

When an xAI model (e.g. `grok-build` or `grok-4.3`) is active via `/model grok-build/...`, built-in tools are **automatically injected** into every request (the `before_provider_request` hook matches any `grok-*` model). The model decides autonomously when to search the web, browse X, or execute code — just like native xAI agentic behavior.

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

- Select a Grok Build model via `/model grok-build/grok-build` (or `grok-4.3`)
- Ask anything — "What are the latest updates from xAI?"
- The model autonomously decides to use `web_search`, gets results, cites sources
- Citations appear inline (`[[1]](url)`) and in the Sources footer
- No explicit tool calls needed — the model orchestrates itself (agentic mode works for all grok-* models from the grok-build provider)

## xAI (Grok Build) Provider

This extension provides the dedicated **`grok-build`** provider for xAI Coding Plan / Grok Build subscribers.

**Recommended: `/login grok-build`**

- Uses the same official xAI OAuth client as the Grok apps (native device code flow).
- Smart import: if you have an existing `grok login` from the official CLI, it offers to import it.
- No external binary required.
- Appears first-class under Pi Subscriptions.

After login, use models via:

```
/model grok-build/grok-build
/model grok-build/grok-4.3
/model grok-build/grok-4.3-latest
```

The generic `xai` provider (full model list including fast/mini) is provided by Pi itself — use your normal `XAI_API_KEY` with the built-in `xai` provider.

**Credential resolution (prefers Grok Build when available):**
1. `grok-build` OAuth entry (from `/login grok-build`)
2. Auto-imported from `~/.grok/auth.json` (official CLI login)
3. `xai` entry or `XAI_API_KEY` / settings (for the built-in xai provider + our tools)

The powerful tools (`xai_generate_text`, `xai_multi_agent`, etc.) work seamlessly with whichever credential is active.

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
pi install npm:pi-xai
```

After install, run `/login grok-build`, then select a model with `/model grok-build/grok-build` (or `grok-4.3`). The `xai_generate_text` and `xai_multi_agent` tools are also available for deep xAI usage.

## Development

All development uses standard npm (no Bun required in your PATH):

- Install deps: `npm install`
- Typecheck: `npm run check` (or `npx tsc --noEmit`)
- Tests: `npm test` (or `npx vitest run`) — 19+ unit tests covering JWT expiry, refresh hardening, credential resolution, XaiAuthError paths.
- Pre-commit: husky + lint-staged automatically run `tsc --noEmit && vitest run` on staged `**/*.ts` changes after `npm install`.

The project ships raw TypeScript (with explicit `.ts` imports like `import { X } from "./foo.ts"`). This works because:

- Local dev: Vitest + Vite resolver + tsconfig `moduleResolution: "bundler"` + `allowImportingTsExtensions`.
- Runtime (when installed via `pi`): The `pi` tool uses Bun, which natively supports these imports for extensions.

**Note:** Bun is still the runtime for the `pi` CLI and extension host. This migration makes *development and publishing* 100% npm-native while preserving full compatibility with Pi.

## Publishing (manual npm release)

This package is published to npm for consumption via `pi install npm:pi-xai`.

1. Update version in `package.json` (or use `npm version patch|minor|major`).
2. Update `CHANGELOG.md` with the new version entry.
3. Commit the changes.
4. Run verification: `npm run check && npm test && npm pack --dry-run`.
5. `npm publish` (or `npm publish --dry-run` to inspect the tarball contents).

The published tarball contains only the necessary files (`index.ts`, `xai-*.ts`, `tsconfig.json`, `README.md`, `CHANGELOG.md`, `LICENSE`) thanks to the `files` field — no tests, no example providers, no dev configs.

The `pi` field in package.json tells the Pi extension loader which file to load.

## Implementation notes

The implementation was double-checked against the referenced Hermes Agent xAI OAuth commit (PKCE/device, JWT exp+skew, typed errors, auxiliary routing equivalent via effective key, refresh rotation, 401 signaling). Fixes applied for error guards, JWT-based expiry in resolution, auto-import bug, and reactive 401 flag.
