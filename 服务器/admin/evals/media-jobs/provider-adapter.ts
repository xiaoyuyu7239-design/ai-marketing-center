import "server-only";

import { readResponseBuffer, safeFetch } from "@backend/shared/ssrf-guard";
import { classifyProviderError, createProvider, type TaskStatus } from "@backend/providers";

export type ResumableGoldenMediaRequestKind = "image-generation" | "video-generation";
export type DurableGoldenMediaRequestKind = ResumableGoldenMediaRequestKind | "tts-generation";

export interface GoldenMediaProviderConnection {
  provider: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  requestKind: ResumableGoldenMediaRequestKind;
}

export interface GoldenMediaProviderRequest extends GoldenMediaProviderConnection {
  prompt: string;
  referenceImageUrl: string;
  /** 仅明确支持首尾帧的异步视频端点使用；其它 provider 会安全忽略。 */
  lastFrameUrl?: string;
  width: number;
  height: number;
  count?: number;
  durationSeconds?: number;
}

export interface GoldenMediaPollPending {
  state: "pending";
  progress: number | null;
}

export interface GoldenMediaPollCompleted {
  state: "completed";
  remoteUrls: string[];
  taskStatus: TaskStatus;
}

export type GoldenMediaPollResult = GoldenMediaPollPending | GoldenMediaPollCompleted;

const MAX_SUBMIT_RESPONSE_BYTES = 1024 * 1024;
const MAX_SUBMIT_ERROR_BYTES = 64 * 1024;

const ASYNC_IMAGE_PROVIDERS = new Set(["atlas-cloud", "fal-ai", "alibaba", "replicate"]);
const ASYNC_VIDEO_PROVIDERS = new Set([
  "atlas-cloud",
  "fal-ai",
  "volcengine",
  "alibaba",
  "siliconflow",
  "zhipu",
  "replicate",
]);
const ONE_SHOT_TTS_PROVIDERS = new Set(["volcengine", "openai", "atlas", "minimax", "falai"]);

export class GoldenMediaModeUnsupportedError extends Error {
  readonly code = "GOLDEN_MEDIA_MODE_NOT_RESUMABLE";

  constructor(provider: string, requestKind: string) {
    super(
      `${provider}/${requestKind} 没有经过“单次提交 + 持久 taskId + 可恢复轮询”验证，已在付费前关闭 Golden 评测`,
    );
    this.name = "GoldenMediaModeUnsupportedError";
  }
}

/**
 * 只放行能把“提交”与“轮询”分开的异步端点。
 * 同步生图和 TTS 没有可 checkpoint 的 taskId，进程在返回前崩溃时无法证明是否已计费，
 * 因此不允许进入付费执行器。
 */
export function assertResumableGoldenMediaMode(provider: string, requestKind: string): asserts requestKind is ResumableGoldenMediaRequestKind {
  const supported = requestKind === "image-generation"
    ? ASYNC_IMAGE_PROVIDERS.has(provider)
    : requestKind === "video-generation"
      ? ASYNC_VIDEO_PROVIDERS.has(provider)
      : false;
  if (!supported) throw new GoldenMediaModeUnsupportedError(provider, requestKind);
}

/**
 * TTS 虽无法持久化 taskId，但可在 job 已落 submitting 后执行一次 one-shot：
 * 任何中断/结果不明都进 submission_uncertain，永不重提。
 */
export function assertDurableGoldenMediaMode(
  provider: string,
  requestKind: string,
): asserts requestKind is DurableGoldenMediaRequestKind {
  if (requestKind === "tts-generation" && ONE_SHOT_TTS_PROVIDERS.has(provider)) return;
  assertResumableGoldenMediaMode(provider, requestKind);
}

export class GoldenMediaSubmissionUncertainError extends Error {
  readonly code = "SUBMISSION_UNCERTAIN";

  constructor(provider: string) {
    super(`${provider} 提交结果未知；为避免第二笔付费，该幂等键不会自动重提`);
    this.name = "GoldenMediaSubmissionUncertainError";
  }
}

/** 供应商明确返回 429，表示该 HTTP 请求未受理，可按 Retry-After 安全延后提交。 */
export class GoldenMediaRateLimitedError extends Error {
  readonly code = "RATE_LIMITED";

  constructor(
    readonly retryAfterSeconds: number,
    readonly requestId?: string,
  ) {
    super("媒体模型当前限流，任务会按 Retry-After 自动继续");
    this.name = "GoldenMediaRateLimitedError";
  }
}

export class GoldenMediaProviderRejectedError extends Error {
  readonly code: string;
  readonly statusCode?: number;

  constructor(
    message: string,
    code: string,
    statusCode?: number,
    readonly category = "invalid_input",
    readonly requestId?: string,
  ) {
    super(message);
    this.name = "GoldenMediaProviderRejectedError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export class GoldenMediaPollRetryableError extends Error {
  readonly code = "GOLDEN_MEDIA_POLL_RETRYABLE";

  constructor() {
    super("供应商状态查询暂时失败，已保留 taskId 等待持久 worker 继续轮询");
    this.name = "GoldenMediaPollRetryableError";
  }
}

export class GoldenMediaRemoteTaskError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "GoldenMediaRemoteTaskError";
    this.code = code;
  }
}

function normalizedBaseUrl(baseUrl: string): string {
  const parsed = new URL(baseUrl);
  const local = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "::1";
  if (parsed.username || parsed.password || parsed.hash) {
    throw new GoldenMediaProviderRejectedError(
      "模型端点 URL 不得携带凭据或 fragment",
      "INVALID_ENDPOINT",
      undefined,
      "configuration",
    );
  }
  if (parsed.protocol !== "https:" && !(process.env.NODE_ENV !== "production" && parsed.protocol === "http:" && local)) {
    throw new GoldenMediaProviderRejectedError(
      "媒体评测端点必须使用 HTTPS",
      "INVALID_ENDPOINT",
      undefined,
      "configuration",
    );
  }
  return baseUrl.replace(/\/+$/, "");
}

function authHeaders(provider: string, apiKey: string): Record<string, string> {
  return {
    Authorization: provider === "fal-ai" ? `Key ${apiKey}` : `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
}

function imageSizeForFal(model: string, width: number, height: number) {
  if (model.includes("gpt-image-1.5")) {
    if (width > height) return "1536x1024";
    if (height > width) return "1024x1536";
    return "1024x1024";
  }
  if (model.includes("gpt-image-2")) {
    const round16 = (value: number) => Math.max(16, Math.round(value / 16) * 16);
    return { width: round16(width), height: round16(height) };
  }
  return { width, height };
}

function retryAfterSeconds(response: Response): number {
  const raw = response.headers.get("retry-after")?.trim();
  if (!raw) return 60;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.min(24 * 60 * 60, Math.max(1, Math.ceil(seconds)));
  const date = Date.parse(raw);
  if (!Number.isFinite(date)) return 60;
  return Math.min(24 * 60 * 60, Math.max(1, Math.ceil((date - Date.now()) / 1000)));
}

interface GoldenMediaErrorSummary {
  code?: string;
  message?: string;
  requestId?: string;
}

function errorRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function safeErrorCode(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(normalized) ? normalized : undefined;
}

function safeRequestId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(normalized) ? normalized : undefined;
}

/** 仅用于分类，绝不原样返回或持久化供应商 message。 */
function safeClassificationMessage(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\bBearer\s+[^\s,;"']+/gi, "Bearer [REDACTED]")
    .replace(/((?:authorization|api[_-]?key|access[_-]?token|secret|password)\s*[=:]\s*["']?)[^\s,;"'}]+/gi, "$1[REDACTED]")
    .replace(/\b(?:sk|key)-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
  return normalized || undefined;
}

async function submitErrorSummary(response: Response): Promise<GoldenMediaErrorSummary> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_SUBMIT_ERROR_BYTES) {
    await response.body?.cancel("golden-media-provider-error-too-large").catch(() => undefined);
    return {};
  }
  try {
    const body = await readResponseBuffer(response, MAX_SUBMIT_ERROR_BYTES);
    const root = errorRecord(JSON.parse(body.toString("utf8")) as unknown);
    const nested = errorRecord(root.error);
    return {
      code: safeErrorCode(nested.code) ?? safeErrorCode(root.code),
      message: safeClassificationMessage(nested.message) ?? safeClassificationMessage(root.message),
      requestId: safeRequestId(nested.requestId)
        ?? safeRequestId(nested.request_id)
        ?? safeRequestId(root.requestId)
        ?? safeRequestId(root.request_id),
    };
  } catch {
    await response.body?.cancel("golden-media-provider-error-invalid").catch(() => undefined);
    return {};
  }
}

function submissionSpec(input: GoldenMediaProviderRequest): {
  path: string;
  body: Record<string, unknown>;
  headers?: Record<string, string>;
  taskId(response: Record<string, unknown>): string | null;
} {
  const { provider, requestKind, model, prompt, referenceImageUrl, width, height } = input;
  const duration = input.durationSeconds ?? 5;

  if (provider === "atlas-cloud") {
    return requestKind === "image-generation"
      ? {
          path: "/model/generateImage",
          body: { model, prompt, size: `${width}x${height}`, images: [referenceImageUrl] },
          taskId: (response) => {
            const data = response.data && typeof response.data === "object" ? response.data as Record<string, unknown> : {};
            return typeof data.id === "string" ? data.id : typeof response.id === "string" ? response.id : null;
          },
        }
      : {
          path: "/model/generateVideo",
          body: {
            model,
            prompt,
            image: referenceImageUrl,
            duration,
            resolution: Math.min(width, height) >= 1080 ? "1080p" : "720p",
            ratio: height > width ? "9:16" : width > height ? "16:9" : "1:1",
            generate_audio: false,
            watermark: false,
          },
          taskId: (response) => {
            const data = response.data && typeof response.data === "object" ? response.data as Record<string, unknown> : {};
            return typeof data.id === "string" ? data.id : typeof response.id === "string" ? response.id : null;
          },
        };
  }

  if (provider === "fal-ai") {
    if (requestKind === "image-generation") {
      const edit = model.includes("/edit") || model.includes("/image-to-image");
      return {
        path: `/${model}`,
        body: {
          prompt,
          image_size: imageSizeForFal(model, width, height),
          num_images: input.count ?? 1,
          ...(edit ? { image_urls: [referenceImageUrl] } : { image_url: referenceImageUrl }),
        },
        taskId: (response) => typeof response.request_id === "string" ? `${model}::${response.request_id}` : null,
      };
    }
    return {
      path: `/${model}`,
      body: {
        prompt,
        video_size: { width, height },
        duration,
        image_url: referenceImageUrl,
        audio: false,
      },
      taskId: (response) => typeof response.request_id === "string" ? `${model}::${response.request_id}` : null,
    };
  }

  if (provider === "alibaba") {
    return requestKind === "image-generation"
      ? {
          path: "/services/aigc/text2image/image-synthesis",
          headers: { "X-DashScope-Async": "enable" },
          body: {
            model,
            input: { prompt, ref_img: referenceImageUrl },
            parameters: { size: `${width}*${height}`, n: input.count ?? 1 },
          },
          taskId: (response) => {
            const output = response.output && typeof response.output === "object" ? response.output as Record<string, unknown> : {};
            return typeof output.task_id === "string" ? output.task_id : null;
          },
        }
      : {
          path: "/services/aigc/video-generation/generation",
          headers: { "X-DashScope-Async": "enable" },
          body: {
            model,
            input: { prompt, img_url: referenceImageUrl },
            parameters: { size: `${width}*${height}`, duration, enable_audio: false },
          },
          taskId: (response) => {
            const output = response.output && typeof response.output === "object" ? response.output as Record<string, unknown> : {};
            return typeof output.task_id === "string" ? output.task_id : null;
          },
        };
  }

  if (provider === "replicate") {
    const mediaInput = requestKind === "image-generation"
      ? {
          prompt,
          aspect_ratio: height > width ? "9:16" : width > height ? "16:9" : "1:1",
          num_outputs: input.count ?? 1,
          output_format: "png",
          image: referenceImageUrl,
        }
      : {
          prompt,
          duration,
          start_image: referenceImageUrl,
          image: referenceImageUrl,
        };
    return {
      path: `/models/${model}/predictions`,
      body: { input: mediaInput },
      taskId: (response) => typeof response.id === "string" ? response.id : null,
    };
  }

  if (provider === "volcengine" && requestKind === "video-generation") {
    const content: Array<Record<string, unknown>> = [{ type: "text", text: prompt }];
    if (input.lastFrameUrl) {
      content.push({ type: "image_url", image_url: { url: referenceImageUrl }, role: "first_frame" });
      content.push({ type: "image_url", image_url: { url: input.lastFrameUrl }, role: "last_frame" });
    } else {
      content.push({ type: "image_url", image_url: { url: referenceImageUrl } });
    }
    return {
      path: "/contents/generations/tasks",
      body: {
        model,
        content,
        ratio: height > width ? "9:16" : width > height ? "16:9" : "1:1",
        duration,
        generate_audio: false,
        watermark: false,
      },
      taskId: (response) => typeof response.id === "string" ? response.id : null,
    };
  }

  if (provider === "siliconflow" && requestKind === "video-generation") {
    return {
      path: "/video/submit",
      body: { model, prompt, image_size: `${width}x${height}`, image: referenceImageUrl },
      taskId: (response) => typeof response.requestId === "string" ? response.requestId : null,
    };
  }

  if (provider === "zhipu" && requestKind === "video-generation") {
    return {
      path: "/videos/generations",
      body: {
        model,
        prompt,
        image_url: referenceImageUrl,
        size: height > width ? "1080x1920" : width > height ? "1920x1080" : "1024x1024",
        ...(!/flash/i.test(model) ? { quality: "quality" } : {}),
        with_audio: false,
      },
      taskId: (response) => typeof response.id === "string" ? response.id : null,
    };
  }

  throw new GoldenMediaModeUnsupportedError(provider, requestKind);
}

async function responseJson(response: Response): Promise<Record<string, unknown>> {
  const value = await readResponseBuffer(response, MAX_SUBMIT_RESPONSE_BYTES);
  const parsed = JSON.parse(value.toString("utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new SyntaxError("response is not an object");
  return parsed as Record<string, unknown>;
}

/**
 * 只发一次 POST，绝不在这里重试。超时、断网、5xx、2xx 但 taskId 缺失都属于
 * “可能已受理”；上层必须将幂等记录终止为 submission_uncertain。明确 429 表示未受理，
 * 上层可按 Retry-After 安全重新排队。
 */
export async function submitGoldenMediaTask(input: GoldenMediaProviderRequest): Promise<string> {
  assertResumableGoldenMediaMode(input.provider, input.requestKind);
  const spec = submissionSpec(input);
  const url = `${normalizedBaseUrl(input.baseUrl)}${spec.path}`;
  const endpoint = new URL(url);
  let response: Response;
  try {
    response = await safeFetch(url, {
      method: "POST",
      headers: { ...authHeaders(input.provider, input.apiKey), ...spec.headers },
      body: JSON.stringify(spec.body),
      signal: AbortSignal.timeout(30_000),
    }, 0, {
      allowedProtocols: [endpoint.protocol as "http:" | "https:"],
      allowedHosts: [endpoint.hostname],
      allowedPorts: [endpoint.port],
    });
  } catch {
    throw new GoldenMediaSubmissionUncertainError(input.provider);
  }

  if (!response.ok) {
    const summary = await submitErrorSummary(response);
    const category = classifyProviderError({
      statusCode: response.status,
      code: summary.code,
      message: summary.message,
    });
    const retryAfter = response.status === 429 ? retryAfterSeconds(response) : null;
    if (retryAfter != null) throw new GoldenMediaRateLimitedError(retryAfter, summary.requestId);
    if (response.status >= 500) {
      throw new GoldenMediaSubmissionUncertainError(input.provider);
    }
    throw new GoldenMediaProviderRejectedError(
      `${input.provider} 拒绝了媒体评测提交（HTTP ${response.status}）`,
      response.status >= 300 && response.status < 400
        ? "REDIRECT_REJECTED"
        : summary.code || (category === "safety" ? "SAFETY_REJECTED" : "SUBMISSION_REJECTED"),
      response.status,
      category,
      summary.requestId,
    );
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = await responseJson(response);
  } catch {
    throw new GoldenMediaSubmissionUncertainError(input.provider);
  }
  const taskId = spec.taskId(parsed)?.trim();
  if (!taskId || taskId.length > 2_000) throw new GoldenMediaSubmissionUncertainError(input.provider);
  return taskId;
}

/** 每次只查一次状态；调度间隔和恢复由持久 worker 负责，不在内存里 sleep 十分钟。 */
export async function pollGoldenMediaTask(
  input: GoldenMediaProviderConnection,
  taskId: string,
): Promise<GoldenMediaPollResult> {
  assertResumableGoldenMediaMode(input.provider, input.requestKind);
  const provider = createProvider({
    name: input.provider,
    apiKey: input.apiKey,
    baseUrl: normalizedBaseUrl(input.baseUrl),
    timeout: 15_000,
  });
  let status: TaskStatus;
  try {
    status = await provider.getTaskStatus(taskId);
  } catch {
    // GET 的 4xx/5xx/断网只能证明“查不到”，不能证明远程付费任务已失败。
    // 持续保留 taskId 并恢复轮询；达上限后由仓储层标记 POLL_TIMEOUT 供人工核对。
    throw new GoldenMediaPollRetryableError();
  }

  if (status.status === "pending" || status.status === "processing") {
    return {
      state: "pending",
      progress: typeof status.progress === "number" && Number.isFinite(status.progress) ? status.progress : null,
    };
  }
  if (status.status === "failed" || status.status === "cancelled") {
    throw new GoldenMediaRemoteTaskError(
      status.errorCode || (status.status === "cancelled" ? "REMOTE_CANCELLED" : "REMOTE_FAILED"),
      `${input.provider} 媒体任务${status.status === "cancelled" ? "已取消" : "执行失败"}`,
    );
  }

  const result = status.result;
  const remoteUrls = input.requestKind === "image-generation"
    ? result && "imageUrls" in result ? result.imageUrls : []
    : result && "videoUrls" in result ? result.videoUrls : [];
  const safeUrls = remoteUrls.filter((url): url is string => typeof url === "string" && url.length > 0);
  if (!safeUrls.length) {
    throw new GoldenMediaRemoteTaskError("REMOTE_EMPTY_RESULT", `${input.provider} 任务完成但未返回期望媒体`);
  }
  if (result) result.modelId = input.model;
  return { state: "completed", remoteUrls: safeUrls, taskStatus: status };
}
