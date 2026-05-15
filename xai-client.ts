import { XAI_API_BASE, assertApiKey, type XaiTextLogger } from "./xai-text-shared.ts";

interface XaiModelsApiResult {
  data?: Array<{
    id?: string;
  }>;
}

export interface XaiClientOptions {
  apiKey: string;
  baseUrl?: string;
  log?: XaiTextLogger;
}

export interface XaiHealthResult {
  ok: true;
  baseUrl: string;
  modelCount: number;
  sampleModels: string[];
  raw: XaiModelsApiResult;
}

export class XaiClient {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly log?: XaiTextLogger;

  constructor(options: XaiClientOptions) {
    assertApiKey(options.apiKey);
    this.apiKey = options.apiKey.trim();
    this.baseUrl = options.baseUrl?.trim().replace(/\/+$/, "") || XAI_API_BASE;
    this.log = options.log;
  }

  private resolveUrl(pathOrUrl: string): string {
    const value = pathOrUrl.trim();
    if (/^https?:\/\//i.test(value)) return value;
    return `${this.baseUrl}${value.startsWith("/") ? value : `/${value}`}`;
  }

  private createHeaders(initHeaders?: HeadersInit, json = true): Headers {
    const headers = new Headers(initHeaders);
    if (!headers.has("Authorization")) {
      headers.set("Authorization", `Bearer ${this.apiKey}`);
    }
    if (json && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }
    return headers;
  }

  async fetchJson<T>(
    pathOrUrl: string,
    init: RequestInit = {},
    log: XaiTextLogger | undefined = this.log,
  ): Promise<T> {
    const url = this.resolveUrl(pathOrUrl);
    const response = await fetch(url, {
      ...init,
      headers: this.createHeaders(init.headers, init.body !== undefined),
    });
    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      log?.error?.(
        `[xai-client] request failed ${response.status} ${url}: ${errorText.slice(0, 500)}`,
      );
      throw new Error(`xAI API error: ${response.status} ${errorText.slice(0, 500)}`);
    }
    return (await response.json()) as T;
  }

  async checkHealth(log: XaiTextLogger | undefined = this.log): Promise<XaiHealthResult> {
    const result = await this.fetchJson<XaiModelsApiResult>("/models", { method: "GET" }, log);
    const sampleModels = (result.data ?? [])
      .map((model) => model.id?.trim())
      .filter((value): value is string => Boolean(value))
      .slice(0, 5);
    return {
      ok: true,
      baseUrl: this.baseUrl,
      modelCount: result.data?.length ?? 0,
      sampleModels,
      raw: result,
    };
  }
}

export function coerceXaiClient(
  clientOrApiKey: string | XaiClient,
  log?: XaiTextLogger,
): XaiClient {
  if (clientOrApiKey instanceof XaiClient) return clientOrApiKey;
  return new XaiClient({ apiKey: clientOrApiKey, log });
}
