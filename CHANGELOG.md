# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
