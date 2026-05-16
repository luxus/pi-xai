/**
 * xAI Grok Build / Coding Plan OAuth support for the Pi extension.
 *
 * `/login grok-build` supports two paths:
 *
 * 1. **Import existing `grok login`** (Recommended when available)
 *    - Uses tokens from the official Grok CLI (`~/.grok/auth.json`)
 *    - Guarantees you're using your actual Coding Plan / Grok Build subscription.
 *
 * 2. **Native Device Code Flow** (no grok binary required)
 *    - Pure native login using the same public client as the official CLI.
 *    - Works completely without installing or running `grok`.
 *
 * The command intelligently offers both options when possible.
 *
 * Inspired by Hermes Agent PRs #25968 and #25941.
 */

import type { OAuthCredentials, OAuthLoginCallbacks } from "@mariozechner/pi-ai";
import { existsSync, readFileSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

// =============================================================================
// Constants (match official Grok CLI / Hermes exactly)
// =============================================================================

export const XAI_OAUTH_ISSUER = "https://auth.x.ai";
export const XAI_OAUTH_DEVICE_CODE_URL = "https://auth.x.ai/oauth2/device/code";
export const XAI_OAUTH_TOKEN_URL = "https://auth.x.ai/oauth2/token";
export const XAI_OAUTH_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
export const XAI_OAUTH_SCOPE = "openid profile email offline_access grok-cli:access api:access";
export const XAI_ACCESS_TOKEN_REFRESH_SKEW_SECONDS = 300; // 5 min

export let GROK_CLI_AUTH_PATH = resolve(homedir(), ".grok", "auth.json");
export const GROK_CLI_AUTH_CLIENT_ID = XAI_OAUTH_CLIENT_ID; // same client

// =============================================================================
// Typed error + JWT helpers (hardening matching Hermes Agent xAI OAuth)
// =============================================================================

export class XaiAuthError extends Error {
  reloginRequired: boolean;
  code?: string;

  constructor(message: string, options: { reloginRequired?: boolean; code?: string } = {}) {
    super(message);
    this.name = "XaiAuthError";
    this.reloginRequired = !!options.reloginRequired;
    this.code = options.code;
  }
}

function hasReloginRequired(e: unknown): e is { reloginRequired: boolean } {
  return !!e && typeof (e as any).reloginRequired === "boolean";
}

// Simple per-provider in-memory lock (Map of key -> Promise) to serialize
// concurrent refreshXaiToken calls for the same entry. xAI refresh tokens
// are single-use; parallel calls from multi-agent/tools would otherwise
// cause the second to fail with 400/401 (see Hermes credential_pool sync).
const refreshLocks = new Map<string, Promise<any>>();

async function withRefreshLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const existing = refreshLocks.get(key);
  if (existing) return existing as Promise<T>;
  const p = (async () => {
    try {
      return await fn();
    } finally {
      refreshLocks.delete(key);
    }
  })();
  refreshLocks.set(key, p);
  return p;
}

/**
 * Decode JWT payload (base64url) safely. Returns null on any failure.
 * Used for real exp-based expiry checks (matching Hermes _xai_access_token_is_expiring).
 */
export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  if (typeof token !== "string" || !token.includes(".")) return null;
  try {
    const parts = token.split(".");
    if (parts.length < 2) return null;
    let b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    b64 += "=".repeat((4 - (b64.length % 4)) % 4);
    // Bun / modern Node / browser have atob; fallback to Buffer for node
    let json: string;
    if (typeof atob === "function") {
      const binary = atob(b64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
      json = new TextDecoder().decode(bytes);
    } else {
      json = Buffer.from(b64, "base64").toString("utf8");
    }
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Check if the given xAI access_token JWT is expired or within skew seconds of expiry.
 * This is the source-of-truth expiry (JWT exp claim), independent of our stored timestamp.
 */
export function isXaiAccessTokenExpiring(
  accessToken: string,
  skewSeconds: number = XAI_ACCESS_TOKEN_REFRESH_SKEW_SECONDS,
): boolean {
  const payload = decodeJwtPayload(accessToken);
  const exp = payload?.exp;
  if (typeof exp !== "number") return false;
  return exp <= Date.now() / 1000 + Math.max(0, skewSeconds);
}

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

export let PI_AUTH_PATH = resolve(homedir(), ".pi/agent/auth.json");

// (Old browser PKCE helpers removed — we now use Device Code Flow for grok-build)

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
    throw new XaiAuthError(`xAI token refresh failed (${res.status}): ${text}`, {
      reloginRequired: res.status === 400 || res.status === 401,
      code: "xai_refresh_failed",
    });
  }

  let data: any;
  try {
    data = await res.json();
  } catch (e) {
    throw new XaiAuthError(`xAI token refresh returned invalid JSON: ${e}`, {
      reloginRequired: true,
      code: "xai_refresh_invalid_json",
    });
  }
  if (!data || typeof data !== "object" || !data.access_token) {
    throw new XaiAuthError(
      "xAI token refresh response was missing access_token or not a JSON object.",
      { reloginRequired: true, code: "xai_refresh_invalid_response" },
    );
  }
  return data;
}

// =============================================================================
// Grok CLI reader (optional convenience — auto-detect if you already ran `grok login` elsewhere)
// =============================================================================

export function readGrokCliAuth():
  | { accessToken: string; email?: string; source: string }
  | undefined {
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
// Device Code Flow helpers (native login, no grok binary)
// =============================================================================

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval?: number;
}

async function requestDeviceCode(): Promise<DeviceCodeResponse> {
  const body = new URLSearchParams({
    client_id: XAI_OAUTH_CLIENT_ID,
    scope: XAI_OAUTH_SCOPE,
  });

  const res = await fetch(XAI_OAUTH_DEVICE_CODE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new XaiAuthError(`xAI device code request failed (${res.status}): ${text}`, {
      reloginRequired: true,
      code: "xai_device_code_failed",
    });
  }

  try {
    return (await res.json()) as DeviceCodeResponse;
  } catch (e) {
    throw new XaiAuthError(`xAI device code request returned invalid JSON: ${e}`, {
      reloginRequired: true,
      code: "xai_device_invalid_json",
    });
  }
}

async function pollDeviceToken(deviceCode: string): Promise<{
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
}> {
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    client_id: XAI_OAUTH_CLIENT_ID,
    device_code: deviceCode,
  });

  const res = await fetch(XAI_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  let data: any;
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new XaiAuthError(`xAI device token exchange failed (${res.status}): ${text}`, {
      reloginRequired: true,
      code: "xai_device_token_failed",
    });
  }

  try {
    data = await res.json();
  } catch (e) {
    throw new XaiAuthError(`xAI device token exchange returned invalid JSON: ${e}`, {
      reloginRequired: true,
      code: "xai_device_invalid_json",
    });
  }

  if (data?.access_token) {
    return data;
  }

  const error = data?.error || "unknown_error";
  const desc = data?.error_description || "";

  if (error === "authorization_pending") return { access_token: "" };
  if (error === "slow_down") return { access_token: "slow_down" as any };
  if (error === "expired_token")
    throw new XaiAuthError("Device code expired. Please run /login grok-build again.", {
      reloginRequired: true,
      code: "xai_device_expired",
    });
  if (error === "access_denied")
    throw new XaiAuthError("You denied the login request.", {
      reloginRequired: true,
      code: "xai_device_denied",
    });

  throw new XaiAuthError(`Device code token exchange failed: ${error} ${desc}`, {
    reloginRequired: true,
    code: "xai_device_token_failed",
  });
}

async function performNativeDeviceCodeLogin(
  callbacks: OAuthLoginCallbacks,
): Promise<OAuthCredentials> {
  callbacks.onProgress?.("Starting native xAI login (Device Code Flow)...");

  const device = await requestDeviceCode();

  const url = device.verification_uri_complete || device.verification_uri;
  const userCode = device.user_code;

  callbacks.onAuth({
    url,
    instructions:
      `xAI Grok Build / Coding Plan — Native Login (no grok binary required)\n\n` +
      `Open this URL in your browser:\n${url}\n\n` +
      `If asked, enter this code:  ${userCode}\n\n` +
      `Approve the request, and login will complete automatically.`,
  });

  const interval = (device.interval ?? 5) * 1000;
  const expiresAt = Date.now() + (device.expires_in ?? 300) * 1000;

  callbacks.onProgress?.(`Waiting for approval in browser (code: ${userCode})...`);

  while (Date.now() < expiresAt) {
    await new Promise((r) => setTimeout(r, interval));

    try {
      const result = await pollDeviceToken(device.device_code);

      if (result.access_token === "slow_down") {
        await new Promise((r) => setTimeout(r, interval));
        continue;
      }

      if (result.access_token) {
        const access = result.access_token;
        const refresh = result.refresh_token ?? "";
        const expiresIn = result.expires_in ?? 3600;
        const expires =
          Date.now() + expiresIn * 1000 - XAI_ACCESS_TOKEN_REFRESH_SKEW_SECONDS * 1000;

        callbacks.onProgress?.("Native login successful!");
        return { access, refresh, expires, source: "native-device-code" };
      }
    } catch (err: any) {
      if (err.message.includes("expired")) throw err;
    }
  }

  throw new Error("Device code login timed out. Please try again.");
}

// =============================================================================
// Import from official `grok login` (the binary)
// =============================================================================

function importFromGrokCli(grokCli: { accessToken: string; email?: string }): OAuthCredentials {
  const now = Date.now();
  const payload = decodeJwtPayload(grokCli.accessToken);
  const exp =
    typeof payload?.exp === "number"
      ? payload.exp * 1000 - XAI_ACCESS_TOKEN_REFRESH_SKEW_SECONDS * 1000
      : now + 24 * 60 * 60 * 1000;
  return {
    access: grokCli.accessToken,
    refresh: "", // grok CLI tokens usually cannot be refreshed via this flow
    expires: Math.max(now, exp), // accurate from JWT if present, else optimistic
    source: "grok-cli-import",
    email: grokCli.email,
  };
}

// =============================================================================
// Main login function for `/login grok-build`
// =============================================================================

export async function loginXai(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
  const existing = readGrokCliAuth();

  // If we have a local `grok login` session, give the user a choice
  if (existing?.accessToken) {
    const cb: any = callbacks;
    const hasSelect = typeof cb.onSelect === "function";

    if (hasSelect) {
      const choice = await cb.onSelect!({
        message:
          `Found existing Grok CLI login${existing.email ? ` for ${existing.email}` : ""}.\n\n` +
          `How do you want to authenticate for Grok Build / Coding Plan?`,
        options: [
          {
            id: "import",
            label:
              "Import existing `grok login` (Recommended — guaranteed to use your Coding Plan subscription)",
          },
          {
            id: "native",
            label: "Fresh native login (no grok binary needed)",
          },
        ],
      });

      if (choice === "import") {
        callbacks.onProgress?.("Importing credentials from Grok CLI...");
        return importFromGrokCli(existing);
      }
      // else fall through to native
    } else {
      // No onSelect support — just import automatically (best effort)
      callbacks.onProgress?.(
        `Found existing Grok CLI login${existing.email ? ` (${existing.email})` : ""}. Importing...`,
      );
      return importFromGrokCli(existing);
    }
  }

  // No existing grok CLI login, or user chose native → do Device Code Flow
  return performNativeDeviceCodeLogin(callbacks);
}

export async function refreshXaiToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
  if (!credentials.refresh) {
    // Imported token from ~/.grok/auth.json (no refresh token was stored).
    // User should do a real /login grok-build for a managed, refreshable session.
    throw new Error(
      "This xAI token was imported from the grok CLI and has no refresh token. Run `/login grok-build` for a fully managed OAuth session (works without the grok binary).",
    );
  }

  try {
    const token = await refreshXaiAccessToken(credentials.refresh);

    const access = token.access_token;
    const refresh = token.refresh_token ?? credentials.refresh;
    const expiresIn = token.expires_in ?? 3600;
    const expires = Date.now() + expiresIn * 1000 - XAI_ACCESS_TOKEN_REFRESH_SKEW_SECONDS * 1000;

    return { ...credentials, access, refresh, expires };
  } catch (err: any) {
    if (hasReloginRequired(err) && err.reloginRequired) {
      throw new Error("xAI refresh token expired or revoked. Please run /login grok-build again.");
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
    if (
      grokBuildEntry.type === "api_key" &&
      typeof grokBuildEntry.key === "string" &&
      grokBuildEntry.key.trim()
    ) {
      return { apiKey: grokBuildEntry.key.trim(), source: `pi-auth:${PI_AUTH_PATH}:grok-build` };
    }

    if (grokBuildEntry.type === "oauth" && grokBuildEntry.access) {
      const storedExpired =
        typeof grokBuildEntry.expires === "number" && Date.now() >= grokBuildEntry.expires;
      const jwtExpiring = isXaiAccessTokenExpiring(grokBuildEntry.access as string);
      if ((storedExpired || jwtExpiring) && grokBuildEntry.refresh) {
        const refreshed = await withRefreshLock("grok-build", async () => {
          const r = await refreshXaiToken({
            access: grokBuildEntry.access!,
            refresh: grokBuildEntry.refresh as string,
            expires: grokBuildEntry.expires as number,
          });
          try {
            const current = piAuth!;
            current["grok-build"] = { ...current["grok-build"], ...r, type: "oauth" };
            const dir = dirname(PI_AUTH_PATH);
            if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
            writeFileSync(PI_AUTH_PATH, JSON.stringify(current, null, 2));
            chmodSync(PI_AUTH_PATH, 0o600);
          } catch (writeErr) {
            console.warn(
              `[pi-xai] Failed to persist refreshed xAI token for grok-build: ${writeErr}`,
            );
          }
          return r;
        });
        return {
          apiKey: refreshed.access,
          source: `pi-auth:${PI_AUTH_PATH}:grok-build (refreshed)`,
        };
      }
      return {
        apiKey: grokBuildEntry.access,
        source: `pi-auth:${PI_AUTH_PATH}:grok-build (oauth)`,
      };
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
      const storedExpired = typeof xaiEntry.expires === "number" && Date.now() >= xaiEntry.expires;
      const jwtExpiring = isXaiAccessTokenExpiring(xaiEntry.access as string);
      if ((storedExpired || jwtExpiring) && xaiEntry.refresh) {
        const refreshed = await withRefreshLock("xai", async () => {
          const r = await refreshXaiToken({
            access: xaiEntry.access!,
            refresh: xaiEntry.refresh as string,
            expires: xaiEntry.expires as number,
          });
          try {
            const current = piAuth!;
            current.xai = { ...current.xai, ...r, type: "oauth" };
            const dir = dirname(PI_AUTH_PATH);
            if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
            writeFileSync(PI_AUTH_PATH, JSON.stringify(current, null, 2));
            chmodSync(PI_AUTH_PATH, 0o600);
          } catch (writeErr) {
            console.warn(`[pi-xai] Failed to persist refreshed xAI token for xai: ${writeErr}`);
          }
          return r;
        });
        return { apiKey: refreshed.access, source: `pi-auth:${PI_AUTH_PATH}:xai (refreshed)` };
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
    return {
      apiKey: options.settingsApiKey,
      source: options.settingsSource || "settings:xai.apiKey",
    };
  }

  return undefined;
}

// =============================================================================
// Auto-import (convenience only): if you already have a valid ~/.grok/auth.json
// from the official CLI, we make it available under the "grok-build" provider
// without requiring any action. The primary supported path remains `/login grok-build`.
// =============================================================================

/**
 * Silently imports a Grok CLI login from ~/.grok/auth.json into the "grok-build"
 * provider on extension startup (if nothing is stored yet).
 *
 * This is purely for convenience. The interactive `/login grok-build` command
 * now gives you an explicit, nice choice between importing your local `grok login`
 * or doing a fresh native device code login.
 */
export async function autoImportGrokCliIfNeeded(): Promise<boolean> {
  const grok = readGrokCliAuth();
  if (!grok?.accessToken) return false;

  const piAuth = readPiAuthFile() || {};
  const grokBuildExistingEarly = piAuth["grok-build"];

  // Don't clobber if we already have a "grok-build" entry (user explicitly logged in or previously imported)
  if (grokBuildExistingEarly && (grokBuildExistingEarly.access || grokBuildExistingEarly.key)) {
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
  const payload = decodeJwtPayload(grok.accessToken);
  const exp =
    typeof payload?.exp === "number"
      ? payload.exp * 1000 - XAI_ACCESS_TOKEN_REFRESH_SKEW_SECONDS * 1000
      : now + 24 * 60 * 60 * 1000;
  const grokBuildEntry = {
    type: "oauth" as const,
    access: grok.accessToken,
    refresh: undefined,
    expires: Math.max(now, exp),
    source: "grok-cli",
    email: grok.email,
    imported_at: new Date().toISOString(),
  };

  piAuth["grok-build"] = grokBuildEntry;

  // Do NOT automatically write under "xai" — that would make the normal
  // xai (API key) path appear as an OAuth subscription. We only want grok-build
  // (this extension's xAI (Grok Build) provider) to show under Subscriptions.

  try {
    const dir = dirname(PI_AUTH_PATH);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(PI_AUTH_PATH, JSON.stringify(piAuth, null, 2));
    chmodSync(PI_AUTH_PATH, 0o600);

    // Non-fatal log for the user
    if (typeof console !== "undefined" && console.log) {
      console.log(
        `[pi-xai] Auto-imported Grok Build credentials (${grok.email ?? "unknown"}) into ~/.pi/agent/auth.json under "grok-build"`,
      );
    }
    return true;
  } catch (err) {
    // Silent fail — user can still use the tools via the direct grok cli reader
    return false;
  }
}

// =============================================================================
// Test-only path injection (for hermetic tests — bug #3)
// Allows tests to point readers/autoImport/getEffective at temp files
// without touching real ~/.grok or ~/.pi. Call setters before exercising
// the functions; tests are responsible for writing content and cleanup.
// =============================================================================
export function __setTestGrokCliAuthPath(p: string): void {
  GROK_CLI_AUTH_PATH = p;
}
export function __setTestPiAuthPath(p: string): void {
  PI_AUTH_PATH = p;
}
export function __resetTestPathsToDefaults(): void {
  GROK_CLI_AUTH_PATH = resolve(homedir(), ".grok", "auth.json");
  PI_AUTH_PATH = resolve(homedir(), ".pi/agent/auth.json");
}
