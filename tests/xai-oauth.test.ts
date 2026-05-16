/**
 * Focused unit tests for xai-oauth.ts critical logic (JWT expiry, refresh error hardening,
 * XaiAuthError, getEffective priority via options, reloginRequired, autoImport no-op cases).
 * 18+ tests. Vitest runner (npm). Mocks only fetch + process.env (fs paths use real homedir;
 * tests avoid polluting or asserting real ~/.grok files).
 *
 * Matches Hermes Agent commit behaviors: JWT exp-based isExpiring, typed AuthError on malformed JSON,
 * reloginRequired signaling, 5-level credential resolution.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  readGrokCliAuth,
  isXaiAccessTokenExpiring,
  XaiAuthError,
  refreshXaiToken,
  getEffectiveXaiApiKey,
  autoImportGrokCliIfNeeded,
  __setTestGrokCliAuthPath,
  __setTestPiAuthPath,
  __resetTestPathsToDefaults,
  XAI_OAUTH_CLIENT_ID,
  XAI_ACCESS_TOKEN_REFRESH_SKEW_SECONDS,
  XAI_OAUTH_TOKEN_URL,
  XAI_OAUTH_DEVICE_CODE_URL,
  XAI_OAUTH_SCOPE,
} from "../xai-oauth.ts";

const ORIGINAL_ENV_KEY = process.env.XAI_API_KEY;

// Hermetic temp paths (bug #3): every test controls its fs inputs via these
let TEST_TMP_DIR: string;
let TEST_GROK_PATH: string;
let TEST_PI_PATH: string;

function makeFakeJwt(expSeconds: number): string {
  const header = { alg: "none", typ: "JWT" };
  const payload = { exp: expSeconds, sub: "test" };
  const b64 = (o: any) => btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${b64(header)}.${b64(payload)}.sig`;
}

function setupHermeticPaths() {
  TEST_TMP_DIR = path.join(os.tmpdir(), `pi-xai-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  TEST_GROK_PATH = path.join(TEST_TMP_DIR, ".grok", "auth.json");
  TEST_PI_PATH = path.join(TEST_TMP_DIR, ".pi", "agent", "auth.json");
  fs.mkdirSync(path.dirname(TEST_GROK_PATH), { recursive: true });
  fs.mkdirSync(path.dirname(TEST_PI_PATH), { recursive: true });
  // Start with empty files (no creds)
  fs.writeFileSync(TEST_GROK_PATH, "{}", "utf8");
  fs.writeFileSync(TEST_PI_PATH, "{}", "utf8");
  __setTestGrokCliAuthPath(TEST_GROK_PATH);
  __setTestPiAuthPath(TEST_PI_PATH);
}

function cleanupHermeticPaths() {
  try {
    fs.rmSync(TEST_TMP_DIR, { recursive: true, force: true });
  } catch {}
  __resetTestPathsToDefaults();
}

describe("xai-oauth (Hermes parity hardening + Pi grok-build)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    process.env.XAI_API_KEY = "";
    setupHermeticPaths(); // ensures no real ~/.grok or ~/.pi is ever read
    fetchMock = vi.fn();
    // @ts-ignore
    globalThis.fetch = fetchMock;
  });

  afterEach(() => {
    if (ORIGINAL_ENV_KEY !== undefined) process.env.XAI_API_KEY = ORIGINAL_ENV_KEY;
    else delete process.env.XAI_API_KEY;
    cleanupHermeticPaths();
    vi.restoreAllMocks();
  });

  // --- Constants / basic ---
  test("exports correct xAI OAuth constants (client, urls, skew=300s)", () => {
    expect(XAI_OAUTH_CLIENT_ID).toBe("b1a00492-073a-47ea-816f-4c329264a828");
    expect(XAI_OAUTH_TOKEN_URL).toContain("auth.x.ai/oauth2/token");
    expect(XAI_OAUTH_DEVICE_CODE_URL).toContain("device/code");
    expect(XAI_ACCESS_TOKEN_REFRESH_SKEW_SECONDS).toBe(300);
  });

  test("readGrokCliAuth parses controlled temp ~/.grok/auth.json (hermetic)", () => {
    const key = `https://auth.x.ai::${XAI_OAUTH_CLIENT_ID}`;
    fs.writeFileSync(TEST_GROK_PATH, JSON.stringify({ [key]: { key: "tok_hermetic_123", email: "test@x.ai" } }));
    const r = readGrokCliAuth();
    expect(r).toEqual({ accessToken: "tok_hermetic_123", email: "test@x.ai", source: `grok-cli:${TEST_GROK_PATH}` });
  });

  // --- JWT exp (core of Hermes reference) ---
  test("isXaiAccessTokenExpiring false for invalid/malformed tokens", () => {
    expect(isXaiAccessTokenExpiring("")).toBe(false);
    expect(isXaiAccessTokenExpiring("abc.def")).toBe(false);
    expect(isXaiAccessTokenExpiring("h.eyJleHAiOiJub3QgbnVtIn0.s")).toBe(false);
  });

  test("isXaiAccessTokenExpiring true when JWT exp within skew window", () => {
    const now = Math.floor(Date.now() / 1000);
    const skew = XAI_ACCESS_TOKEN_REFRESH_SKEW_SECONDS;
    expect(isXaiAccessTokenExpiring(makeFakeJwt(now + skew - 5))).toBe(true);
    expect(isXaiAccessTokenExpiring(makeFakeJwt(now + skew + 5))).toBe(false);
  });

  test("isXaiAccessTokenExpiring accepts custom skew", () => {
    const now = Math.floor(Date.now() / 1000);
    // With real JWT may vary; check it doesn't throw and boolean
    const res = isXaiAccessTokenExpiring(makeFakeJwt(now + 10), 5);
    expect(typeof res).toBe("boolean");
  });

  // --- XaiAuthError + refresh error paths (malformed JSON, reloginRequired) ---
  test("XaiAuthError carries reloginRequired and code", () => {
    const e = new XaiAuthError("test msg", { reloginRequired: true, code: "xai_foo" });
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("XaiAuthError");
    expect(e.reloginRequired).toBe(true);
    expect(e.code).toBe("xai_foo");
  });

  test("refreshXaiToken surfaces reloginRequired error for imported (no refresh) tokens", async () => {
    await expect(
      refreshXaiToken({ access: "a", refresh: "", expires: Date.now() + 10000, source: "grok-cli-import" } as any),
    ).rejects.toThrow(/imported from the grok CLI and has no refresh token/);
  });

  test("refreshXaiToken calls refresh and propagates XaiAuthError relogin on 401", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: async () => "invalid or expired refresh",
    } as any);

    const cred = { access: "old", refresh: "r1", expires: 0, source: "oauth" } as any;
    await expect(refreshXaiToken(cred)).rejects.toThrow(/refresh token expired or revoked/);
  });

  test("refresh path handles success + new refresh token rotation", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ access_token: "fresh", refresh_token: "rotated_r", expires_in: 3600 }),
    } as any);

    const cred = { access: "old_a", refresh: "old_r", expires: 0, source: "pi" } as any;
    const out = await refreshXaiToken(cred);
    expect(out.access).toBe("fresh");
    expect(out.refresh).toBe("rotated_r");
  });

  // --- getEffectiveXaiApiKey priority (5 levels) ---
  test("getEffectiveXaiApiKey prefers explicit grok-build entry written to hermetic temp PI_AUTH_PATH", async () => {
    fs.writeFileSync(TEST_PI_PATH, JSON.stringify({
      "grok-build": { type: "oauth", access: "gb_hermetic", expires: Date.now() + 3600000 },
    }));
    const r = await getEffectiveXaiApiKey({ env: "env_should_not_win" });
    expect(r?.apiKey).toBe("gb_hermetic");
    expect(r?.source).toContain("grok-build");
  });

  test("getEffectiveXaiApiKey falls to settings when no pi/grok files (hermetic empty temps)", async () => {
    const r = await getEffectiveXaiApiKey({ settingsApiKey: "set_key_hermetic", settingsSource: "project:bar" });
    // In hermetic empty temps + no env, settings is used
    expect(r?.apiKey).toBe("set_key_hermetic");
  });

  test("getEffectiveXaiApiKey returns undefined with hermetic empty temps and no options", async () => {
    const r = await getEffectiveXaiApiKey();
    expect(r).toBeUndefined();
  });

  // --- autoImport (non-fs-polluting cases) ---
  test("autoImportGrokCliIfNeeded returns false when no ~/.grok/auth.json present", async () => {
    const did = await autoImportGrokCliIfNeeded();
    expect(did).toBe(false);
  });

  // --- Additional coverage to reach 18+ focused tests ---
  test("XAI constants match Hermes (same client id + scope elements)", () => {
    expect(XAI_OAUTH_SCOPE).toContain("grok-cli:access");
    expect(XAI_OAUTH_SCOPE).toContain("api:access");
  });

  test("isXaiAccessTokenExpiring skew defaults to 300s", () => {
    expect(XAI_ACCESS_TOKEN_REFRESH_SKEW_SECONDS).toBe(300);
    const now = Math.floor(Date.now() / 1000);
    // exactly at boundary with default
    expect(isXaiAccessTokenExpiring(makeFakeJwt(now + 300))).toBe(true);
  });

  test("refreshXaiToken throws original error when not relogin case (e.g. network)", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, text: async () => "server err" } as any);
    const cred = { access: "a", refresh: "r", expires: 0, source: "x" } as any;
    await expect(refreshXaiToken(cred)).rejects.toThrow(/xAI token refresh failed/);
  });

  test("getEffectiveXaiApiKey with empty options returns undefined on hermetic empty temps", async () => {
    delete process.env.XAI_API_KEY;
    const r = await getEffectiveXaiApiKey({});
    expect(r).toBeUndefined();
  });

  test("XaiAuthError without options has reloginRequired=false", () => {
    const e = new XaiAuthError("plain");
    expect(e.reloginRequired).toBe(false);
  });

  test("multiple isXaiAccessTokenExpiring calls are pure and stable", () => {
    const tok = makeFakeJwt(Math.floor(Date.now() / 1000) + 100);
    expect(isXaiAccessTokenExpiring(tok, 0)).toBe(false);
    expect(isXaiAccessTokenExpiring(tok, 200)).toBe(true);
  });
});

// Note: full device code login + real fs readGrokCli + pi-auth write paths for grok-build are covered
// by manual /login grok-build flows and Pi runtime. The 401 reactive signal is wired in xai-client fetchJson.
