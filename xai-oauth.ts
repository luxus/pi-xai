/**
 * xAI Grok Build / Coding Plan OAuth support for the Pi extension.
 *
 * - Native browser PKCE OAuth login for `/login grok-build` (uses the exact same public
 *   desktop OAuth client as the official Grok CLI and apps — no binary required)
 * - Optional silent auto-import from ~/.grok/auth.json (if you happen to have run `grok login` elsewhere)
 * - Proper token refresh for sessions created via `/login grok-build`
 * - Works for both the provider override and the direct xai_* tools
 *
 * The primary, fully supported auth path is the native OAuth flow.
 * The grok CLI binary is never needed.
 *
 * Inspired by Hermes Agent PRs #25968 and #25941 (xAI OAuth + Coding Plan).
 */

import type { OAuthCredentials, OAuthLoginCallbacks } from "@mariozechner/pi-ai";
import { existsSync, readFileSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

// =============================================================================
// Constants (match official Grok CLI / Hermes exactly)
// =============================================================================

export const XAI_OAUTH_ISSUER = "https://auth.x.ai";
export const XAI_OAUTH_AUTHORIZE_URL = "https://auth.x.ai/oauth/authorize";
export const XAI_OAUTH_TOKEN_URL = "https://auth.x.ai/oauth/token";
export const XAI_OAUTH_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
export const XAI_OAUTH_SCOPE =
  "openid profile email offline_access grok-cli:access api:access";
export const XAI_OAUTH_REDIRECT_URI = "http://127.0.0.1:8765/xai/callback"; // common desktop-style; paste fallback is reliable
export const XAI_ACCESS_TOKEN_REFRESH_SKEW_SECONDS = 300; // 5 min

export const GROK_CLI_AUTH_PATH = resolve(homedir(), ".grok", "auth.json");
export const GROK_CLI_AUTH_CLIENT_ID = XAI_OAUTH_CLIENT_ID; // same client

// Local PKCE generator (Web Crypto, works in Node 20+/Bun + browsers).
// Matches the implementation in @mariozechner/pi-ai utils/oauth/pkce.ts
function base64urlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

async function generatePKCE(): Promise<{ verifier: string; challenge: string }> {
  const verifierBytes = new Uint8Array(32);
  crypto.getRandomValues(verifierBytes);
  const verifier = base64urlEncode(verifierBytes);

  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const challenge = base64urlEncode(new Uint8Array(hashBuffer));

  return { verifier, challenge };
}

export const PI_AUTH_PATH = resolve(homedir(), ".pi/agent/auth.json");

// =============================================================================
// Small helpers
// =============================================================================

function parseAuthorizationInput(input: string): { code?: string; state?: string } {
  const value = input.trim();
  if (!value) return {};

  // Full redirect URL?
  try {
    const url = new URL(value);
    return {
      code: url.searchParams.get("code") ?? undefined,
      state: url.searchParams.get("state") ?? undefined,
    };
  } catch {
    // not a URL
  }

  if (value.includes("#")) {
    const [code, state] = value.split("#", 2);
    return { code, state };
  }

  if (value.includes("code=")) {
    const params = new URLSearchParams(value);
    return {
      code: params.get("code") ?? undefined,
      state: params.get("state") ?? undefined,
    };
  }

  return { code: value };
}

async function exchangeXaiCodeForTokens(params: {
  code: string;
  code_verifier: string;
  redirect_uri: string;
}): Promise<{ access_token: string; refresh_token?: string; expires_in?: number }> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: XAI_OAUTH_CLIENT_ID,
    code: params.code,
    redirect_uri: params.redirect_uri,
    code_verifier: params.code_verifier,
  });

  const res = await fetch(XAI_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`xAI token exchange failed (${res.status}): ${text}`);
  }

  const data = (await res.json()) as any;
  if (!data?.access_token) {
    throw new Error("xAI token exchange returned no access_token");
  }
  return data;
}

async function refreshXaiAccessToken(refreshToken: string): Promise<{
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
}> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: XAI_OAUTH_CLIENT_ID,
    refresh_token: refreshToken,
  });

  const res = await fetch(XAI_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const err = new Error(`xAI token refresh failed (${res.status}): ${text}`);
    (err as any).reloginRequired = res.status === 400 || res.status === 401;
    throw err;
  }

  const data = (await res.json()) as any;
  if (!data?.access_token) {
    throw new Error("xAI refresh returned no access_token");
  }
  return data;
}

// =============================================================================
// Grok CLI reader (optional convenience — auto-detect if you already ran `grok login` elsewhere)
// =============================================================================

export function readGrokCliAuth(): { accessToken: string; email?: string; source: string } | undefined {
  if (!existsSync(GROK_CLI_AUTH_PATH)) return undefined;

  try {
    const raw = readFileSync(GROK_CLI_AUTH_PATH, "utf8").trim();
    if (!raw) return undefined;

    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") return undefined;

    const targetPrefix = "https://auth.x.ai::";
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof key !== "string" || !key.startsWith(targetPrefix)) continue;
      if (!key.includes(GROK_CLI_AUTH_CLIENT_ID)) continue;
      if (!value || typeof value !== "object") continue;

      const entry = value as Record<string, unknown>;
      const access = entry.key || entry.access_token;
      if (typeof access === "string" && access.trim()) {
        return {
          accessToken: access.trim(),
          email: typeof entry.email === "string" ? entry.email : undefined,
          source: `grok-cli:${GROK_CLI_AUTH_PATH}`,
        };
      }
    }
  } catch {
    // corrupt file — ignore
  }
  return undefined;
}

// =============================================================================
// Pi auth.json reader (supports both api_key and oauth for "xai")
// =============================================================================

interface PiAuthFile {
  [provider: string]: {
    type?: "api_key" | "oauth";
    key?: string;
    access?: string;
    refresh?: string;
    expires?: number;
    [k: string]: unknown;
  };
}

function readPiAuthFile(): PiAuthFile | undefined {
  if (!existsSync(PI_AUTH_PATH)) return undefined;
  try {
    const raw = readFileSync(PI_AUTH_PATH, "utf8").trim();
    if (!raw) return undefined;
    return JSON.parse(raw) as PiAuthFile;
  } catch {
    return undefined;
  }
}

// =============================================================================
// High-level login / refresh (for registerProvider oauth block)
// =============================================================================

export async function loginXai(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
  // Native PKCE OAuth login using the same public desktop client that powers the official Grok CLI and apps.
  // This flow works completely without the grok binary — no external CLI required.
  const { verifier, challenge } = await generatePKCE();
  const state = (globalThis as any).crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);

  const authUrl =
    `${XAI_OAUTH_AUTHORIZE_URL}?` +
    new URLSearchParams({
      response_type: "code",
      client_id: XAI_OAUTH_CLIENT_ID,
      redirect_uri: XAI_OAUTH_REDIRECT_URI,
      scope: XAI_OAUTH_SCOPE,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state,
    }).toString();

  callbacks.onAuth({
    url: authUrl,
    instructions:
      "This is a native OAuth login for xAI Grok Build / Coding Plan (same client used by the official Grok desktop apps and CLI).\n\n" +
      "No grok binary is required. Just log in with your xAI account that has the Coding Plan subscription.\n\n" +
      "After the browser redirects, copy the authorization code (or the full URL containing ?code=...) and paste it back here.",
  });

  callbacks.onProgress?.("Waiting for you to complete login in the browser and paste the code...");

  const input = await callbacks.onPrompt({
    message: "Paste the code or redirect URL from the browser:",
  });

  const { code, state: returnedState } = parseAuthorizationInput(input);

  if (!code) {
    throw new Error("No authorization code provided");
  }
  if (returnedState && returnedState !== state) {
    throw new Error("State mismatch — possible CSRF or copy error");
  }

  const token = await exchangeXaiCodeForTokens({
    code,
    code_verifier: verifier,
    redirect_uri: XAI_OAUTH_REDIRECT_URI,
  });

  const access = token.access_token;
  const refresh = token.refresh_token ?? "";
  const expiresIn = token.expires_in ?? 3600;
  const expires = Date.now() + expiresIn * 1000 - XAI_ACCESS_TOKEN_REFRESH_SKEW_SECONDS * 1000;

  return { access, refresh, expires };
}

export async function refreshXaiToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
  if (!credentials.refresh) {
    // Imported token from ~/.grok/auth.json (no refresh token was stored).
    // User should do a real /login grok-build for a managed, refreshable session.
    throw new Error("This xAI token was imported from the grok CLI and has no refresh token. Run `/login grok-build` for a fully managed OAuth session (works without the grok binary).");
  }

  try {
    const token = await refreshXaiAccessToken(credentials.refresh);

    const access = token.access_token;
    const refresh = token.refresh_token ?? credentials.refresh;
    const expiresIn = token.expires_in ?? 3600;
    const expires = Date.now() + expiresIn * 1000 - XAI_ACCESS_TOKEN_REFRESH_SKEW_SECONDS * 1000;

    return { ...credentials, access, refresh, expires };
  } catch (err: any) {
    if (err?.reloginRequired) {
      throw new Error("xAI refresh token expired or revoked. Please run /login xai again.");
    }
    throw err;
  }
}

export function getXaiApiKeyFromCredentials(cred: OAuthCredentials): string {
  return cred.access;
}

// =============================================================================
// Combined key resolver used by the extension tools (grok-cli + Pi auth + env + settings)
// =============================================================================

export interface XaiKeyResolution {
  apiKey: string;
  source: string;
}

export async function getEffectiveXaiApiKey(options?: {
  env?: string;
  settingsApiKey?: string;
  settingsSource?: string;
}): Promise<XaiKeyResolution | undefined> {
  const piAuth = readPiAuthFile();

  // ------------------------------------------------------------------
  // Grok Build / Coding Plan preferred
  // We prefer a proper `grok-build` OAuth entry (from `/login grok-build`)
  // or an auto-detected token from the official grok CLI.
  // Plain XAI_API_KEY is only used as a last resort (often only valid for voice).
  // ------------------------------------------------------------------

  // 1. Explicit "grok-build" entry in Pi auth (proper OAuth from Grok Build subscription)
  const grokBuildEntry = piAuth?.["grok-build"];
  if (grokBuildEntry) {
    if (grokBuildEntry.type === "api_key" && typeof grokBuildEntry.key === "string" && grokBuildEntry.key.trim()) {
      return { apiKey: grokBuildEntry.key.trim(), source: `pi-auth:${PI_AUTH_PATH}:grok-build` };
    }

    if (grokBuildEntry.type === "oauth" && grokBuildEntry.access) {
      const isExpired = typeof grokBuildEntry.expires === "number" && Date.now() >= grokBuildEntry.expires;
      if (isExpired && grokBuildEntry.refresh) {
        try {
          const refreshed = await refreshXaiToken({
            access: grokBuildEntry.access,
            refresh: grokBuildEntry.refresh as string,
            expires: grokBuildEntry.expires as number,
          });
          try {
            const current = piAuth!;
            current["grok-build"] = { ...current["grok-build"], ...refreshed, type: "oauth" };
            const dir = dirname(PI_AUTH_PATH);
            if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
            writeFileSync(PI_AUTH_PATH, JSON.stringify(current, null, 2));
            chmodSync(PI_AUTH_PATH, 0o600);
          } catch {}
          return { apiKey: refreshed.access, source: `pi-auth:${PI_AUTH_PATH}:grok-build (refreshed)` };
        } catch (e) {}
      }
      return { apiKey: grokBuildEntry.access, source: `pi-auth:${PI_AUTH_PATH}:grok-build (oauth)` };
    }
  }

  // 2. Direct Grok CLI file (~/.grok/auth.json) — optional fallback if you ran the official CLI elsewhere
  const grok = readGrokCliAuth();
  if (grok) {
    return { apiKey: grok.accessToken, source: grok.source };
  }

  // 3. "xai" entry in Pi auth (from /login xai or previous setup)
  const xaiEntry = piAuth?.xai;
  if (xaiEntry) {
    if (xaiEntry.type === "api_key" && typeof xaiEntry.key === "string" && xaiEntry.key.trim()) {
      return { apiKey: xaiEntry.key.trim(), source: `pi-auth:${PI_AUTH_PATH}:xai` };
    }
    if (xaiEntry.type === "oauth" && xaiEntry.access) {
      const isExpired = typeof xaiEntry.expires === "number" && Date.now() >= xaiEntry.expires;
      if (isExpired && xaiEntry.refresh) {
        try {
          const refreshed = await refreshXaiToken({
            access: xaiEntry.access,
            refresh: xaiEntry.refresh as string,
            expires: xaiEntry.expires as number,
          });
          try {
            const current = piAuth!;
            current.xai = { ...current.xai, ...refreshed, type: "oauth" };
            const dir = dirname(PI_AUTH_PATH);
            if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
            writeFileSync(PI_AUTH_PATH, JSON.stringify(current, null, 2));
            chmodSync(PI_AUTH_PATH, 0o600);
          } catch {}
          return { apiKey: refreshed.access, source: `pi-auth:${PI_AUTH_PATH}:xai (refreshed)` };
        } catch (e) {}
      }
      return { apiKey: xaiEntry.access, source: `pi-auth:${PI_AUTH_PATH}:xai (oauth)` };
    }
  }

  // 4. XAI_API_KEY env var (your voice key, only used if no Grok Build login exists)
  const envKey = (options?.env ?? process.env.XAI_API_KEY)?.trim();
  if (envKey) {
    return { apiKey: envKey, source: "env:XAI_API_KEY" };
  }

  // 5. Legacy settings.json xai.apiKey
  if (options?.settingsApiKey) {
    return { apiKey: options.settingsApiKey, source: options.settingsSource || "settings:xai.apiKey" };
  }

  return undefined;
}

// =============================================================================
// Auto-import (convenience only): if you already have a valid ~/.grok/auth.json
// from the official CLI, we make it available under the "grok-build" provider
// without requiring any action. The primary supported path remains `/login grok-build`.
// =============================================================================

/**
 * If a valid Grok CLI login exists in ~/.grok/auth.json but no "grok-build" entry
 * yet exists in Pi's auth.json, silently import it.
 *
 * This is a pure convenience for users who already authenticated via the official
 * `grok login` tool for other reasons. The fully supported, binary-free experience
 * is to run `/login grok-build` inside Pi (native OAuth, gets a refresh token).
 *
 * Safe and idempotent.
 */
export async function autoImportGrokCliIfNeeded(): Promise<boolean> {
  const grok = readGrokCliAuth();
  if (!grok?.accessToken) return false;

  const piAuth = readPiAuthFile() || {};
  const existing = piAuth.xai;

  // Don't clobber if user already has something for "xai" (API key or previous OAuth)
  if (existing && (existing.access || existing.key)) {
    return false;
  }

  // Write the Grok Build token as a proper OAuth credential under "grok-build".
  // This makes "Grok Build" correctly appear under Pi's Subscriptions section
  // (which is what the user wants).
  //
  // We deliberately do **not** write it under "xai", because the regular xai
  // provider should only be treated as an API key (the user has a separate
  // console.x.ai API key for voice).
  const now = Date.now();
  const grokBuildEntry = {
    type: "oauth" as const,
    access: grok.accessToken,
    refresh: undefined,
    expires: now + 24 * 60 * 60 * 1000,
    source: "grok-cli",
    email: grok.email,
    imported_at: new Date().toISOString(),
  };

  const grokBuildExisting = piAuth["grok-build"];
  if (!grokBuildExisting || (!grokBuildExisting.access && !grokBuildExisting.key)) {
    piAuth["grok-build"] = grokBuildEntry;
  }

  // Do NOT automatically write under "xai" — that would make the normal
  // xai provider show up as an OAuth subscription, which the user doesn't want.

  try {
    const dir = dirname(PI_AUTH_PATH);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(PI_AUTH_PATH, JSON.stringify(piAuth, null, 2));
    chmodSync(PI_AUTH_PATH, 0o600);

    // Non-fatal log for the user
    if (typeof console !== "undefined" && console.log) {
      console.log(
        `[pi-xai-text] Auto-imported Grok Build credentials (${grok.email ?? "unknown"}) into ~/.pi/agent/auth.json under "xai"`
      );
    }
    return true;
  } catch (err) {
    // Silent fail — user can still use the tools via the direct grok cli reader
    return false;
  }
}
