import { toSafeProviderErrorDto } from "@backend/providers/base";
import type { MotionVideoJobErrorDto } from "./types";

export class MotionVideoJobInputError extends Error {
  readonly code = "MOTION_JOB_INPUT_INVALID";
  constructor(message: string) {
    super(message);
    this.name = "MotionVideoJobInputError";
  }
}

export class MotionVideoJobIdempotencyConflictError extends Error {
  readonly code = "MOTION_JOB_IDEMPOTENCY_CONFLICT";
  constructor() {
    super("operationId 已用于另一组动态镜头或素材版本，请重新发起");
    this.name = "MotionVideoJobIdempotencyConflictError";
  }
}

export class MotionVideoJobQueueLimitError extends Error {
  readonly code = "MOTION_JOB_QUEUE_FULL";
  readonly scope: "merchant" | "global";
  constructor(scope: "merchant" | "global") {
    super(scope === "merchant" ? "当前账号的动态任务较多，请等待已有任务完成" : "动态任务队列已满，请稍后重试");
    this.name = "MotionVideoJobQueueLimitError";
    this.scope = scope;
  }
}

export class MotionVideoJobLeaseLostError extends Error {
  readonly code = "MOTION_JOB_LEASE_LOST";
  constructor() {
    super("动态任务租约已失效，旧 worker 无权回写");
    this.name = "MotionVideoJobLeaseLostError";
  }
}

/** 供应商明确返回 429，HTTP 语义表明本次未受理，可安全延后同一次提交。 */
export class MotionVideoRateLimitedError extends Error {
  readonly code = "RATE_LIMITED";
  readonly category = "rate_limit";
  readonly retryable = true;
  readonly suggestedAction = "wait_and_retry";
  constructor(
    readonly retryAfterSeconds: number,
    readonly requestId?: string,
  ) {
    super("视频模型当前限流，任务会在后台自动继续");
    this.name = "MotionVideoRateLimitedError";
  }
}

export class MotionVideoSubmissionUncertainError extends Error {
  readonly code = "SUBMISSION_UNCERTAIN";
  readonly category = "unknown";
  readonly retryable = false;
  readonly suggestedAction = "contact_support";
  constructor() {
    super("供应商提交结果未知；为避免重复计费，该任务不会自动重提");
    this.name = "MotionVideoSubmissionUncertainError";
  }
}

export class MotionVideoPollRetryableError extends Error {
  readonly code = "POLL_RETRYABLE";
  readonly retryable = true;
  readonly suggestedAction = "wait_and_retry";
  constructor(
    readonly retryAfterSeconds = 5,
    readonly category = "network",
    message = "供应商状态查询暂时失败，已保留 taskId 等待后台继续轮询",
    readonly requestId?: string,
  ) {
    super(message);
    this.name = "MotionVideoPollRetryableError";
  }
}

export class MotionVideoDownloadRetryableError extends MotionVideoPollRetryableError {
  constructor(retryAfterSeconds = 10, category = "network") {
    super(retryAfterSeconds, category, "生成结果下载暂时失败，后台会继续尝试，不会重新提交模型");
    this.name = "MotionVideoDownloadRetryableError";
  }
}

export class MotionVideoRemoteTaskError extends Error {
  readonly retryable = false;
  constructor(
    readonly code: string,
    message: string,
    readonly category = "unknown",
    readonly suggestedAction?: string,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = "MotionVideoRemoteTaskError";
  }
}

export class MotionVideoSourceChangedError extends Error {
  readonly code = "SOURCE_CHANGED";
  readonly category = "invalid_input";
  readonly retryable = false;
  readonly suggestedAction = "restart_motion_generation";
  constructor() {
    super("分镜图在动态生成期间已被替换，结果未覆盖新素材；请基于新图重新发起");
    this.name = "MotionVideoSourceChangedError";
  }
}

export function boundedRetryAfterSeconds(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(24 * 60 * 60, Math.max(1, Math.ceil(value)))
    : fallback;
}

export function motionVideoErrorDto(error: unknown): MotionVideoJobErrorDto {
  if (
    error instanceof MotionVideoRateLimitedError
    || error instanceof MotionVideoPollRetryableError
    || error instanceof MotionVideoSubmissionUncertainError
    || error instanceof MotionVideoRemoteTaskError
    || error instanceof MotionVideoSourceChangedError
  ) {
    return {
      code: error.code,
      category: error.category,
      message: error.message,
      retryable: error.retryable,
      ...("retryAfterSeconds" in error
        ? { retryAfterSeconds: boundedRetryAfterSeconds(error.retryAfterSeconds, 5) }
        : {}),
      ...(error.suggestedAction ? { suggestedAction: error.suggestedAction } : {}),
      ...("requestId" in error && typeof error.requestId === "string" && error.requestId
        ? { requestId: error.requestId }
        : {}),
    };
  }
  return toSafeProviderErrorDto(error);
}
