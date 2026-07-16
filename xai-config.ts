import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

/** Public xAI API (API key / encrypted reasoning; override when needed). */
export const XAI_API_BASE = "https://api.x.ai/v1";

/** Default: Grok CLI subscription proxy (catalog + OAuth; encrypted reasoning with CLI headers). */
export const XAI_CLI_BASE = "https://cli-chat-proxy.grok.com/v1";

export const USER_PI_SETTINGS_PATH = resolve(homedir(), ".pi/agent/settings.json");
export const PROJECT_PI_SETTINGS_PATH = resolve(process.cwd(), ".pi/settings.json");
export const USER_PI_KEYBINDINGS_PATH = resolve(homedir(), ".pi/agent/keybindings.json");

/** Remap in ~/.pi/agent/keybindings.json (Pi core ignores ext.* ids; we read them ourselves). */
export const PROMPT_SUGGEST_ACCEPT_ID = "ext.pi-xai.promptSuggest.accept";

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

/** First key bound to `id` in keybindings.json, else `fallback`. Pi does not remap ext.* yet. */
export function resolveKeybindingKey(
  id: string,
  fallback: string,
  path = USER_PI_KEYBINDINGS_PATH,
): string {
  const raw = readJsonRecord(path);
  const v = raw[id];
  if (typeof v === "string" && v.trim()) return v.trim().toLowerCase();
  if (Array.isArray(v)) {
    for (const item of v) {
      if (typeof item === "string" && item.trim()) return item.trim().toLowerCase();
    }
  }
  return fallback;
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
      // Default CLI proxy (subscription catalog). Override with XAI_API_BASE for public API keys.
      baseUrl: getString(mergedXai, "baseUrl") || XAI_CLI_BASE,
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

/** Server-side Responses builtins merged into grok-* chat (default on). */
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
  if (
    Array.isArray(toolsSetting) &&
    toolsSetting.every((t): t is string => typeof t === "string")
  ) {
    return { enabled: true, tools: [...toolsSetting] };
  }

  return { enabled: true, tools: ["web_search", "x_search", "code_interpreter"] };
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

/** Imagine tools in pi-xai. On by default; `xai.text.imageGen: false` disables. */
export function isImageGenEnabled(config: ResolvedXaiConfig = resolveXaiConfig()): boolean {
  const v = config.xai.text?.imageGen;
  return v !== false && v !== "false";
}

/** Video tools. On by default unless opt-out or pi-xai-imagine is co-installed. */
export function isVideoGenEnabled(config: ResolvedXaiConfig = resolveXaiConfig()): boolean {
  const v = config.xai.text?.videoGen;
  if (v === false || v === "false") return false;
  if (isSiblingPackageListed("pi-xai-imagine")) return false;
  return true;
}

/** True if settings packages list includes a path/name matching `name` (e.g. pi-xai-imagine). */
export function isSiblingPackageListed(name: string): boolean {
  try {
    for (const file of [USER_PI_SETTINGS_PATH, PROJECT_PI_SETTINGS_PATH]) {
      if (!existsSync(file)) continue;
      const raw = JSON.parse(readFileSync(file, "utf8")) as { packages?: unknown };
      const pkgs = Array.isArray(raw.packages) ? raw.packages : [];
      for (const entry of pkgs) {
        if (typeof entry !== "string") continue;
        const n = entry.replace(/\\/g, "/");
        const base = n.split("/").pop() || n;
        if (base === name || base.startsWith(`${name}@`) || n.endsWith(`/${name}`)) return true;
        if (n === `npm:${name}` || n.startsWith(`npm:${name}@`)) return true;
      }
    }
  } catch {
    /* ignore */
  }
  return false;
}

/** Footer quota status. Off by default; `xai.text.usageStatus: true` or `/xai-usage statusbar`. */
export function isUsageStatusEnabled(config: ResolvedXaiConfig = resolveXaiConfig()): boolean {
  const v = config.xai.text?.usageStatus;
  return v === true || v === "true";
}

/** Persist `xai.text.usageStatus` in the user Pi settings file. */
export function setUsageStatusEnabled(
  enabled: boolean,
  settingsPath = USER_PI_SETTINGS_PATH,
): void {
  const root = readJsonRecord(settingsPath);
  const xai = isRecord(root.xai) ? { ...root.xai } : {};
  const text = isRecord(xai.text) ? { ...xai.text } : {};
  text.usageStatus = enabled;
  xai.text = text;
  root.xai = xai;
  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, `${JSON.stringify(root, null, 2)}\n`, "utf8");
}
