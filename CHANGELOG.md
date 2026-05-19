# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.8.3] - 2026-05-19

### Improved / Hermes-like aggressive parity + docs + release

- **Follow-up fix round on aggressive payload mode (IMPL 199d6924, atop a2042b0e)**: Addressed remaining review items from the Hermes port.
  - Added clear **"Limitations" subsection** to the `normalizeForXai` JSDoc and the top-level `payloadMode` comment block in `index.ts`, explicitly documenting that rich `xai_*` tools and `callXaiResponses` paths receive only enhanced-compatible normalization (no reasoning strip) even under `payloadMode="aggressive"` — due to the no-new-helper / extend-existing-inline-sites constraint.
  - Improved "Hermes parity" references throughout docs (top comment, JSDoc, aggressive block): shifted emphasis from older BlockedPath analysis to the fresh 2026-05-19 Hermes agent clone exploration (`/tmp/hermes-agent-clone`) and the *specific patterns ported* (reasoning-item strip from `codex_responses_adapter._chat_messages_to_responses_input` `is_xai_responses` handling + `has_codex_reasoning`/follower logic, codex transport `include:[]` + encrypted skip for xAI).
  - Added explanatory comment on the intentional (constraint-driven) redundancy of content normalization (runs in the universal compatible block + again post-strip inside aggressive branch).
  - Minor polish on TODO cross-reference (now generically references "prior review decision on duplication under the no-new-helper constraint").
- **README overhaul (new dedicated section)**: Added "Payload normalization modes (`compatible` vs `aggressive`)" with user-facing explanation of both modes, what aggressive now delivers (Hermes-like guarantees with explicit clone/pattern citations), when users should consider switching (high-reasoning, long tool sessions, sibling dev, prior 400s), the sibling `normalizeForXai` helper story, and the rich-tools limitation.
- **Release 0.8.3 prep**: Version bump, this CHANGELOG entry. All under the project's permanent "smallest possible diff + default unchanged + document every cast + single provider" rules. No behavior change for `compatible` users.

All quality gates (typecheck, tests, lint) passed. Aggressive is now *substantially* more Hermes-like for the exact recurring 400 class when opted in, while limitations and the "why" are fully transparent.

## [0.8.2] - 2026-05-19

### Fixed

- **Hardened 400 defense for direct Responses calls**: The previous 0.8.1 fix (content normalization in `before_provider_request`) covered normal agentic chat. Added the identical normalization inside `callXaiResponses` (used by all rich tools: `xai_generate_text`, `xai_x_search`, `xai_web_search`, `xai_multi_agent`, etc.). This also protects paths taken by sibling extensions (`pi-xai-imagine`, `pi-xai-voice`) during local development and any direct `/responses` usage. Matches the reproduction in the `pi-xai-imagine` workspace with high reasoning + multi-turn UI discussion.

All changes continue the project's strict "smallest possible diff + no new helpers + extend existing patterns" discipline.

## [0.8.1] - 2026-05-18

### Fixed

- **Critical 400 error after tool-using turns**: `"Invalid request content: Each message must have at least one content element."` when using grok-4.3 (grok-build) with agentic tools (`x_search`, `web_search`, etc.). The openai-responses driver could emit `content: []` (or `null` / `""`) on role-bearing history items after a tool result turn. Added a minimal defensive normalizer inside the existing `before_provider_request` hook (grok-* gate only, in-place mutation, no new helpers). Matches the exact reproduction from the live session log ("latest news on x" → successful tool call → follow-up question).
- **Citation spacing for glued markers**: When the model places a `[[N]]` citation immediately after a URL it verbalized in the same sentence (e.g. `https://x.ai/cli.[[1]](https://x.com/...)`), the output was hard to read. Added targeted post-processing on `message_end` (normal chat + agentic mode) and inside `formatResponseSummary` (all rich tools) that inserts a separating space. Produces clean `url. [[N]](...)` while keeping the smallest possible diff and respecting the existing architecture.

All changes followed the project's "smallest possible diff + extend existing patterns + document against memory" rules. Full typecheck / lint / format gates passed.

## [0.8.0] - 2026-05-18

### Major alignment with official xAI Responses API and reference implementation

- Complete verification against the canonical `BlockedPath/pi-xai-oauth` extension and 10 upstream Hermes Agent commits from `NousResearch/hermes-agent`.
- Hardened Web PKCE login flow to match the exact token exchange requirements from Hermes (defensive `code_challenge` echo + verifier guard at the authorization code exchange step).
- Full payload sanitization and tool name correctness (`code_interpreter`) for the Responses API.
- `reasoningEffort` parameter now available on `xai_generate_text`.
- Advanced filters for built-in tools (`web_search` / `x_search`) supported via object form in the rich tools.
- Richer citation output (structured annotation counts).
- `collections_search` support (with safe defaults to avoid 422 errors).

### Preparation for sibling extensions

- `pi-xai` now exports its credential resolution logic (`getEffectiveXaiApiKey`, `resolveXaiConfig`, etc.).
- `pi-xai-imagine` and `pi-xai-voice` have been upgraded to depend on `pi-xai` and **prefer Grok Build OAuth** (from `/login grok-build`) when available, with automatic fallback to local logic.
- This means users only need to authenticate once with the main extension — the other two will automatically pick up the Coding Plan / Grok Build token.

All changes followed the project's strict "smallest possible diff" and "extend existing patterns" discipline. Full quality gates passed.

## [0.7.1] - 2026-05-18

### Hotfix

- Removed `"collections_search"` from the automatic agentic tool defaults.  
  This tool requires a `vector_store_ids` array and was causing 422 errors (`missing field 'vector_store_ids'`) for all users with default agentic mode enabled (the majority of users).  
  The rich tools (`xai_generate_text` / `xai_multi_agent`) continue to support `collections_search` when passed with proper configuration.

## [0.7.0] - 2026-05-18

### Full alignment with official xAI Responses API documentation

- Complete audit against all official developer docs (generate-text, reasoning, structured-outputs, streaming, multi-agent, function-calling, web-search, x-search, code-execution, citations, streaming-and-sync, tools overview, collections-search).
- **New power-user capabilities in the rich tools**:
  - `reasoningEffort` parameter now available on `xai_generate_text` (parity with `xai_multi_agent` and normal grok-\* chat).
  - Advanced built-in tool filters fully supported: `web_search` / `x_search` now accept full config objects with `allowed_domains`, `from_date`/`to_date`, `enable_image_understanding`, `enable_video_understanding`, `allowed_x_handles`, etc.
- **Better observability**:
  - Richer citation output now includes structured annotation count (`inline annotations: N`) when the model emits `annotations[]` on output text.
- **Agentic mode improvements**:
  - `collections_search` added to the default agentic tool set (alongside `web_search`, `x_search`, `code_interpreter`).
- **Wire-format correctness**:
  - Built-in code tool correctly uses the official Responses API name `code_interpreter` (not the SDK alias).
- All changes were the absolute smallest possible diffs, strictly following the project's "smallest change + extend existing patterns + no new helpers" discipline. No test, README (beyond this release), or architecture changes.
- Full quality gates on every edit.

## [0.6.3] - 2026-05-17

### Documentation

- Added official pi-xai logo to the top of the README.

## [0.6.2] - 2026-05-17

### Documentation improvements

- Shortened the SuperGrok Heavy subscription section to a concise, practical hint.
- Added the promotional image showing the limited-time offer ($99/month for 6 months when upgrading from SuperGrok, which has a free 3-day trial).

## [0.6.1] - 2026-05-17

### Quickfix: Compatibility with @earendil-works Pi packages

- Switched runtime dependencies from the `@mariozechner/*` fork to the current `@earendil-works/pi-coding-agent` + `@earendil-works/pi-ai` packages (matching the runtime used by the second extension and modern Pi).
- Updated all imports and one stale comment.
- No behavior or API changes for users. This is a compatibility shim so the 0.6.0 feature set (Web PKCE OAuth + 5 tools) works correctly on current Pi installs.

## [0.6.0] - 2026-05-16

### Full surface parity with https://github.com/BlockedPath/pi-xai-oauth

- **OAuth**: `/login grok-build` now offers Web PKCE (browser auto-open + manual redirect URL paste fallback for VPN/Docker/remote) as the recommended native path, with Device Code as explicit fallback. Integrated OIDC discovery, robust callback server, state/nonce/PKCE, and improved `~/.grok/auth.json` parsing while preserving all existing JWT refresh locking, auto-import (grok-build only), and credential resolution.
- **Tools**: Added the three experimental agentic tools (`xai_web_search`, `xai_x_search`, `xai_code_execution`) as first-class explicit callable tools (lightweight prompt simulations using Grok). This gives the full "5 tools" surface the second extension advertises, while the two rich tools (`xai_generate_text`, `xai_multi_agent`) and native built-in tool injection remain the powerful core.
- `usesCallbackServer: true` on the provider enables the core's manual-paste UI.
- All changes keep the 4-file structure, zero duplication of superior paths, and pass full quality gates (format/lint/tsgo + 9/9 tests).
- Updated README and this changelog. Version bumped to 0.6.0.

## [0.5.0] - 2026-05-16

### Final review closure + verification

- All 8 issues from the post-refactor review addressed (2 bugs + 2 suggestions + 4 nits).
  - Fixed reasoning-model timeout heuristic (`grok-4.3*` / `grok-build` now correctly get 1h timeout).
  - Removed dead `generatePKCE` / `base64urlEncode` code left from old browser PKCE flow.
  - Extracted small typed `callXaiResponses` helper (eliminated duplication and `as any` casts).
  - Cleaned up stale test names, headers, and comments.
  - Zero-config `oxlint` now reports 0 warnings (`catch {}` style).
- One final nit in review artifacts resolved (self-referential "Status: open" phrasing).
- Full verification passes with the modern stack:
  - `oxfmt --check` (defaults only)
  - `tsgo --noEmit` (sole type checker)
  - `oxlint` (zero-config, 0 warnings/0 errors)
  - `vitest` (9/9 hermetic OAuth tests)
- Package is now in its final polished state after the complete issue #1 refactor.

## [0.4.0] - 2026-05-16

### Massive simplification (target: clean `grok-build` provider for Coding Plan users)

- **Exactly 4 source `.ts` files**: `index.ts`, `xai-oauth.ts`, `xai-provider.ts`, `xai-config.ts`.
- Deleted 3 low-value tools (`xai_web_search`, `xai_code_execution`, `xai_collections_search`).
- Deleted `xai-client.ts`, `xai-text.ts`, `xai-text-shared.ts` (Responses logic inlined into the 2 remaining tools).
- `xai-config.ts` reduced to tiny essentials (baseUrl + agentic settings only; credential logic moved to `xai-oauth`).
- `xai-oauth.ts` kept in full (device code, JWT exp+skew refresh lock, grok CLI import choice, `getEffectiveXaiApiKey`, `autoImport`).
- Agentic hook (`before_provider_request` for `grok-*`) and exactly 2 tools (`xai_generate_text`, `xai_multi_agent`) preserved.
- Duplicated summary helpers extracted to single `formatResponseSummary`.
- All long historical comments removed; provider and index slimmed.

### New dev tooling (zero-config, 10-50x faster pre-commit)

- `oxlint` (zero-config) + `oxfmt` (completely default, no config file) + `tsgo` (`@typescript/native-preview`) as the _sole_ type checker.
- `npm run check` / `typecheck` = `tsgo --noEmit` (no `tsc --noEmit` left anywhere).
- `npm run lint` / `lint:fix`, `npm run format` / `format:check`.
- `lint-staged` + husky pre-commit: `["oxfmt --write", "oxlint", "tsgo --noEmit"]`.
- `husky` + `prepare` script properly integrated (modern hook, no deprecated lines).
- All commits leave the repo in green state (`npm run check && npm test`).

### Documentation & tests

- README reduced to ~1/3 length, focused only on the 2 tools + provider + agentic + OAuth.
- Tests pruned from 19 to 9 essential OAuth/JWT/refresh/getEffective cases (still 100% hermetic coverage of what the tools depend on).
- Version bumped to 0.4.0; CHANGELOG updated.

The package is now the smallest possible custom `grok-build` provider while preserving the full sophisticated OAuth and the "magic" agentic experience users love.

## [0.3.0] - 2026-05-16

### Changed (fast release scope)

- **Focused exclusively on "xAI (Grok Build)" via the `grok-build` provider.** Removed the generic `xai` provider registration (Pi ships its own built-in `xai` provider for API key users). This extension is now unapologetically about the subscription experience (`/login grok-build`) powered by the modern Responses API (`openai-responses`) + native tool calling.
- The powerful tools (`xai_generate_text`, `xai_multi_agent`, `xai_web_search`, etc.) remain first-class and work with Grok Build credentials (or fallback XAI_API_KEY).
- Updated OAuth display name to "xAI (Grok Build)".
- Branded README, comments, and model lists around the Coding Plan / Grok Build use case. No more dual-provider mental model or chat completions references.
- Model list for `grok-build` kept exactly as specified in Hermes PR #25941.

### Changed (tooling)

- **Complete migration to npm for development and publishing.** Removed all Bun-specific tooling from the developer workflow.
  - `bunx tsc`, `bun run`, and `bun install` references eliminated from `package.json` scripts and `lint-staged`.
  - Type checking now uses plain `tsc --noEmit` (fully supported by the existing `tsconfig.json` with `moduleResolution: "bundler"` and `allowImportingTsExtensions: true`).
  - Tests continue to use Vitest (`npm test` / `vitest run`).
  - Pre-commit hooks via husky + lint-staged now invoke `tsc --noEmit` and `vitest run` directly (no npm script overhead in hooks).
- Removed `@types/bun` from `devDependencies` and the `"types": ["bun"]` entry from `tsconfig.json`.
- Deleted `bun.lock`; `package-lock.json` is now committed (standard for npm packages; `.gitignore` updated).
- Refined `"files"` field in `package.json` for a clean, minimal npm tarball (only `index.ts`, `xai-*.ts`, `tsconfig.json`, `README.md` are published — no dev-only files like `vitest.config.ts` or `tests/`).
- Added `"engines": { "node": ">=18" }` for clarity on npm publish.
- Bumped version from `0.2.0` to `0.3.0` for this tooling milestone.
- Removed both example provider directories (`custom-provider-xai/` and `custom-provider-ollama/`) to reduce confusion and maintenance burden. The package now focuses exclusively on the main extension code (the `grok-build` provider + tools) rather than example templates. These were legacy experiments/templates that were never part of the published npm tarball.

### Documentation

- **README.md completely updated**:
  - Development section now documents a pure `npm` workflow with no Bun mentions.
  - Added clear explanation of why explicit `.ts` imports are retained (required by the `pi` Bun runtime for extension loading).
  - New **Publishing (manual npm release)** section with step-by-step instructions for `npm publish`.
  - Reorganized implementation notes for clarity.
- Added this `CHANGELOG.md` to track future releases.

### Notes for consumers and contributors

- **Runtime compatibility unchanged**: The extension is still installed with `pi install npm:pi-xai` and loaded by the Bun-based `pi` tool. The migration only affects _how you develop and release_ the package.
- You can now run the entire dev loop (`npm install && npm run check && npm test`) with nothing but Node.js + npm in your environment.
- Manual release process (as requested): update version + CHANGELOG, then `npm publish`.

## [0.2.0] - Previous

- Initial public release with xAI Responses API support, multi-agent research, OAuth (`/login grok-build`), JWT handling, agentic tool injection, etc.
- 19+ focused unit tests for auth paths.
- Dual-provider design (`xai` + `grok-build`).
