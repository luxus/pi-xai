import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

/** Default: public xAI API (encrypted reasoning, full Responses surface). */
export const XAI_API_BASE = "https://api.x.ai/v1";

/** Optional: Grok CLI subscription proxy (Composer/Build catalog; strips encrypted reasoning). */
export const XAI_CLI_BASE = "https://cli-chat-proxy.grok.com/v1";

export const USER_PI_SETTINGS_PATH = resolve(homedir(), ".pi/agent/settings.json");
export const PROJECT_PI_SETTINGS_PATH = resolve(process.cwd(), ".pi/settings.json");

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readJsonRecord(filePath: string): JsonRecord {
  if (!existsSync(filePath)) return {};
  const raw = readFileSync(filePath, "utf8").trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function getNamespace(root: JsonRecord, key: string): JsonRecord {
  const value = root[key];
  return isRecord(value) ? value : {};
}

function getString(record: JsonRecord, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function getPiSettingsPaths(): { user: string; project: string } {
  return { user: USER_PI_SETTINGS_PATH, project: PROJECT_PI_SETTINGS_PATH };
}

export interface ResolvedXaiConfig {
  xai: {
    baseUrl: string;
    text: JsonRecord;
  };
}

export function resolveXaiConfig(): ResolvedXaiConfig {
  const user = readJsonRecord(USER_PI_SETTINGS_PATH);
  const project = readJsonRecord(PROJECT_PI_SETTINGS_PATH);
  const userXai = getNamespace(user, "xai");
  const projectXai = getNamespace(project, "xai");
  const mergedXai: JsonRecord = { ...userXai, ...projectXai };
  const textUser = getNamespace(userXai, "text");
  const textProject = getNamespace(projectXai, "text");

  return {
    xai: {
      // Default public API: multi-turn encrypted reasoning works.
      // Override with XAI_CLI_BASE for Grok CLI catalog / version-gate traffic.
      baseUrl: getString(mergedXai, "baseUrl") || XAI_API_BASE,
      text: { ...textUser, ...textProject },
    },
  };
}

const GROK_EFFORT_PREFIXES = [
  "grok-3-mini",
  "grok-4.20-multi-agent",
  "grok-4.5",
  "grok-4.3",
] as const;

export function grokModelId(model: string): string {
  let name = (model || "").trim().toLowerCase();
  if (name.includes("/")) name = name.split("/").pop()!;
  return name;
}

export function grokSupportsReasoningEffort(model: string): boolean {
  const name = grokModelId(model);
  return name ? GROK_EFFORT_PREFIXES.some((p) => name.startsWith(p)) : false;
}

export function grokWantsEncryptedReasoningInclude(model: string): boolean {
  const name = grokModelId(model);
  if (!name || name.startsWith("grok-build")) return false;
  return grokSupportsReasoningEffort(name) || name.includes("reasoning");
}

/**
 * How web search is provided while using grok-build / agentic xAI tools.
 *
 * - `native` (default): xAI server-side `web_search` only. Leave pi-web-access alone
 *   so other models can still use its client `web_search` if installed.
 * - `web-access`: replace native agentic `web_search` with Cursor `WebSearch`
 *   (requires `pi install npm:pi-web-access`).
 * - `both`: keep native agentic `web_search` and also activate `WebSearch`.
 *
 * Set via `xai.text.webSearch` in `~/.pi/agent/settings.json` or project settings.
 */
export type XaiWebSearchMode = "native" | "web-access" | "both";

export function getWebSearchMode(config: ResolvedXaiConfig = resolveXaiConfig()): XaiWebSearchMode {
  const raw = config.xai.text?.webSearch;
  if (typeof raw !== "string") return "native";
  const v = raw.trim().toLowerCase();
  if (v === "web-access" || v === "web_access" || v === "client" || v === "pi-web-access") {
    return "web-access";
  }
  if (v === "both") return "both";
  return "native";
}

/** Activate Cursor WebSearch (pi-web-access) for grok-build. */
export function wantsClientWebSearch(mode: XaiWebSearchMode = getWebSearchMode()): boolean {
  return mode === "web-access" || mode === "both";
}

/** Inject xAI server-side web_search in agentic mode. */
export function wantsNativeWebSearch(mode: XaiWebSearchMode = getWebSearchMode()): boolean {
  return mode === "native" || mode === "both";
}

export function getAgenticConfig(config: ResolvedXaiConfig): {
  enabled: boolean;
  tools: string[];
} {
  const text = config.xai.text;
  const agentic = text?.agentic;

  if (agentic === false || agentic === "false") {
    return { enabled: false, tools: [] };
  }

  const toolsSetting = text?.agenticTools;
  let tools: string[];
  if (
    Array.isArray(toolsSetting) &&
    toolsSetting.every((t): t is string => typeof t === "string")
  ) {
    tools = [...toolsSetting];
  } else {
    tools = ["web_search", "x_search", "code_interpreter"];
  }

  // Optional replace: drop native server-side web_search when user chose web-access only.
  if (!wantsNativeWebSearch(getWebSearchMode(config))) {
    tools = tools.filter((t) => t !== "web_search");
  }

  return { enabled: true, tools };
}

/**
 * On by default. Registers `xai_multi_agent` (currently grok-4.20 multi-agent; may track
 * newer multi-agent models later). Disable with xai.text.multiAgent: false.
 */
export function isMultiAgentToolEnabled(config: ResolvedXaiConfig = resolveXaiConfig()): boolean {
  const v = config.xai.text?.multiAgent;
  if (v === false || v === "false") return false;
  return true;
}
