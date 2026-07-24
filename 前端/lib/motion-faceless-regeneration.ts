"use client";

import type { AssetItem } from "@backend/core/stock/assets-view";
import { MOTION_FACELESS_RETRY_MARKER } from "@backend/core/motion/eligibility";
import { newGenerationOperationId } from "./generation-operation";

export { MOTION_FACELESS_RETRY_MARKER };

export interface FacelessRegenerationResult {
  id: string;
  filePath: string;
  type: string;
  prompt: string;
}

type FetchLike = typeof fetch;

export function hasFacelessRetryMarker(asset: Pick<AssetItem, "assetPrompt">): boolean {
  return Boolean(asset.assetPrompt?.includes(MOTION_FACELESS_RETRY_MARKER));
}

export interface MotionSafetyFailureState {
  assessment?: {
    assetId?: string | null;
    imageHash?: string | null;
  } | null;
  latestJob?: {
    status?: string;
    sourceAssetId?: string | null;
    sourceImageHash?: string | null;
    error?: { suggestedAction?: string | null } | null;
  } | null;
}

/** 仅当供应商拒绝与当前 assetId + hash 精确绑定时，才允许触发一次无脸恢复。 */
export function isCurrentProviderSafetyFailure(
  asset: Pick<AssetItem, "assetId">,
  state: MotionSafetyFailureState | undefined,
): boolean {
  const job = state?.latestJob;
  const assessment = state?.assessment;
  if (job?.status !== "failed" || job.error?.suggestedAction !== "regenerate_faceless") return false;
  if (assessment?.assetId && job.sourceAssetId !== assessment.assetId) return false;
  if (assessment?.imageHash && job.sourceImageHash !== assessment.imageHash) return false;
  return !asset.assetId || !job.sourceAssetId || asset.assetId === job.sourceAssetId;
}

/** 已带一次重生标记的当前图再被供应商拒绝，必须收口为静态轻运镜。 */
export function shouldFallbackAfterProviderSafetyRetry(
  asset: Pick<AssetItem, "assetId" | "assetPrompt">,
  state: MotionSafetyFailureState | undefined,
): boolean {
  return hasFacelessRetryMarker(asset) && isCurrentProviderSafetyFailure(asset, state);
}

/**
 * 重生提示词刻意要求“裁掉头部”而不是只写 no face：对服饰模特图，
 * 这比让模型自行遮脸更稳定，也能最大限度保留商品、服装和镜头构图。
 */
export function buildFacelessRegenerationPrompt(
  asset: Pick<AssetItem, "description" | "prompt">,
): string {
  const scene = (asset.prompt || asset.description || "商品展示画面").trim();
  return [
    MOTION_FACELESS_RETRY_MARKER,
    "【视频安全重构，最高优先级】重画为完全不含可辨识人脸的版本。画面必须从头部以下裁切，或只出现背影、手部、腰部、腿部和商品局部；不得出现完整头部、眼睛、鼻子、嘴巴、正脸或清晰侧脸，也不要用模糊脸、变形脸、面具脸代替。",
    "严格保持参考图中商品的款式、颜色、材质、Logo、比例和主体位置一致；只改变人物裁切与构图，不得放大、缩小、拉伸或改造商品。",
    "真实摄影，物体有可信支撑，不悬浮；背景、光线和商业质感延续原图。",
    `镜头意图：${scene}`,
    "Strictly no visible or recognizable face, no full head, no eyes, nose or mouth; use a neck-down crop, back view, hands, waist, legs, or product detail only. Preserve the exact product identity and scale.",
  ].join(" ").slice(0, 6_000);
}

function errorMessage(value: unknown, fallback: string): string {
  if (!value || typeof value !== "object") return fallback;
  const record = value as Record<string, unknown>;
  if (typeof record.error === "string" && record.error.trim()) return record.error;
  if (record.error && typeof record.error === "object") {
    const detail = record.error as Record<string, unknown>;
    if (typeof detail.userMessage === "string" && detail.userMessage.trim()) return detail.userMessage;
    if (typeof detail.message === "string" && detail.message.trim()) return detail.message;
  }
  return fallback;
}

/**
 * 执行一次“生图 → 本地落库”的原子用户流程。调用者必须先检查持久标记，
 * 本函数也做二次保护；失败时不会把供应商短效 URL 当成已完成素材。
 */
export async function regenerateFacelessAsset(input: {
  projectId: string;
  asset: AssetItem;
  imageOptions: Record<string, unknown>;
  fetchImpl?: FetchLike;
}): Promise<FacelessRegenerationResult> {
  if (hasFacelessRetryMarker(input.asset)) {
    throw new Error("该分镜已经执行过一次无脸安全重生，将保留静态轻运镜");
  }
  const referenceImageUrl = input.asset.assetFileUrl || input.asset.thumbnailUrl;
  if (!referenceImageUrl) throw new Error("当前分镜没有可用于安全重生的已落库图片");
  const request = input.fetchImpl ?? fetch;
  const prompt = buildFacelessRegenerationPrompt(input.asset);
  const operationId = newGenerationOperationId("image-single");
  const generatedResponse = await request("/api/ai/image", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      projectId: input.projectId,
      mode: "image-to-image",
      prompt,
      imageUrl: referenceImageUrl,
      options: input.imageOptions,
      operationId,
      operationType: "image-single",
      itemKey: `shot:${input.asset.shotId}`,
    }),
  });
  const generated = await generatedResponse.json().catch(() => ({})) as Record<string, unknown>;
  if (!generatedResponse.ok) {
    throw new Error(errorMessage(generated, "无脸安全重生失败，请稍后重试"));
  }
  const sourceUrl = Array.isArray(generated.imageUrls)
    ? generated.imageUrls.find((url): url is string => typeof url === "string" && Boolean(url))
    : undefined;
  if (!sourceUrl) throw new Error("无脸安全重生没有返回图片");

  const savedResponse = await request(`/api/project/${input.projectId}/assets`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      shotId: input.asset.shotId,
      type: "ai_generate",
      sourceUrl,
      prompt,
    }),
  });
  const saved = await savedResponse.json().catch(() => ({})) as Record<string, unknown>;
  if (
    !savedResponse.ok
    || typeof saved.id !== "string"
    || typeof saved.filePath !== "string"
    || !saved.filePath
  ) {
    throw new Error(errorMessage(saved, "无脸图片已生成，但保存到项目失败，请重试"));
  }
  return {
    id: saved.id,
    filePath: saved.filePath,
    type: typeof saved.type === "string" ? saved.type : "ai_generated",
    prompt: typeof saved.prompt === "string" ? saved.prompt : prompt,
  };
}
