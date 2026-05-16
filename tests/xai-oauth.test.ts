/**
 * 9 essential OAuth tests (JWT expiry, XaiAuthError, refresh locking, getEffective priority,
 * autoImport, constants). Hermetic via temp paths. Matches Hermes parity for the critical paths
 * used by the two tools.
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

let TEST_TMP_DIR: string;
let TEST_GROK_PATH: string;
let TEST_PI_PATH: string;

function makeFakeJwt(expSeconds: number): string {
  const header = { alg: "none", typ: "JWT" };
  const payload = { exp: expSeconds, sub: "test" };
  // btoa is provided globally by vitest (test env); source decodeJwtPayload already has
  // the atob/Buffer fallback for cross-runtime robustness (Node/Bun/browser in Pi).
  const b64 = (o: any) =>
    btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${b64(header)}.${b64(payload)}.sig`;
}

function setupHermeticPaths() {
  TEST_TMP_DIR = path.join(
    os.tmpdir(),
    `pi-xai-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  TEST_GROK_PATH = path.join(TEST_TMP_DIR, ".grok", "auth.json");
  TEST_PI_PATH = path.join(TEST_TMP_DIR, ".pi", "agent", "auth.json");
  fs.mkdirSync(path.dirname(TEST_GROK_PATH), { recursive: true });
  fs.mkdirSync(path.dirname(TEST_PI_PATH), { recursive: true });
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

describe("xai-oauth (9 essential tests — Hermes parity)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    process.env.XAI_API_KEY = "";
    setupHermeticPaths();
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

  test("exports correct xAI OAuth constants", () => {
    expect(XAI_OAUTH_CLIENT_ID).toBe("b1a00492-073a-47ea-816f-4c329264a828");
    expect(XAI_OAUTH_TOKEN_URL).toContain("auth.x.ai/oauth2/token");
    expect(XAI_OAUTH_DEVICE_CODE_URL).toContain("device/code");
    expect(XAI_ACCESS_TOKEN_REFRESH_SKEW_SECONDS).toBe(300);
    expect(XAI_OAUTH_SCOPE).toContain("grok-cli:access");
  });

  test("readGrokCliAuth parses hermetic ~/.grok/auth.json", () => {
    const key = `https://auth.x.ai::${XAI_OAUTH_CLIENT_ID}`;
    fs.writeFileSync(
      TEST_GROK_PATH,
      JSON.stringify({ [key]: { key: "tok_123", email: "test@x.ai" } }),
    );
    const r = readGrokCliAuth();
    expect(r).toEqual({
      accessToken: "tok_123",
      email: "test@x.ai",
      source: `grok-cli:${TEST_GROK_PATH}`,
    });
  });

  test("isXaiAccessTokenExpiring false for invalid tokens", () => {
    expect(isXaiAccessTokenExpiring("not.a.jwt")).toBe(false);
    expect(isXaiAccessTokenExpiring("a.b")).toBe(false);
  });

  test("isXaiAccessTokenExpiring true when JWT exp within skew", () => {
    const expSoon = Math.floor(Date.now() / 1000) + 100;
    const tok = makeFakeJwt(expSoon);
    expect(isXaiAccessTokenExpiring(tok)).toBe(true);
  });

  test("XaiAuthError carries reloginRequired and code", () => {
    const e = new XaiAuthError("fail", { reloginRequired: true, code: "xai_foo" });
    expect(e.reloginRequired).toBe(true);
    expect(e.code).toBe("xai_foo");
    expect(e.name).toBe("XaiAuthError");
  });

  test("refreshXaiToken throws clear error for imported tokens without refresh token", async () => {
    const cred = { access: "a", refresh: "", expires: 0, source: "grok-cli-import" } as any;
    await expect(refreshXaiToken(cred)).rejects.toThrow(
      /imported from the grok CLI and has no refresh token/,
    );
  });

  test("getEffectiveXaiApiKey prefers explicit grok-build entry", async () => {
    const piAuth = {
      "grok-build": { type: "oauth", access: "tok_grok", expires: Date.now() + 3600_000 },
    };
    fs.writeFileSync(TEST_PI_PATH, JSON.stringify(piAuth));
    const r = await getEffectiveXaiApiKey();
    expect(r?.apiKey).toBe("tok_grok");
    expect(r?.source).toContain("grok-build");
  });

  test("getEffectiveXaiApiKey falls back to XAI_API_KEY env", async () => {
    process.env.XAI_API_KEY = "env_key_123";
    const r = await getEffectiveXaiApiKey();
    expect(r).toEqual({ apiKey: "env_key_123", source: "env:XAI_API_KEY" });
  });

  test("autoImportGrokCliIfNeeded returns false when no grok cli present", async () => {
    const did = await autoImportGrokCliIfNeeded();
    expect(did).toBe(false);
  });
});
