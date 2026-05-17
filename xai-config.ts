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

function mergeRecords(base: JsonRecord, override: JsonRecord): JsonRecord {
  const merged: JsonRecord = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const current = merged[key];
    if (isRecord(current) && isRecord(value)) {
      merged[key] = mergeRecords(current, value);
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

function readJsonRecord(filePath: string): JsonRecord | undefined {
  if (!existsSync(filePath)) return undefined;
  const raw = readFileSync(filePath, "utf8").trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function getNamespace(root: JsonRecord | undefined, key: string): JsonRecord {
  if (!root) return {};
  const value = root[key];
  return isRecord(value) ? value : {};
}

function getString(record: JsonRecord, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function getPiSettingsPaths(): { user: string; project: string } {
  return {
    user: USER_PI_SETTINGS_PATH,
    project: PROJECT_PI_SETTINGS_PATH,
  };
}

export interface ResolvedXaiConfig {
  xai: {
    baseUrl: string;
    text: JsonRecord;
  };
  loadedFiles: string[];
}

export function resolveXaiConfig(): ResolvedXaiConfig {
  const userSettings = readJsonRecord(USER_PI_SETTINGS_PATH);
  const projectSettings = readJsonRecord(PROJECT_PI_SETTINGS_PATH);
  const loadedFiles = [
    ...(userSettings ? [USER_PI_SETTINGS_PATH] : []),
    ...(projectSettings ? [PROJECT_PI_SETTINGS_PATH] : []),
  ];

  const mergedSettings = mergeRecords(userSettings ?? {}, projectSettings ?? {});
  const mergedXai = getNamespace(mergedSettings, "xai");

  return {
    xai: {
      baseUrl: getString(mergedXai, "baseUrl") || XAI_API_BASE,
      text: getNamespace(mergedXai, "text"),
    },
    loadedFiles,
  };
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

  return {
    enabled: true,
    tools: ["web_search", "x_search", "code_interpreter", "collections_search"],
  };
}
