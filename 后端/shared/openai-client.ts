import "server-only";

import OpenAI from "openai";
import { safeFetch } from "./ssrf-guard";
import { singleUserModeEnabled } from "@backend/core/security/runtime-config";
import { captureProviderModelPayloadReporter } from "./model-telemetry";

const MAX_MODEL_REQUEST_BYTES = 5 * 1024 * 1024;
const MAX_MODEL_RESPONSE_BYTES = 10 * 1024 * 1024;
const DEFAULT_MODEL_TIMEOUT_MS = 30_000;

export interface SafeOpenAIClientOptions {
  baseURL: string;
  apiKey: string;
  timeout?: number;
  maxRetries?: number;
}

function parseBaseUrl(raw: string) {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("模型端点配置无效");
  }
  if (parsed.username || parsed.password || parsed.hash || parsed.search) {
    throw new Error("模型端点不得携带凭据、查询参数或 fragment");
  }
  const local = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]";
  const localDesktop = parsed.protocol === "http:" && local && singleUserModeEnabled();
  if (parsed.protocol !== "https:" && !localDesktop) {
    throw new Error("SaaS 模型端点必须使用 HTTPS");
  }
  return { parsed, localDesktop };
}

function safeResponseHeaders(headers: Headers) {
  const safe = new Headers();
  for (const name of ["content-type", "retry-after", "retry-after-ms", "x-request-id", "request-id", "x-should-retry"]) {
    const value = headers.get(name);
    if (value) safe.set(name, value);
  }
  return safe;
}

function limitedModelResponse(response: Response): Response {
  const declared = Number(response.headers.get("content-length") || 0);
  if (Number.isFinite(declared) && declared > MAX_MODEL_RESPONSE_BYTES) {
    void response.body?.cancel("model-response-too-large");
    throw new Error("MODEL_RESPONSE_TOO_LARGE");
  }
  if (!response.body) return response;

  const reader = response.body.getReader();
  const reportPayload = captureProviderModelPayloadReporter();
  let total = 0;
  const observed: Uint8Array[] = [];
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          try {
            const text = Buffer.concat(observed).toString("utf8");
            if (/^\s*data:/m.test(text)) {
              let lastPayload: unknown;
              for (const line of text.split(/\r?\n/)) {
                const match = line.match(/^\s*data:\s*(.+)\s*$/);
                if (!match || match[1] === "[DONE]") continue;
                try {
                  const payload = JSON.parse(match[1]);
                  if (payload && typeof payload === "object" && "usage" in payload) lastPayload = payload;
                } catch {
                  // Ignore non-JSON SSE metadata; the SDK remains responsible for parsing the stream.
                }
              }
              if (lastPayload) reportPayload(lastPayload);
            } else if (text.trim()) {
              reportPayload(JSON.parse(text));
            }
          } catch {
            // Observability must never change a successful provider response into an application error.
          }
          controller.close();
          return;
        }
        total += chunk.value.byteLength;
        if (total > MAX_MODEL_RESPONSE_BYTES) {
          await reader.cancel("model-response-too-large");
          controller.error(new Error("MODEL_RESPONSE_TOO_LARGE"));
          return;
        }
        observed.push(chunk.value);
        controller.enqueue(chunk.value);
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel(reason) {
      await reader.cancel(reason).catch(() => undefined);
    },
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function knownBodyBytes(body: BodyInit | null | undefined): number | null {
  if (body == null) return 0;
  if (typeof body === "string") return Buffer.byteLength(body);
  if (body instanceof URLSearchParams) return Buffer.byteLength(body.toString());
  if (body instanceof Blob) return body.size;
  if (body instanceof ArrayBuffer) return body.byteLength;
  if (ArrayBuffer.isView(body)) return body.byteLength;
  return null;
}

/** OpenAI SDK 专用 fetch：同源、公网/HTTPS、完整超时、错误体丢弃和流式响应上限。 */
export function createSafeModelFetch(baseURL: string, timeoutMs = DEFAULT_MODEL_TIMEOUT_MS): typeof fetch {
  const { parsed: base, localDesktop } = parseBaseUrl(baseURL);
  const boundedTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_MODEL_TIMEOUT_MS;

  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const source = input instanceof Request ? input : null;
    const target = new URL(source?.url || String(input));
    if (target.origin !== base.origin) throw new Error("模型请求目标与已配置端点不同源");

    const method = (init?.method || source?.method || "GET").toUpperCase();
    const headers = new Headers(source?.headers);
    new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
    let body = init?.body;
    if (body === undefined && source && method !== "GET" && method !== "HEAD") {
      const bytes = await source.clone().arrayBuffer();
      if (bytes.byteLength > MAX_MODEL_REQUEST_BYTES) throw new Error("MODEL_REQUEST_TOO_LARGE");
      body = new Uint8Array(bytes);
    }
    const requestBytes = knownBodyBytes(body);
    if (requestBytes !== null && requestBytes > MAX_MODEL_REQUEST_BYTES) {
      throw new Error("MODEL_REQUEST_TOO_LARGE");
    }
    const timeoutSignal = AbortSignal.timeout(boundedTimeout);
    const suppliedSignal = init?.signal || source?.signal;
    const signal = suppliedSignal ? AbortSignal.any([suppliedSignal, timeoutSignal]) : timeoutSignal;
    const requestInit: RequestInit = { ...init, method, headers, body, signal };

    const response = localDesktop
      ? await fetch(target, { ...requestInit, redirect: "manual" })
      : await safeFetch(target.href, requestInit, 0, {
          allowedProtocols: ["https:"],
          allowedHosts: [base.hostname],
          allowedPorts: [base.port],
        });

    if (!response.ok) {
      await response.body?.cancel("model-provider-error").catch(() => undefined);
      return new Response(null, {
        status: response.status,
        statusText: response.statusText,
        headers: safeResponseHeaders(response.headers),
      });
    }
    return limitedModelResponse(response);
  };
}

export function createSafeOpenAIClient(options: SafeOpenAIClientOptions): OpenAI {
  return new OpenAI({
    ...options,
    timeout: options.timeout ?? DEFAULT_MODEL_TIMEOUT_MS,
    maxRetries: options.maxRetries ?? 0,
    fetch: createSafeModelFetch(options.baseURL, options.timeout),
  });
}
