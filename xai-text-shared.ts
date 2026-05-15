export const XAI_API_BASE = "https://api.x.ai/v1";
export const DEFAULT_XAI_TEXT_MODEL = "grok-4";

export interface XaiTextLogger {
  debug?(msg: string, ...args: unknown[]): void;
  info?(msg: string, ...args: unknown[]): void;
  warn?(msg: string, ...args: unknown[]): void;
  error?(msg: string, ...args: unknown[]): void;
}

export function assertApiKey(apiKey: string | undefined): asserts apiKey is string {
  if (!apiKey || !apiKey.trim()) {
    throw new Error("Missing xAI API key.");
  }
}

export function summarizeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  try {
    return String(error);
  } catch {
    return "Unknown error";
  }
}
