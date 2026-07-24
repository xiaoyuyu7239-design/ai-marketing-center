import "server-only";

import { randomUUID } from "node:crypto";
import { mkdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";

import { getDefaultFaceDetector } from "@backend/core/motion/local-face-detector";
import type { FaceDetector } from "@backend/core/motion/face-detector";
import { evaluateOwnedMotionEligibility } from "@backend/core/motion/eligibility-service";
import { canSubmitAiVideo, motionEligibilityBindingsMatch } from "@backend/core/motion/eligibility";
import { ensureStorageCapacity } from "@backend/core/security/storage-guard";
import { getDb } from "@backend/db";
import { assets } from "@backend/db/schema";
import { readResponseBuffer, safeFetchPinned } from "@backend/shared/ssrf-guard";
import { getUploadsDir } from "@backend/shared/paths";
import { toRemoteUsableImage } from "@backend/shared/remote-image";
import { toLLMConfig } from "@server/admin/agents";
import {
  MotionVideoDownloadRetryableError,
  MotionVideoJobInputError,
  MotionVideoRemoteTaskError,
  MotionVideoSourceChangedError,
} from "./errors";
import {
  pollMotionVideoTask,
  submitMotionVideoTask,
  type MotionVideoPollOutcome,
} from "./provider-adapter";
import type { MotionVideoJobRecord } from "./repository";
import type { MotionVideoJobPayloadV1, PersistedMotionFrame } from "./types";

const MAX_REMOTE_VIDEO_BYTES = 160 * 1024 * 1024;

export function motionVideoPayload(job: MotionVideoJobRecord): MotionVideoJobPayloadV1 {
  const payload = job.payload as Partial<MotionVideoJobPayloadV1> | null;
  if (
    job.payloadVersion !== 1
    || !payload
    || payload.version !== 1
    || !payload.endpoint
    || !payload.source
    || !payload.options
    || typeof payload.prompt !== "string"
  ) throw new MotionVideoJobInputError("动态任务 payload 版本不受支持");
  return payload as MotionVideoJobPayloadV1;
}

function selectedModel(model: string): string {
  return model.includes("/text-to-video") ? model.replace("/text-to-video", "/image-to-video") : model;
}

async function reevaluateFrame(
  job: MotionVideoJobRecord,
  frame: PersistedMotionFrame,
  faceDetector: FaceDetector,
) {
  const asset = getDb().select().from(assets).where(and(
    eq(assets.id, frame.assetId),
    eq(assets.projectId, job.projectId),
    eq(assets.shotId, frame.shot.shotId),
  )).limit(1).all()[0];
  if (!asset || asset.filePath !== frame.imageRef || asset.status !== "done") {
    throw new MotionVideoSourceChangedError();
  }
  return evaluateOwnedMotionEligibility({
    merchantId: job.merchantId,
    projectId: job.projectId,
    shot: {
      type: frame.shot.type,
      visualSource: frame.shot.visualSource,
    },
    asset,
    faceDetector,
  });
}

async function assertFrameStillEligible(
  job: MotionVideoJobRecord,
  frame: PersistedMotionFrame,
  faceDetector: FaceDetector,
) {
  const current = await reevaluateFrame(job, frame, faceDetector);
  if (
    current.decision.policy !== "ai_video"
    || current.decision.state !== "eligible"
    || !canSubmitAiVideo(frame.decision, current.decision.binding)
    || !motionEligibilityBindingsMatch(frame.decision.binding, current.decision.binding)
  ) {
    throw new MotionVideoRemoteTaskError(
      "MOTION_ELIGIBILITY_STALE",
      "分镜图的动态资格、人脸结果或检测器版本已变化，已在付费前停止提交",
      "safety",
      current.decision.policy === "regenerate_faceless" ? "regenerate_faceless" : "use_static_pan",
    );
  }
}

export interface MotionVideoSubmissionDependencies {
  /** 只用于服务端替换本地检测实现与测试；浏览器不能控制。 */
  faceDetector?: FaceDetector;
  /** 测试注入点，用于证明预检失败时不会发起付费 POST。 */
  submitTask?: typeof submitMotionVideoTask;
}

/** 付费提交前最后一次重算 hash/尺寸/人脸；随后只发一次异步 POST。 */
export async function submitPersistedMotionVideoJob(
  job: MotionVideoJobRecord,
  dependencies: MotionVideoSubmissionDependencies = {},
): Promise<string> {
  if (job.status !== "submitting" || job.remoteTaskId) {
    throw new MotionVideoJobInputError("只有无 taskId 的 submitting 任务允许提交");
  }
  const payload = motionVideoPayload(job);
  const faceDetector = dependencies.faceDetector ?? getDefaultFaceDetector();
  await assertFrameStillEligible(job, payload.source, faceDetector);
  if (payload.lastFrame) await assertFrameStillEligible(job, payload.lastFrame, faceDetector);

  const config = toLLMConfig(payload.endpoint);
  if (!config.apiKey) {
    throw new MotionVideoRemoteTaskError(
      "VIDEO_CONFIG_UNAVAILABLE",
      "视频模型策略没有可用凭据",
      "configuration",
      "contact_support",
    );
  }
  const firstFrameUrl = await toRemoteUsableImage(payload.source.imageRef);
  const lastFrameUrl = payload.lastFrame
    ? await toRemoteUsableImage(payload.lastFrame.imageRef)
    : undefined;
  if (!firstFrameUrl || (payload.lastFrame && !lastFrameUrl)) {
    throw new MotionVideoSourceChangedError();
  }
  return (dependencies.submitTask ?? submitMotionVideoTask)({
    provider: config.provider,
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    model: selectedModel(config.model),
    prompt: payload.prompt,
    firstFrameUrl,
    ...(lastFrameUrl ? { lastFrameUrl } : {}),
    width: payload.options.width,
    height: payload.options.height,
    durationSeconds: payload.options.duration,
  });
}

export async function pollPersistedMotionVideoJob(
  job: MotionVideoJobRecord,
): Promise<MotionVideoPollOutcome> {
  if (job.status !== "polling" || !job.remoteTaskId) {
    throw new MotionVideoJobInputError("只有已 checkpoint taskId 的 polling 任务允许查询");
  }
  const payload = motionVideoPayload(job);
  const config = toLLMConfig(payload.endpoint);
  if (!config.apiKey) {
    // taskId 已存在；配置短暂不可用也只能保留任务等待，不能改走另一个模型。
    throw new MotionVideoDownloadRetryableError(60, "configuration");
  }
  return pollMotionVideoTask({
    provider: config.provider,
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    model: selectedModel(config.model),
  }, job.remoteTaskId);
}

function extension(contentType: string, remoteUrl: string): "mp4" | "webm" | "mov" {
  if (/webm/i.test(contentType) || /\.webm(?:[?#]|$)/i.test(remoteUrl)) return "webm";
  if (/quicktime|mov/i.test(contentType) || /\.mov(?:[?#]|$)/i.test(remoteUrl)) return "mov";
  return "mp4";
}

function retryAfter(response: Response): number {
  const seconds = Number(response.headers.get("retry-after"));
  return Number.isFinite(seconds) ? Math.min(24 * 60 * 60, Math.max(1, Math.ceil(seconds))) : 10;
}

/** 下载到 deterministic 路径；崩溃恢复重复执行时复用已完整落盘文件。 */
export async function persistMotionVideoOutput(
  job: MotionVideoJobRecord,
  remoteUrl: string,
): Promise<string> {
  if (!/^[A-Za-z0-9-]+$/.test(job.projectId) || !/^[A-Za-z0-9-]+$/.test(job.id)) {
    throw new MotionVideoJobInputError("动态任务路径标识不合法");
  }
  const baseName = `motion-${job.shotId}-${job.id}`;
  const projectDir = join(getUploadsDir(), job.projectId);
  // 远程 content-type 决定最终扩展名；先检查所有支持扩展的 deterministic 文件。
  for (const ext of ["mp4", "webm", "mov"] as const) {
    const existing = join(projectDir, `${baseName}.${ext}`);
    const info = await stat(existing).catch(() => null);
    if (info?.isFile() && info.size > 0 && info.size <= MAX_REMOTE_VIDEO_BYTES) {
      return `/api/files/${job.projectId}/${baseName}.${ext}`;
    }
  }

  let response: Response;
  try {
    response = await safeFetchPinned(remoteUrl, {
      headers: { Accept: "video/mp4,video/webm,video/quicktime,application/octet-stream" },
      signal: AbortSignal.timeout(120_000),
    });
  } catch {
    throw new MotionVideoDownloadRetryableError();
  }
  if (!response.ok) {
    const delay = response.status === 429 ? retryAfter(response) : 10;
    await response.body?.cancel("motion-video-download-error").catch(() => undefined);
    throw new MotionVideoDownloadRetryableError(delay, response.status === 429 ? "rate_limit" : "network");
  }
  const contentType = (response.headers.get("content-type") || "").toLowerCase();
  if (
    contentType
    && !/^video\/(?:mp4|webm|quicktime)/i.test(contentType)
    && !/^application\/(?:octet-stream|mp4)/i.test(contentType)
  ) {
    await response.body?.cancel("motion-video-invalid-content-type").catch(() => undefined);
    throw new MotionVideoRemoteTaskError(
      "INVALID_VIDEO_RESULT",
      "供应商返回的生成结果不是受支持的视频类型",
      "unknown",
      "contact_support",
    );
  }
  let buffer: Buffer;
  try {
    buffer = await readResponseBuffer(response, MAX_REMOTE_VIDEO_BYTES);
  } catch {
    throw new MotionVideoDownloadRetryableError();
  }
  if (!buffer.length) {
    throw new MotionVideoRemoteTaskError("EMPTY_VIDEO_RESULT", "供应商返回了空视频文件", "unknown", "contact_support");
  }
  await ensureStorageCapacity(buffer.byteLength);
  await mkdir(projectDir, { recursive: true });
  const ext = extension(contentType, remoteUrl);
  const fileName = `${baseName}.${ext}`;
  const finalPath = join(projectDir, fileName);
  const temporaryPath = join(projectDir, `.${fileName}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, buffer, { flag: "wx" });
    await rename(temporaryPath, finalPath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
  return `/api/files/${job.projectId}/${fileName}`;
}
