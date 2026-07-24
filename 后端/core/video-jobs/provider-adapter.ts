import "server-only";

import { createProvider, ProviderError, type TaskStatus, type VideoResult } from "@backend/providers";
import {
  GoldenMediaModeUnsupportedError,
  GoldenMediaProviderRejectedError,
  GoldenMediaRateLimitedError,
  GoldenMediaSubmissionUncertainError,
  submitGoldenMediaTask,
} from "@server/admin/evals/media-jobs/provider-adapter";
import {
  MotionVideoPollRetryableError,
  MotionVideoRateLimitedError,
  MotionVideoRemoteTaskError,
  MotionVideoSubmissionUncertainError,
  boundedRetryAfterSeconds,
} from "./errors";

export interface MotionVideoProviderConnection {
  provider: string;
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface MotionVideoProviderRequest extends MotionVideoProviderConnection {
  prompt: string;
  firstFrameUrl: string;
  lastFrameUrl?: string;
  width: number;
  height: number;
  durationSeconds: number;
}

export type MotionVideoPollOutcome =
  | { state: "pending"; progress: number | null; retryAfterSeconds?: number }
  | { state: "completed"; remoteUrl: string; result: VideoResult };

/** 单次异步 POST；任何不确定结果都转为 submission_uncertain，绝不在适配器内重提。 */
export async function submitMotionVideoTask(input: MotionVideoProviderRequest): Promise<string> {
  try {
    return await submitGoldenMediaTask({
      provider: input.provider,
      baseUrl: input.baseUrl,
      apiKey: input.apiKey,
      model: input.model,
      requestKind: "video-generation",
      prompt: input.prompt,
      referenceImageUrl: input.firstFrameUrl,
      ...(input.lastFrameUrl ? { lastFrameUrl: input.lastFrameUrl } : {}),
      width: input.width,
      height: input.height,
      durationSeconds: input.durationSeconds,
    });
  } catch (error) {
    if (error instanceof GoldenMediaRateLimitedError) {
      throw new MotionVideoRateLimitedError(
        boundedRetryAfterSeconds(error.retryAfterSeconds, 60),
        error.requestId,
      );
    }
    if (error instanceof GoldenMediaSubmissionUncertainError) {
      throw new MotionVideoSubmissionUncertainError();
    }
    if (error instanceof GoldenMediaModeUnsupportedError) {
      throw new MotionVideoRemoteTaskError(
        "VIDEO_MODE_NOT_RESUMABLE",
        "当前视频模型不支持可恢复异步任务，已在付费前停止",
        "configuration",
        "contact_support",
      );
    }
    if (error instanceof GoldenMediaProviderRejectedError) {
      const category = error.category || (error.statusCode === 401 || error.statusCode === 403
        ? "auth"
        : error.statusCode === 402
          ? "billing"
          : "invalid_input");
      const safety = category === "safety";
      throw new MotionVideoRemoteTaskError(
        error.code || "SUBMISSION_REJECTED",
        safety
          ? "素材未通过视频模型的安全校验，请重生无脸版或保留轻运镜"
          : "视频模型拒绝了任务提交，请检查素材或模型配置",
        category,
        safety ? "regenerate_faceless" : category === "invalid_input" ? "replace_input" : "contact_support",
        error.requestId,
      );
    }
    // POST 抛出的未知网络/超时/解析错误都不能证明供应商没有受理。
    throw new MotionVideoSubmissionUncertainError();
  }
}

/** 每次只执行一次 GET；重试节奏由持久 worker 的 availableAt 控制。 */
export async function pollMotionVideoTask(
  input: MotionVideoProviderConnection,
  remoteTaskId: string,
): Promise<MotionVideoPollOutcome> {
  const provider = createProvider({
    name: input.provider,
    apiKey: input.apiKey,
    baseUrl: input.baseUrl,
    timeout: 15_000,
  });
  let status: TaskStatus;
  try {
    status = await provider.getTaskStatus(remoteTaskId);
  } catch (error) {
    if (error instanceof ProviderError) {
      const category = error.category || "network";
      throw new MotionVideoPollRetryableError(
        boundedRetryAfterSeconds(error.retryAfterSeconds, category === "rate_limit" ? 60 : 5),
        category,
        "供应商状态查询暂时失败，已保留 taskId 等待后台继续轮询",
        error.requestId,
      );
    }
    throw new MotionVideoPollRetryableError();
  }

  if (status.status === "pending" || status.status === "processing") {
    return {
      state: "pending",
      progress: typeof status.progress === "number" && Number.isFinite(status.progress)
        ? Math.max(0, Math.min(100, Math.round(status.progress)))
        : null,
    };
  }
  if (status.status === "failed" || status.status === "cancelled") {
    const code = status.errorCode || (status.status === "cancelled" ? "REMOTE_CANCELLED" : "REMOTE_FAILED");
    const safety = /FACE|SAFETY|SENSITIVE|MODERATION|InputImageSensitiveContentDetected/i.test(
      `${code} ${status.error || ""}`,
    );
    throw new MotionVideoRemoteTaskError(
      safety ? "FACE_BLOCKED" : code,
      safety
        ? "素材未通过视频模型安全校验，请重生无脸版或保留轻运镜"
        : "视频模型任务执行失败",
      safety ? "safety" : "unknown",
      safety ? "regenerate_faceless" : "retry_with_new_operation",
    );
  }
  const result = status.result as VideoResult | undefined;
  const remoteUrl = result?.videoUrls?.find((url) => typeof url === "string" && /^https:\/\//i.test(url));
  if (!result || !remoteUrl) {
    throw new MotionVideoRemoteTaskError(
      "REMOTE_EMPTY_RESULT",
      "视频模型任务完成但没有返回可下载的视频",
      "unknown",
      "contact_support",
    );
  }
  return { state: "completed", remoteUrl, result: { ...result, modelId: input.model } };
}
