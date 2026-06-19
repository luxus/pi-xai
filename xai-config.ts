import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

export const XAI_API_BASE = "https://api.x.ai/v1";
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
      baseUrl: getString(mergedXai, "baseUrl") || XAI_API_BASE,
      text: { ...textUser, ...textProject },
    },
  };
}

const GROK_EFFORT_PREFIXES = ["grok-3-mini", "grok-4.20-multi-agent", "grok-4.3"] as const;

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

export function getAgenticConfig(config: ResolvedXaiConfig): {
  enabled: boolean;
  tools: string[];
} {
  const text = config.xai.text;
  const agentic = text?.agentic;

  if (agentic === false || agentic === "false") {
    return { enabled: false, tools: [] };
  }

  const tools = text?.agenticTools;
  if (Array.isArray(tools) && tools.every((t): t is string => typeof t === "string")) {
    return { enabled: true, tools };
  }

  return { enabled: true, tools: ["web_search", "x_search", "code_interpreter"] };
}
