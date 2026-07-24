import "server-only";

import { desc, eq, sql } from "drizzle-orm";

import {
  assessMotionEligibility,
  decideLastFrame,
  type FaceAssessment,
  type MotionEligibilityDecision,
} from "@backend/core/motion/eligibility";
import { evaluateOwnedMotionEligibility, type OwnedMotionEligibilityResult } from "@backend/core/motion/eligibility-service";
import { getDefaultFaceDetector } from "@backend/core/motion/local-face-detector";
import type { FaceDetector } from "@backend/core/motion/face-detector";
import { hashGenerationRequest } from "@backend/core/auth/usage";
import { getDb } from "@backend/db";
import { assets, projects, scripts, videoClips, type Shot } from "@backend/db/schema";
import {
  endpointReady,
  getAgentOrThrow,
  getAgentStrategy,
  type AgentEndpointRole,
  type ModelEndpointConfig,
} from "@server/admin/agents";
import { MotionVideoJobInputError } from "./errors";
import {
  getMotionAssetAssessment,
  upsertMotionAssetAssessment,
  type EnqueueMotionVideoJobInput,
  type MotionAssetAssessmentRecord,
} from "./repository";
import type {
  MotionVideoJobPayloadV1,
  PersistedMotionFrame,
  PersistedMotionVideoOptions,
} from "./types";

export interface MotionShotRequest {
  shotId: number;
  prompt?: string;
  lastFrameShotId?: number;
  options?: Record<string, unknown>;
}

export interface MotionShotEligibilityView {
  shotId: number;
  assetId: string | null;
  imageRef: string | null;
  imageHash: string | null;
  mediaKind: "image" | "video" | "unknown";
  width: number | null;
  height: number | null;
  decision: MotionEligibilityDecision;
  faceAssessment: FaceAssessment | null;
  existingVideoUrl: string | null;
  existingVideoClipId: string | null;
}

interface ProjectMotionContext {
  project: typeof projects.$inferSelect;
  selectedScript: typeof scripts.$inferSelect;
  shots: Shot[];
  assetsByShot: Map<number, typeof assets.$inferSelect>;
  clipsByShot: Map<number, typeof videoClips.$inferSelect>;
}

function projectContext(merchantId: string, projectId: string): ProjectMotionContext {
  const db = getDb();
  const project = db.select().from(projects).where(eq(projects.id, projectId)).limit(1).all()[0];
  if (!project || project.merchantId !== merchantId) throw new MotionVideoJobInputError("项目不存在");
  const selectedScript = db.select().from(scripts).where(eq(scripts.projectId, projectId)).all()
    .sort((left, right) => Number(Boolean(right.selected)) - Number(Boolean(left.selected))
      || (right.version ?? 0) - (left.version ?? 0))[0];
  const shots = Array.isArray(selectedScript?.shots) ? selectedScript.shots as Shot[] : [];
  if (!selectedScript || !shots.length) throw new MotionVideoJobInputError("项目没有可用的已选脚本");

  const assetRows = db.select().from(assets).where(eq(assets.projectId, projectId))
    .orderBy(desc(assets.createdAt), desc(sql<number>`${assets}._rowid_`)).all();
  const assetsByShot = new Map<number, typeof assets.$inferSelect>();
  for (const asset of assetRows) {
    if (!assetsByShot.has(asset.shotId) && asset.status === "done" && asset.filePath) {
      assetsByShot.set(asset.shotId, asset);
    }
  }
  const clipRows = db.select().from(videoClips).where(eq(videoClips.projectId, projectId))
    .orderBy(desc(videoClips.createdAt), desc(sql<number>`${videoClips}._rowid_`)).all();
  const clipsByShot = new Map<number, typeof videoClips.$inferSelect>();
  for (const clip of clipRows) {
    const currentAsset = assetsByShot.get(clip.shotId);
    if (
      !clipsByShot.has(clip.shotId)
      && clip.status === "done"
      && clip.filePath
      && currentAsset?.id === clip.assetId
    ) {
      clipsByShot.set(clip.shotId, clip);
    }
  }
  return { project, selectedScript, shots, assetsByShot, clipsByShot };
}

function cachedFace(row: MotionAssetAssessmentRecord | null): FaceAssessment | null {
  if (!row || row.faceStatus === "not_applicable" || !row.faceCheckedImageHash) return null;
  return {
    status: row.faceStatus,
    checkedImageHash: row.faceCheckedImageHash,
    modelRevision: row.faceDetectorRevision,
    source: row.faceSource,
    ...(row.faceConfidencePermille != null ? { confidence: row.faceConfidencePermille / 1000 } : {}),
    ...(row.faceCount != null ? { faceCount: row.faceCount } : {}),
  };
}

function existingVideoDecision(
  _merchantId: string,
  _projectId: string,
  shot: Shot,
  asset: typeof assets.$inferSelect | undefined,
  clip: typeof videoClips.$inferSelect,
): MotionShotEligibilityView {
  // 已成功落库的视频不再进入付费提交，页面轮询无需反复 hash/ffprobe 大视频。
  const videoHash = hashGenerationRequest({ clipId: clip.id, filePath: clip.filePath });
  const decision = assessMotionEligibility({
    shot,
    source: {
      assetId: asset?.id ?? clip.assetId,
      assetType: asset?.type,
      imageRef: clip.filePath,
      imageHash: videoHash,
      mediaKind: "video",
    },
  });
  return {
    shotId: shot.shotId,
    assetId: asset?.id ?? clip.assetId ?? null,
    imageRef: clip.filePath,
    imageHash: videoHash,
    mediaKind: "video",
    width: null,
    height: null,
    decision,
    faceAssessment: null,
    existingVideoUrl: clip.filePath,
    existingVideoClipId: clip.id,
  };
}

async function evaluateShot(
  merchantId: string,
  context: ProjectMotionContext,
  shot: Shot,
  faceDetector: FaceDetector,
): Promise<MotionShotEligibilityView> {
  const asset = context.assetsByShot.get(shot.shotId);
  const clip = context.clipsByShot.get(shot.shotId);
  // 只有与当前最新素材版本精确绑定的 clip 才能复用；分镜换图后旧视频不能遮住新图。
  if (clip?.filePath && asset?.id && clip.assetId === asset.id) {
    return existingVideoDecision(merchantId, context.project.id, shot, asset, clip);
  }
  const persisted = asset ? getMotionAssetAssessment(asset.id) : null;
  const fallbackImageRef = context.project.productImages?.[0] ?? null;
  // GET 也重新计算文件 hash/尺寸；只有 faceAssessment 能在 hash+detector revision 精确一致时复用。
  // 因此同一路径被覆盖后不会沿用旧 clear 判定。
  const result = await evaluateOwnedMotionEligibility({
    merchantId,
    projectId: context.project.id,
    shot,
    asset,
    fallbackImageRef,
    faceDetector,
    cachedFaceAssessment: cachedFace(persisted),
  }).catch((): OwnedMotionEligibilityResult => ({
    // 路径、文件或检测预检异常按单镜 fail closed；不能让一张坏图拖垮整个项目 GET。
    decision: assessMotionEligibility({
      shot,
      source: {
        assetId: asset?.id,
        assetType: asset?.type,
        imageRef: asset?.filePath ?? (shot.visualSource === "product_image" ? fallbackImageRef : null),
        imageHash: null,
        mediaKind: "unknown",
      },
    }),
    inspection: null,
    faceAssessment: null,
  }));
  if (asset?.id && result.inspection && result.decision.binding?.assetId === asset.id) {
    upsertMotionAssetAssessment({
      merchantId,
      projectId: context.project.id,
      assetId: asset.id,
      shotId: shot.shotId,
      result,
    });
  }
  return {
    shotId: shot.shotId,
    assetId: asset?.id ?? null,
    imageRef: result.inspection?.imageRef ?? result.decision.binding?.imageRef ?? null,
    imageHash: result.inspection?.imageHash ?? result.decision.binding?.imageHash ?? null,
    mediaKind: result.inspection?.mediaKind ?? result.decision.binding?.mediaKind ?? "unknown",
    width: result.inspection?.width ?? result.decision.binding?.width ?? null,
    height: result.inspection?.height ?? result.decision.binding?.height ?? null,
    decision: result.decision,
    faceAssessment: result.faceAssessment,
    existingVideoUrl: null,
    existingVideoClipId: null,
  };
}

export async function evaluateProjectMotionShots(
  merchantId: string,
  projectId: string,
  options: { faceDetector?: FaceDetector } = {},
): Promise<MotionShotEligibilityView[]> {
  const context = projectContext(merchantId, projectId);
  const faceDetector = options.faceDetector ?? getDefaultFaceDetector();
  const output: MotionShotEligibilityView[] = [];
  for (const shot of context.shots) output.push(await evaluateShot(merchantId, context, shot, faceDetector));
  return output;
}

function numberInRange(value: unknown, min: number, max: number, fallback: number, integer = false) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) return fallback;
  return integer ? Math.round(value) : value;
}

function videoOptions(value: Record<string, unknown> | undefined): PersistedMotionVideoOptions {
  const width = numberInRange(value?.width, 256, 1920, 1080, true);
  const height = numberInRange(value?.height, 256, 1920, 1920, true);
  if (width * height > 2_073_600) throw new MotionVideoJobInputError("视频分辨率超过 1080p 上限");
  const negativePrompt = typeof value?.negativePrompt === "string" ? value.negativePrompt.trim().slice(0, 2_000) : "";
  return {
    width,
    height,
    duration: numberInRange(value?.duration, 1, 10, 5, true),
    ...(typeof value?.fps === "number" ? { fps: numberInRange(value.fps, 1, 60, 24, true) } : {}),
    ...(typeof value?.motionStrength === "number"
      ? { motionStrength: numberInRange(value.motionStrength, 0, 1, 0.35) }
      : {}),
    ...(typeof value?.guidanceScale === "number"
      ? { guidanceScale: numberInRange(value.guidanceScale, 0, 30, 7) }
      : {}),
    ...(typeof value?.seed === "number" ? { seed: numberInRange(value.seed, 0, Number.MAX_SAFE_INTEGER, 0, true) } : {}),
    ...(negativePrompt ? { negativePrompt } : {}),
  };
}

function defaultMotionPrompt(shot: Shot, useLastFrame: boolean): string {
  const description = shot.description.trim().slice(0, 3_000);
  const camera = shot.camera.trim().slice(0, 1_000);
  return [
    description,
    camera,
    "商品在画面中的大小、位置、比例保持不变；禁止放大、缩小、拉伸或改变商品外观。",
    "只做一种自然、稳定、单向的轻微运动，画面流畅不抖动。",
    useLastFrame ? "自然过渡到结束帧构图，不来回重复动作。" : "保持首帧主体和构图一致。",
  ].filter(Boolean).join("。").slice(0, 6_000);
}

function endpointSnapshot(endpoint: ModelEndpointConfig): ModelEndpointConfig {
  const {
    provider, model, baseUrl, secretRef, visionModel, deploymentRevision,
    revisionEvidenceFile, revisionEvidenceSha256, voice, speed, groupId,
  } = endpoint;
  return {
    provider, model, baseUrl, secretRef,
    ...(visionModel ? { visionModel } : {}),
    ...(deploymentRevision ? { deploymentRevision } : {}),
    ...(revisionEvidenceFile ? { revisionEvidenceFile } : {}),
    ...(revisionEvidenceSha256 ? { revisionEvidenceSha256 } : {}),
    ...(voice ? { voice } : {}),
    ...(speed != null ? { speed } : {}),
    ...(groupId ? { groupId } : {}),
  };
}

function persistedFrame(view: MotionShotEligibilityView, shot: Shot): PersistedMotionFrame {
  if (!view.assetId || !view.imageRef || !view.imageHash || !view.faceAssessment) {
    throw new MotionVideoJobInputError("AI 视频镜头缺少可持久化资格绑定");
  }
  return {
    shot: { shotId: shot.shotId, type: shot.type, visualSource: shot.visualSource },
    assetId: view.assetId,
    imageRef: view.imageRef,
    imageHash: view.imageHash,
    width: view.width,
    height: view.height,
    decision: view.decision,
    faceAssessment: view.faceAssessment,
  };
}

export interface PrepareMotionVideoJobsResult {
  inputs: EnqueueMotionVideoJobInput[];
  shots: MotionShotEligibilityView[];
}

export async function prepareMotionVideoJobs(input: {
  merchantId: string;
  projectId: string;
  operationKey: string;
  requestedShots: readonly MotionShotRequest[];
  /** 仅供服务端测试/替换本地检测实现；路由不接受浏览器 detector。 */
  faceDetector?: FaceDetector;
}): Promise<PrepareMotionVideoJobsResult> {
  if (!input.requestedShots.length || input.requestedShots.length > 9) {
    throw new MotionVideoJobInputError("一次只能处理 1-9 个分镜");
  }
  if (new Set(input.requestedShots.map((item) => item.shotId)).size !== input.requestedShots.length) {
    throw new MotionVideoJobInputError("shotId 不得重复");
  }
  const context = projectContext(input.merchantId, input.projectId);
  const faceDetector = input.faceDetector ?? getDefaultFaceDetector();
  const requestByShot = new Map(input.requestedShots.map((item) => [item.shotId, item]));
  const allowedShots = new Map(context.shots.map((shot) => [shot.shotId, shot]));
  if ([...requestByShot.keys()].some((shotId) => !allowedShots.has(shotId))) {
    throw new MotionVideoJobInputError("请求的分镜不属于当前已选脚本");
  }

  const state = await getAgentStrategy();
  const agent = getAgentOrThrow(state, "videoAgent");
  const endpointRole: AgentEndpointRole = endpointReady(agent.primary) ? "primary" : "fallback";
  const endpoint = endpointRole === "primary" ? agent.primary : agent.fallback;
  if (!endpointReady(endpoint)) throw new MotionVideoJobInputError("视频模型策略暂不可用");

  // 提交路径必须逐图重新 hash/probe/检测；不接受浏览器或仅凭旧 DTO 的资格声明。
  const evaluated = new Map<number, MotionShotEligibilityView>();
  const evaluate = async (shot: Shot) => {
    const cached = evaluated.get(shot.shotId);
    if (cached) return cached;
    const result = await evaluateShot(input.merchantId, context, shot, faceDetector);
    evaluated.set(shot.shotId, result);
    return result;
  };
  for (const requested of input.requestedShots) await evaluate(allowedShots.get(requested.shotId)!);

  const prepared: EnqueueMotionVideoJobInput[] = [];
  for (const requested of input.requestedShots) {
    const shot = allowedShots.get(requested.shotId)!;
    const source = evaluated.get(shot.shotId)!;
    if (source.decision.policy !== "ai_video" || source.decision.state !== "eligible") continue;
    const shotIndex = context.shots.findIndex((item) => item.shotId === shot.shotId);
    const explicitLast = requested.lastFrameShotId != null ? allowedShots.get(requested.lastFrameShotId) : null;
    const candidateLast = explicitLast ?? context.shots[shotIndex + 1] ?? null;
    const last = candidateLast ? await evaluate(candidateLast) : null;
    const pair = decideLastFrame(
      { decision: source.decision, currentBinding: source.decision.binding },
      last ? { decision: last.decision, currentBinding: last.decision.binding } : null,
    );
    const useLast = pair.useLastFrame && last ? last : null;
    const prompt = typeof requested.prompt === "string" && requested.prompt.trim()
      ? requested.prompt.trim().slice(0, 6_000)
      : defaultMotionPrompt(shot, Boolean(useLast));
    const payload: MotionVideoJobPayloadV1 = {
      version: 1,
      selectedScriptId: context.selectedScript.id,
      shot: {
        shotId: shot.shotId,
        type: shot.type,
        visualSource: shot.visualSource,
        duration: shot.duration,
      },
      prompt,
      options: videoOptions(requested.options),
      source: persistedFrame(source, shot),
      lastFrame: useLast && candidateLast ? persistedFrame(useLast, candidateLast) : null,
      endpoint: endpointSnapshot(endpoint),
      endpointRole,
      strategyRevision: state.strategyRevision,
      promptVersion: agent.promptVersion,
    };
    prepared.push({
      merchantId: input.merchantId,
      projectId: input.projectId,
      operationKey: input.operationKey,
      itemKey: `shot:${shot.shotId}`,
      shotId: shot.shotId,
      sourceAssetId: payload.source.assetId,
      payload,
    });
  }
  const views = input.requestedShots.map((item) => evaluated.get(item.shotId)!);
  return { inputs: prepared, shots: views };
}
