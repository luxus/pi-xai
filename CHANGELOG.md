# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
