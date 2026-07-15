/**
 * OAuth + billing: official client id/scopes, credential priority, usage format.
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
  formatQuota,
  formatUsageStatusText,
  usageProgressBar,
  fetchBillingUsage,
  GROK_USAGE_PAGE_URL,
  __setTestGrokCliAuthPath,
  __setTestPiAuthPath,
  __resetTestPathsToDefaults,
  XAI_OAUTH_CLIENT_ID,
  XAI_ACCESS_TOKEN_REFRESH_SKEW_SECONDS,
  XAI_OAUTH_TOKEN_URL,
  XAI_OAUTH_DEVICE_CODE_URL,
  XAI_OAUTH_SCOPE,
  parseCallbackInput,
  isXaiStaleTokenError,
  isXaiEntitlementError,
} from "../xai-oauth.ts";
import { isGrokModel } from "../xai-usage-status.ts";

const ORIGINAL_ENV_KEY = process.env.XAI_API_KEY;

let TEST_TMP_DIR: string;
let TEST_GROK_PATH: string;
let TEST_PI_PATH: string;

function makeFakeJwt(expSeconds: number): string {
  const b64 = (o: object) =>
    btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${b64({ alg: "none", typ: "JWT" })}.${b64({ exp: expSeconds, sub: "test" })}.sig`;
}

function setupPaths() {
  TEST_TMP_DIR = path.join(
    os.tmpdir(),
    `pi-xai-oauth-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

function cleanup() {
  try {
    fs.rmSync(TEST_TMP_DIR, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  __resetTestPathsToDefaults();
}

describe("xai-oauth", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    process.env.XAI_API_KEY = "";
    setupPaths();
    fetchMock = vi.fn();
    // @ts-expect-error test mock
    globalThis.fetch = fetchMock;
  });

  afterEach(() => {
    if (ORIGINAL_ENV_KEY !== undefined) process.env.XAI_API_KEY = ORIGINAL_ENV_KEY;
    else delete process.env.XAI_API_KEY;
    cleanup();
    vi.restoreAllMocks();
  });

  test("official OAuth constants (xai-org/grok-build auth/config.rs)", () => {
    expect(XAI_OAUTH_CLIENT_ID).toBe("b1a00492-073a-47ea-816f-4c329264a828");
    expect(XAI_OAUTH_TOKEN_URL).toBe("https://auth.x.ai/oauth2/token");
    expect(XAI_OAUTH_DEVICE_CODE_URL).toBe("https://auth.x.ai/oauth2/device/code");
    expect(XAI_ACCESS_TOKEN_REFRESH_SKEW_SECONDS).toBe(3600);
    expect(XAI_OAUTH_SCOPE).toBe(
      "openid profile email offline_access grok-cli:access api:access conversations:read conversations:write",
    );
  });

  test("readGrokCliAuth + getEffective priority", async () => {
    const auth = {
      [`https://auth.x.ai::${XAI_OAUTH_CLIENT_ID}`]: {
        key: "grok-cli-token",
      },
    };
    fs.writeFileSync(TEST_GROK_PATH, JSON.stringify(auth), "utf8");
    expect(readGrokCliAuth()?.accessToken).toBe("grok-cli-token");

    fs.writeFileSync(
      TEST_PI_PATH,
      JSON.stringify({ "grok-build": { type: "oauth", access: "pi-oauth-token" } }),
      "utf8",
    );
    expect((await getEffectiveXaiApiKey())?.apiKey).toBe("pi-oauth-token");

    process.env.XAI_API_KEY = "env-key";
    fs.writeFileSync(TEST_PI_PATH, "{}", "utf8");
    fs.writeFileSync(TEST_GROK_PATH, "{}", "utf8");
    expect((await getEffectiveXaiApiKey())?.apiKey).toBe("env-key");
  });

  test("JWT exp + auth error codes", () => {
    const now = Math.floor(Date.now() / 1000);
    expect(isXaiAccessTokenExpiring(makeFakeJwt(now + 7200))).toBe(false);
    expect(isXaiAccessTokenExpiring(makeFakeJwt(now + 60))).toBe(true);
    expect(isXaiAccessTokenExpiring("not-a-jwt")).toBe(false);

    const err = new XaiAuthError("fail", { reloginRequired: true, code: "xai_test" });
    expect(err.reloginRequired).toBe(true);
    expect(err.code).toBe("xai_test");

    expect(isXaiStaleTokenError("[WKE=unauthenticated:bad-credentials]")).toBe(true);
    expect(isXaiEntitlementError("You do not have an active Grok subscription")).toBe(true);
  });

  test("refresh without refresh_token fails clearly", async () => {
    await expect(
      refreshXaiToken({ access: "a", refresh: "", expires: Date.now() + 1000 } as any),
    ).rejects.toThrow(/refresh/i);
  });

  test("parseCallbackInput + autoImport empty", async () => {
    expect(parseCallbackInput("abcdefghijklmnopqrst")).toEqual({ code: "abcdefghijklmnopqrst" });
    expect(await autoImportGrokCliIfNeeded()).toBe(false);
  });

  test("usage format (bars + status line)", () => {
    expect(usageProgressBar(100)).toBe(`[${"█".repeat(20)}]`);
    expect(usageProgressBar(0)).toBe(`[${"░".repeat(20)}]`);

    const now = new Date("2026-07-11T12:00:00+00:00");
    const usage = {
      monthly: {
        used: 60_000,
        monthlyLimit: 100_000,
        billingPeriodEnd: "2026-07-11T14:15:00+00:00",
      },
      weekly: {
        creditUsagePercent: 17,
        billingPeriodEnd: "2026-07-14T16:00:00+00:00",
      },
    };
    expect(formatUsageStatusText(usage, now)).toBe("Grok 40% left · 2h 15m");

    const text = formatQuota(usage, { now }).join("\n");
    expect(text).toContain(">_ Grok Build Usage");
    expect(text).toContain(GROK_USAGE_PAGE_URL);
    expect(text).toContain("40% left"); // monthly used 60%
    expect(text).toContain("83% left"); // weekly used 17%
  });

  test("fetchBillingUsage monthly then weekly", async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          config: {
            monthlyLimit: { val: 100 },
            used: { val: 10 },
            billingPeriodEnd: "2026-08-01T00:00:00Z",
          },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          config: {
            currentPeriod: {
              type: "USAGE_PERIOD_TYPE_WEEKLY",
              end: "2026-07-18T00:00:00Z",
            },
            creditUsagePercent: 25,
          },
        }),
      });

    const u = await fetchBillingUsage("tok");
    expect(u.monthly.used).toBe(10);
    expect(u.weekly?.creditUsagePercent).toBe(25);
    expect(fetchMock).toHaveBeenCalled();
  });

  test("isGrokModel", () => {
    expect(isGrokModel({ id: "grok-4.5", provider: "grok-build" } as any)).toBe(true);
    expect(isGrokModel({ id: "claude", provider: "anthropic" } as any)).toBe(false);
  });
});
