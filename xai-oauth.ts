/**
 * xAI Grok Build OAuth support for the Pi extension.
 *
 * `/login grok-build` supports two paths:
 *
 * 1. **Import existing `grok login`** (Recommended when available)
 *    - Uses tokens from the official Grok CLI (`~/.grok/auth.json`)
 *    - Uses your SuperGrok / X subscription (Grok Build entitlement).
 *
 * 2. **Native Device Code Flow** (no grok binary required)
 *    - Pure native login using the same public client as the official CLI.
 *    - Works completely without installing or running `grok`.
 *
 * The command intelligently offers both options when possible.
 *
 * Inspired by Hermes Agent PRs #25968 and #25941.
 */

import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import { existsSync, readFileSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { createInterface } from "node:readline";
import { GROK_CLI_VERSION } from "./xai-stream.ts";

// =============================================================================
// Constants (match official Grok CLI / Hermes exactly)
// =============================================================================

export const XAI_OAUTH_ISSUER = "https://auth.x.ai";
export const XAI_OAUTH_DEVICE_CODE_URL = "https://auth.x.ai/oauth2/device/code";
export const XAI_OAUTH_TOKEN_URL = "https://auth.x.ai/oauth2/token";
export const XAI_OAUTH_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
// Official default_oauth2_scopes (xai-org/grok-build auth/config.rs).
export const XAI_OAUTH_SCOPE =
  "openid profile email offline_access grok-cli:access api:access conversations:read conversations:write";
export const XAI_ACCESS_TOKEN_REFRESH_SKEW_SECONDS = 3600; // 1h — Hermes febdddb41 (6h tokens, refresh early)

// PKCE / Web OAuth constants (browser redirect flow support)
export const XAI_OAUTH_DISCOVERY_URL = `${XAI_OAUTH_ISSUER}/.well-known/openid-configuration`;
export const XAI_OAUTH_REDIRECT_HOST = "127.0.0.1";
export const XAI_OAUTH_REDIRECT_PORT = 56121;
export const XAI_OAUTH_REDIRECT_PATH = "/callback";
export let GROK_CLI_AUTH_PATH = resolve(homedir(), ".grok", "auth.json");
export const GROK_CLI_AUTH_CLIENT_ID = XAI_OAUTH_CLIENT_ID; // same client

// Legacy scope key still seen in some older Grok CLI auth.json files
export const XAI_GROK_CLI_LEGACY_AUTH_SCOPE_KEY = "https://accounts.x.ai/sign-in";

// =============================================================================
// PKCE + browser redirect helpers
// =============================================================================

function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

function validateXaiEndpoint(url: string): string {
  const parsed = new URL(url);
  const host = parsed.hostname.toLowerCase();
  if (parsed.protocol !== "https:" || (host !== "x.ai" && !host.endsWith(".x.ai"))) {
    throw new Error(`xAI OAuth discovery returned an unexpected endpoint: ${url}`);
  }
  return url;
}

async function xaiDiscovery(signal?: AbortSignal): Promise<XaiDiscovery> {
  const response = await fetch(XAI_OAUTH_DISCOVERY_URL, {
    headers: { Accept: "application/json" },
    signal,
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new XaiAuthError(`xAI OAuth discovery failed: ${response.status} ${text}`, {
      reloginRequired: true,
      code: "xai_discovery_failed",
    });
  }

  const data = (await response.json()) as Partial<XaiDiscovery>;
  if (!data.authorization_endpoint || !data.token_endpoint) {
    throw new XaiAuthError(
      "xAI OAuth discovery response did not include authorization/token endpoints",
      {
        reloginRequired: true,
        code: "xai_discovery_invalid",
      },
    );
  }

  return {
    authorization_endpoint: validateXaiEndpoint(data.authorization_endpoint),
    token_endpoint: validateXaiEndpoint(data.token_endpoint),
  };
}

function callbackCorsOrigin(origin: string | undefined): string | undefined {
  return origin === "https://accounts.x.ai" || origin === "https://auth.x.ai" ? origin : undefined;
}

async function startCallbackServer(): Promise<{
  redirectUri: string;
  waitForCallback: (signal?: AbortSignal) => Promise<CallbackResult>;
  resolveCallback: (result: CallbackResult) => void;
  close: () => void;
}> {
  let resolveCallback!: (result: CallbackResult) => void;
  const callbackPromise = new Promise<CallbackResult>((resolve) => {
    resolveCallback = resolve;
  });

  const makeServer = () =>
    createServer((req, res) => {
      const origin = callbackCorsOrigin(req.headers.origin);
      const writeCors = () => {
        if (!origin) return;
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type");
        res.setHeader("Access-Control-Allow-Private-Network", "true");
        res.setHeader("Vary", "Origin");
      };

      if (req.method === "OPTIONS") {
        writeCors();
        res.writeHead(204);
        res.end();
        return;
      }

      const url = new URL(req.url || "/", `http://${XAI_OAUTH_REDIRECT_HOST}`);
      if (url.pathname !== XAI_OAUTH_REDIRECT_PATH) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Not found");
        return;
      }

      const result: CallbackResult = {
        code: url.searchParams.get("code") || undefined,
        state: url.searchParams.get("state") || undefined,
        error: url.searchParams.get("error") || undefined,
        error_description: url.searchParams.get("error_description") || undefined,
      };
      resolveCallback(result);

      writeCors();
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        result.error
          ? "<html><body><h1>xAI authorization failed.</h1>You can close this tab.</body></html>"
          : "<html><body><h1>xAI authorization received.</h1>You can close this tab.</body></html>",
      );
    });

  const listen = (port: number): Promise<Server> =>
    new Promise((resolve, reject) => {
      const server = makeServer();
      server.once("error", reject);
      server.listen(port, XAI_OAUTH_REDIRECT_HOST, () => {
        server.removeListener("error", reject);
        resolve(server);
      });
    });

  let server: Server;
  try {
    server = await listen(XAI_OAUTH_REDIRECT_PORT);
  } catch {
    server = await listen(0);
  }

  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new XaiAuthError("Could not determine xAI OAuth callback port", {
      reloginRequired: true,
      code: "xai_callback_port",
    });
  }

  const redirectUri = `http://${XAI_OAUTH_REDIRECT_HOST}:${(address as { port: number }).port}${XAI_OAUTH_REDIRECT_PATH}`;

  const close = () => {
    try {
      server.close();
    } catch {
      // ignore
    }
  };

  return {
    redirectUri,
    close,
    resolveCallback,
    waitForCallback: async (signal?: AbortSignal) => {
      let timer: NodeJS.Timeout | undefined;
      let abortHandler: (() => void) | undefined;

      let timeoutReject: (e: Error) => void;
      const timeout = new Promise<CallbackResult>((_, reject) => {
        timeoutReject = reject;
        timer = setTimeout(
          () => reject(new Error("Timed out waiting for xAI OAuth callback")),
          180_000,
        );
      });

      if (signal) {
        abortHandler = () => {
          if (timer) clearTimeout(timer);
          timeoutReject(new Error("xAI OAuth login was cancelled"));
        };
        signal.addEventListener("abort", abortHandler, { once: true });
      }

      try {
        return await Promise.race([callbackPromise, timeout]);
      } finally {
        if (timer) clearTimeout(timer);
        if (abortHandler) signal?.removeEventListener("abort", abortHandler);
        close();
      }
    },
  };
}

function buildAuthorizeUrl(
  discovery: XaiDiscovery,
  redirectUri: string,
  challenge: string,
  state: string,
  nonce: string,
): string {
  // Match the official Grok CLI authorize URL exactly.
  const params = new URLSearchParams({
    response_type: "code",
    client_id: XAI_OAUTH_CLIENT_ID,
    redirect_uri: redirectUri,
    scope: XAI_OAUTH_SCOPE,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    nonce,
  });
  return `${discovery.authorization_endpoint}?${params.toString()}`;
}

export function parseCallbackInput(input: string): CallbackResult | undefined {
  const trimmed = input.trim();
  if (!trimmed) return undefined;

  // Case 1: full redirect URL
  if (trimmed.startsWith("http")) {
    try {
      const u = new URL(trimmed);
      return {
        code: u.searchParams.get("code") || undefined,
        state: u.searchParams.get("state") || undefined,
        error: u.searchParams.get("error") || undefined,
        error_description: u.searchParams.get("error_description") || undefined,
      };
    } catch {
      return undefined;
    }
  }

  // Case 2: just the query string
  if (trimmed.startsWith("?")) {
    try {
      const u = new URL(`http://127.0.0.1${trimmed}`);
      return {
        code: u.searchParams.get("code") || undefined,
        state: u.searchParams.get("state") || undefined,
        error: u.searchParams.get("error") || undefined,
        error_description: u.searchParams.get("error_description") || undefined,
      };
    } catch {
      return undefined;
    }
  }

  // Case 3: bare code
  if (/^[A-Za-z0-9_-]{20,}$/.test(trimmed)) {
    return { code: trimmed };
  }

  return undefined;
}

async function exchangeXaiToken(
  tokenEndpoint: string,
  body: Record<string, string>,
  signal?: AbortSignal,
): Promise<XaiTokenPayload> {
  const response = await fetch(tokenEndpoint, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(body).toString(),
    signal,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    const entitlement = response.status === 403 && isXaiEntitlementError(text);
    throw new XaiAuthError(
      entitlement
        ? `xAI subscription required.${text ? ` ${text.slice(0, 300)}` : ""}`
        : `xAI token exchange failed (HTTP ${response.status}).${text ? ` Response: ${text}` : ""}`,
      {
        reloginRequired: !entitlement,
        code: entitlement ? "xai_entitlement" : "xai_token_exchange_failed",
      },
    );
  }

  return (await response.json()) as XaiTokenPayload;
}

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

// =============================================================================
// PKCE / Web OAuth types
// =============================================================================

type XaiDiscovery = {
  authorization_endpoint: string;
  token_endpoint: string;
};

type XaiTokenPayload = {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
  token_type?: string;
};

type CallbackResult = {
  code?: string;
  state?: string;
  error?: string;
  error_description?: string;
  manualPaste?: boolean;
};

// Hermes #29344: xAI 403s share permission-denied text for entitlement vs stale token
export function isXaiStaleTokenError(text: string): boolean {
  const h = text.toLowerCase();
  return (
    h.includes("[wke=unauthenticated:") || h.includes("oauth2 access token could not be validated")
  );
}

export function isXaiEntitlementError(text: string): boolean {
  const h = text.toLowerCase();
  if (isXaiStaleTokenError(text)) return false;
  if (h.includes("do not have an active grok subscription")) return true;
  if (h.includes("out of available resources") && h.includes("grok")) return true;
  if (h.includes("does not have permission") && h.includes("grok")) return true;
  return false;
}

function attachStdinPasteCallback(onPaste: (result: CallbackResult) => void): () => void {
  if (!process.stdin.isTTY) return () => {};
  const rl = createInterface({ input: process.stdin, terminal: true });
  const onLine = (line: string) => {
    const parsed = parseCallbackInput(line);
    if (parsed?.code) {
      parsed.manualPaste = true;
      onPaste(parsed);
      rl.close();
    }
  };
  rl.on("line", onLine);
  return () => {
    rl.off("line", onLine);
    rl.close();
  };
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

export let PI_AUTH_PATH = resolve(homedir(), ".pi/agent/auth.json");

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
    const entitlement = res.status === 403 && isXaiEntitlementError(text);
    throw new XaiAuthError(
      entitlement
        ? `xAI subscription required.${text ? ` ${text.slice(0, 300)}` : ""}`
        : `xAI token refresh failed (${res.status}): ${text}`,
      {
        reloginRequired:
          !entitlement && (res.status === 400 || res.status === 401 || res.status === 403),
        code: entitlement ? "xai_entitlement" : "xai_refresh_failed",
      },
    );
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

    // Canonical key used by current Grok CLI
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

    // Legacy key still present in some older Grok CLI auth files
    const legacy = parsed[XAI_GROK_CLI_LEGACY_AUTH_SCOPE_KEY];
    const legacyAccess =
      legacy && typeof legacy === "object"
        ? (legacy as any).key || (legacy as any).access_token || (legacy as any).token
        : "";
    if (legacyAccess) {
      return {
        accessToken: String(legacyAccess),
        email: undefined,
        source: `grok-cli-legacy:${GROK_CLI_AUTH_PATH}`,
      };
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
    referrer: "grok-build",
  });

  // Match official device_code.rs: version + surface headers + referrer form field.
  const res = await fetch(XAI_OAUTH_DEVICE_CODE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "x-grok-client-version": GROK_CLI_VERSION,
      "x-grok-client-surface": "cli",
    },
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
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "x-grok-client-version": GROK_CLI_VERSION,
      "x-grok-client-surface": "cli",
    },
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
      `xAI Grok Build — Native Login (no grok binary required)\n\n` +
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
// PKCE Web login implementation (with release hygiene: guaranteed server close + signal propagation)
// =============================================================================

async function performXaiPkceLogin(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
  callbacks.onProgress?.("Starting native xAI login (Web PKCE + browser)...");

  const discovery = await xaiDiscovery(callbacks.signal);
  const callbackServer = await startCallbackServer();

  try {
    const { verifier, challenge } = pkcePair();
    const state = randomUUID().replace(/-/g, "");
    const nonce = randomUUID().replace(/-/g, "");
    const authorizeUrl = buildAuthorizeUrl(
      discovery,
      callbackServer.redirectUri,
      challenge,
      state,
      nonce,
    );

    callbacks.onAuth({
      url: authorizeUrl,
      instructions:
        "If the automatic open uses the wrong browser/profile, copy the URL and open it manually. " +
        "If xAI shows a Grok Build code on-page instead of redirecting, paste the bare code, " +
        "the full redirect URL, or ?code=... into the field below (or your terminal while waiting).",
    });

    callbacks.onProgress?.(`Waiting for xAI OAuth callback on ${callbackServer.redirectUri}...`);

    const detachStdin = attachStdinPasteCallback((r) => callbackServer.resolveCallback(r));

    const manualCodePromise = callbacks.onManualCodeInput?.();
    if (manualCodePromise) {
      manualCodePromise
        .then((input: string) => {
          if (input) {
            const manual = parseCallbackInput(input);
            if (manual) callbackServer.resolveCallback(manual);
          }
        })
        .catch(() => {
          // Cancellation handled by signal / login dialog.
        });
    }

    let callback: CallbackResult;
    try {
      callback = await callbackServer.waitForCallback(callbacks.signal);
    } finally {
      detachStdin();
    }
    if (callback.error) {
      throw new XaiAuthError(
        `xAI authorization failed: ${callback.error_description || callback.error}`,
        {
          reloginRequired: true,
          code: "xai_pkce_auth_error",
        },
      );
    }
    // Hermes #26923 / 1c055a4c5: bare-code paste has no state; PKCE verifier still binds exchange
    const callbackState = callback.state ?? state;
    if (callbackState !== state) {
      throw new XaiAuthError("xAI authorization failed: state mismatch", {
        reloginRequired: true,
        code: "xai_pkce_state_mismatch",
      });
    }
    if (!callback.code) {
      throw new XaiAuthError("xAI authorization failed: no authorization code returned", {
        reloginRequired: true,
        code: "xai_pkce_no_code",
      });
    }

    callbacks.onProgress?.("Exchanging xAI authorization code...");

    // Match Hermes canonical (post-#26990): echo code_challenge at token step for xAI,
    // guard empty verifier (never leak auth code to a server that cannot redeem it),
    // and surface HTTP status in errors. This fixes "code_challenge is required" 400s.
    if (!verifier) {
      throw new XaiAuthError(
        "xAI token exchange refused locally: PKCE code_verifier is empty. " +
          "This is a bug — please report at https://github.com/NousResearch/hermes-agent/issues/26990.",
        { reloginRequired: true, code: "xai_pkce_verifier_missing" },
      );
    }
    const tokenBody: Record<string, string> = {
      grant_type: "authorization_code",
      code: callback.code,
      redirect_uri: callbackServer.redirectUri,
      client_id: XAI_OAUTH_CLIENT_ID,
      code_verifier: verifier,
    };
    if (challenge) {
      tokenBody.code_challenge = challenge;
      tokenBody.code_challenge_method = "S256";
    }
    const data = await exchangeXaiToken(discovery.token_endpoint, tokenBody, callbacks.signal);

    if (!data.access_token) {
      throw new XaiAuthError("xAI token response did not include an access token", {
        reloginRequired: true,
        code: "xai_pkce_no_access",
      });
    }
    const refresh = data.refresh_token || "";
    if (!refresh) {
      throw new XaiAuthError(
        "xAI token response did not include a refresh token (expected for offline_access)",
        {
          reloginRequired: true,
          code: "xai_pkce_no_refresh",
        },
      );
    }

    const expires =
      Date.now() + (data.expires_in || 3600) * 1000 - XAI_ACCESS_TOKEN_REFRESH_SKEW_SECONDS * 1000;

    callbacks.onProgress?.("Native PKCE login successful!");
    return { access: data.access_token, refresh, expires, source: "native-pkce-web" };
  } finally {
    callbackServer.close();
  }
}

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
          `How do you want to authenticate for Grok Build?`,
        options: [
          {
            id: "import",
            label: "Import existing `grok login` (recommended)",
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
      // else fall through to native choice below
    } else {
      // No onSelect support — just import automatically (best effort)
      callbacks.onProgress?.(
        `Found existing Grok CLI login${existing.email ? ` (${existing.email})` : ""}. Importing...`,
      );
      return importFromGrokCli(existing);
    }
  }

  // Native path: offer Web PKCE (recommended) vs Device Code fallback
  const cb: any = callbacks;
  const hasSelect = typeof cb.onSelect === "function";

  if (hasSelect) {
    const choice = await cb.onSelect!({
      message: "Choose native xAI login method:",
      options: [
        {
          id: "web",
          label: "Web login with browser (PKCE + localhost callback, recommended)",
        },
        {
          id: "device",
          label: "Device code (for terminals without browser, headless, CI, remote)",
        },
      ],
    });

    if (choice === "web") {
      return performXaiPkceLogin(callbacks);
    }
    // device falls through
  } else {
    // Older clients without onSelect → default to the much better Web PKCE experience
    callbacks.onProgress?.("Starting Web PKCE login (recommended)...");
    return performXaiPkceLogin(callbacks);
  }

  // Device Code Flow (explicit fallback)
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
// Grok Build subscription usage (same billing surface as Grok CLI `/usage`)
// =============================================================================

/** Unofficial Grok Build CLI proxy — works with grok-cli / grok-build OAuth tokens. */
export const GROK_BUILD_BILLING_URL = "https://cli-chat-proxy.grok.com/v1/billing";
/** Grok web usage / account surface */
export const GROK_USAGE_PAGE_URL = "https://grok.com/?_s=usage";

export interface MonthlyUsage {
  monthlyLimit: number;
  used: number;
  billingPeriodEnd: string;
}

export interface WeeklyUsage {
  creditUsagePercent: number;
  billingPeriodEnd: string;
}

export interface BillingUsage {
  monthly: MonthlyUsage;
  weekly?: WeeklyUsage;
}

/** @deprecated use BillingUsage — kept for siblings that imported the old name */
export type GrokBuildBilling = BillingUsage;

const RESET_TIME_FORMATTER = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

const RESET_DATE_FORMATTER = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
});

const RESET_DATE_YEAR_FORMATTER = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
});

const LOCAL_DAY_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const USAGE_BAR_WIDTH = 20;
const USAGE_LABEL_WIDTH = 28;

function billingHeaders(token: string): Record<string, string> {
  // Official extensions/billing.rs proxy headers.
  return {
    authorization: `Bearer ${token}`,
    "x-xai-token-auth": "xai-grok-cli",
    "x-grok-client-version": GROK_CLI_VERSION,
    "x-grok-client-mode": "interactive",
    accept: "application/json",
  };
}

function moneyishVal(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (v && typeof v === "object" && typeof (v as { val?: unknown }).val === "number") {
    return (v as { val: number }).val;
  }
  return undefined;
}

function parseMonthlyUsage(payload: unknown): MonthlyUsage {
  if (!payload || typeof payload !== "object") throw new Error("invalid billing payload");
  const config = (payload as Record<string, unknown>).config;
  if (!config || typeof config !== "object") throw new Error("invalid billing payload");
  const c = config as Record<string, unknown>;
  const monthlyLimit = moneyishVal(c.monthlyLimit);
  const used = moneyishVal(c.used);
  const billingPeriodEnd = c.billingPeriodEnd;
  if (
    typeof monthlyLimit !== "number" ||
    typeof used !== "number" ||
    typeof billingPeriodEnd !== "string" ||
    !Number.isFinite(new Date(billingPeriodEnd).getTime())
  ) {
    throw new Error("invalid billing payload");
  }
  return { monthlyLimit, used, billingPeriodEnd };
}

function parseWeeklyUsage(payload: unknown): WeeklyUsage | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const config = (payload as Record<string, unknown>).config;
  if (!config || typeof config !== "object") return undefined;
  const c = config as Record<string, unknown>;
  const currentPeriod = c.currentPeriod as Record<string, unknown> | undefined;
  if (currentPeriod?.type !== "USAGE_PERIOD_TYPE_WEEKLY") return undefined;
  const creditUsagePercent = c.creditUsagePercent;
  // Prefer period end from currentPeriod when present (matches weekly window)
  const billingPeriodEnd =
    (typeof currentPeriod.end === "string" && currentPeriod.end) ||
    (typeof c.billingPeriodEnd === "string" ? c.billingPeriodEnd : undefined);
  if (
    typeof creditUsagePercent !== "number" ||
    !Number.isFinite(creditUsagePercent) ||
    typeof billingPeriodEnd !== "string" ||
    !Number.isFinite(new Date(billingPeriodEnd).getTime())
  ) {
    return undefined;
  }
  return { creditUsagePercent, billingPeriodEnd };
}

function clampPercent(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

/** Codex-style remaining bar: filled = % left. */
export function usageProgressBar(percentLeft: number, width = USAGE_BAR_WIDTH): string {
  const left = clampPercent(percentLeft);
  const filled = Math.round((left / 100) * width);
  return `[${"█".repeat(filled)}${"░".repeat(width - filled)}]`;
}

/** Compact reset clock: "13:57" same day, "00:10 on 21 May" otherwise (local time). */
function formatResetShort(iso: string, now = new Date()): string {
  const date = new Date(iso);
  const timeParts = RESET_TIME_FORMATTER.formatToParts(date);
  const part = (parts: Intl.DateTimeFormatPart[], type: string) =>
    parts.find((p) => p.type === type)?.value ?? "";
  const hour = part(timeParts, "hour") === "24" ? "00" : part(timeParts, "hour");
  const minute = part(timeParts, "minute");
  const time = `${hour}:${minute}`;

  if (LOCAL_DAY_FORMATTER.format(date) === LOCAL_DAY_FORMATTER.format(now)) {
    return time;
  }

  const sameYear = date.getFullYear() === now.getFullYear();
  const day = sameYear ? RESET_DATE_FORMATTER.format(date) : RESET_DATE_YEAR_FORMATTER.format(date);
  return `${time} on ${day}`;
}

/**
 * Compact remaining time without the "in " prefix: `45m`, `2h 15m`, `3d 4h`, or `now`.
 * Drops minutes once days are present to keep the line compact.
 */
export function formatDurationLeft(iso: string, now = new Date()): string {
  const ms = new Date(iso).getTime() - now.getTime();
  if (!Number.isFinite(ms)) return "?";
  if (ms <= 0) return "now";

  const totalMin = Math.floor(ms / 60_000);
  const days = Math.floor(totalMin / (60 * 24));
  const hours = Math.floor((totalMin % (60 * 24)) / 60);
  const mins = totalMin % 60;

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (days === 0 && (mins > 0 || parts.length === 0)) parts.push(`${mins}m`);
  return parts.join(" ");
}

/** Human countdown until reset: `in 45m`, `in 2h 15m`, `in 3d 4h`, or `now` if past. */
export function formatDurationUntil(iso: string, now = new Date()): string {
  const left = formatDurationLeft(iso, now);
  if (left === "now" || left === "?") return left;
  return `in ${left}`;
}

/** Tighter of monthly/weekly remaining — good for a single footer status. */
export function pickTighterUsageLimit(usage: BillingUsage): {
  percentLeft: number;
  resetIso: string;
  source: "monthly" | "weekly";
} {
  const { monthlyLimit, used, billingPeriodEnd } = usage.monthly;
  const monthlyUsedPct = monthlyLimit > 0 ? (used / monthlyLimit) * 100 : used > 0 ? 100 : 0;
  const monthlyLeft = clampPercent(100 - monthlyUsedPct);

  if (!usage.weekly) {
    return { percentLeft: monthlyLeft, resetIso: billingPeriodEnd, source: "monthly" };
  }

  const weeklyLeft = clampPercent(100 - usage.weekly.creditUsagePercent);
  if (weeklyLeft <= monthlyLeft) {
    return {
      percentLeft: weeklyLeft,
      resetIso: usage.weekly.billingPeriodEnd,
      source: "weekly",
    };
  }
  return { percentLeft: monthlyLeft, resetIso: billingPeriodEnd, source: "monthly" };
}

/** Footer status: `Grok 40% left · 3d 12h` (tighter of monthly/weekly). */
export function formatUsageStatusText(usage: BillingUsage, now = new Date()): string {
  const { percentLeft, resetIso } = pickTighterUsageLimit(usage);
  return `Grok ${percentLeft}% left · ${formatDurationLeft(resetIso, now)}`;
}

function formatResetWithCountdown(iso: string, now = new Date()): string {
  return `${formatResetShort(iso, now)} · ${formatDurationUntil(iso, now)}`;
}

function formatLimitLine(
  label: string,
  percentLeft: number,
  resetIso: string,
  extra?: string,
  now = new Date(),
): string {
  const left = clampPercent(percentLeft);
  const bar = usageProgressBar(left);
  const extraPart = extra ? ` · ${extra}` : "";
  return `  ${label.padEnd(USAGE_LABEL_WIDTH)}${bar} ${left}% left${extraPart} (resets ${formatResetWithCountdown(resetIso, now)})`;
}

/**
 * Fetch monthly + weekly Grok Build usage for a subscription OAuth token.
 * Monthly: GET …/v1/billing · Weekly: GET …/v1/billing?format=credits
 * (cli-chat-proxy; not public docs.x.ai — may change without notice.)
 */
export async function fetchBillingUsage(accessToken: string): Promise<BillingUsage> {
  const token = accessToken?.trim();
  if (!token) {
    throw new XaiAuthError("Missing xAI access token for billing lookup", {
      reloginRequired: true,
      code: "xai_billing_no_token",
    });
  }

  const headers = billingHeaders(token);
  const monthlyResponse = await fetch(GROK_BUILD_BILLING_URL, { headers });
  if (!monthlyResponse.ok) {
    const needLogin = monthlyResponse.status === 401 || monthlyResponse.status === 403;
    throw new XaiAuthError(
      needLogin
        ? `Grok Build billing requires a subscription OAuth token. Run \`/login grok-build\`. (${monthlyResponse.status})`
        : `billing endpoint returned ${monthlyResponse.status}`,
      {
        reloginRequired: needLogin,
        code: needLogin ? "xai_billing_auth" : "xai_billing_failed",
      },
    );
  }

  let monthlyPayload: unknown;
  try {
    monthlyPayload = await monthlyResponse.json();
  } catch (e) {
    throw new XaiAuthError(`Grok Build billing returned invalid JSON: ${e}`, {
      code: "xai_billing_invalid_json",
    });
  }

  let monthly: MonthlyUsage;
  try {
    monthly = parseMonthlyUsage(monthlyPayload);
  } catch {
    throw new XaiAuthError("invalid billing payload", { code: "xai_billing_invalid_payload" });
  }

  const weekly = await fetchWeeklyUsage(headers).catch(() => undefined);
  return { monthly, weekly };
}

async function fetchWeeklyUsage(headers: Record<string, string>): Promise<WeeklyUsage | undefined> {
  const response = await fetch(`${GROK_BUILD_BILLING_URL}?format=credits`, { headers });
  if (!response.ok) return undefined;
  try {
    return parseWeeklyUsage(await response.json());
  } catch {
    return undefined;
  }
}

/** @deprecated use fetchBillingUsage */
export async function fetchGrokBuildBilling(accessToken: string): Promise<BillingUsage> {
  return fetchBillingUsage(accessToken);
}

export const USAGE_STATUSBAR_TIP =
  "Tip: /xai-usage statusbar — show compact usage in the footer (Grok models)";

/**
 * Codex-style Grok Build usage lines + web link.
 *
 *   >_ Grok Build Usage
 *   Visit https://grok.com/?_s=usage for up-to-date
 *   information on rate limits and credits
 *     Monthly limit:  [████████████░░░░░░░░] 62% left · 93,560 cr (resets 13:57 · in 2h 15m)
 *     Weekly limit:   [█████████████░░░░░░░] 64% left (resets 14:37 · in 2h 55m)
 *
 *   Tip: /xai-usage statusbar — …   (when statusbar is off)
 */
export function formatQuota(
  usage: BillingUsage | undefined,
  options?: { now?: Date; showStatusbarTip?: boolean },
): string[] {
  const now = options?.now ?? new Date();
  const header = [
    ">_ Grok Build Usage",
    "",
    `Visit ${GROK_USAGE_PAGE_URL} for up-to-date`,
    "information on rate limits and credits",
    "",
  ];

  if (!usage) {
    const empty = [
      ...header,
      "  no billing data available — run /login grok-build (or import grok CLI login)",
    ];
    if (options?.showStatusbarTip) empty.push("", USAGE_STATUSBAR_TIP);
    return empty;
  }

  const { monthlyLimit, used, billingPeriodEnd } = usage.monthly;
  const remaining = Math.max(0, monthlyLimit - used);
  const monthlyUsedPct = monthlyLimit > 0 ? (used / monthlyLimit) * 100 : used > 0 ? 100 : 0;
  const monthlyLeftPct = 100 - monthlyUsedPct;
  const creditExtra = `${remaining.toLocaleString()} / ${monthlyLimit.toLocaleString()} cr`;

  const lines = [
    ...header,
    formatLimitLine("Monthly limit:", monthlyLeftPct, billingPeriodEnd, creditExtra, now),
  ];

  if (usage.weekly) {
    const weeklyLeftPct = 100 - usage.weekly.creditUsagePercent;
    lines.push(
      formatLimitLine(
        "Weekly limit:",
        weeklyLeftPct,
        usage.weekly.billingPeriodEnd,
        undefined,
        now,
      ),
    );
  }

  if (options?.showStatusbarTip) {
    lines.push("", USAGE_STATUSBAR_TIP);
  }

  return lines;
}

/** Single string for Pi notify (same content as formatQuota). */
export function formatGrokBuildBilling(
  usage: BillingUsage,
  options?: { now?: Date; showStatusbarTip?: boolean },
): string {
  return formatQuota(usage, options).join("\n");
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
  // Grok Build OAuth preferred
  // We prefer a proper `grok-build` OAuth entry (from `/login grok-build`)
  // or an auto-detected token from the official grok CLI.
  // Plain XAI_API_KEY is only used as a last resort (often only valid for voice).
  // ------------------------------------------------------------------

  // 1. Explicit "grok-build" entry in Pi auth (OAuth from SuperGrok / X subscription)
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
  } catch {
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
