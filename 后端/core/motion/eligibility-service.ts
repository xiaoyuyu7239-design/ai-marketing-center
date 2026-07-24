import "server-only";

import type { Shot } from "@backend/db/schema";
import {
  MOTION_FACELESS_RETRY_MARKER,
  assessMotionEligibility,
  type FaceAssessment,
  type MotionAssetType,
  type MotionEligibilityDecision,
} from "./eligibility";
import { assessFaceWithDetector, type FaceDetector } from "./face-detector";
import {
  inspectOwnedMotionSource,
  motionSourceFromInspection,
  type MotionSourceInspection,
} from "./source-inspection";

export interface MotionAssetRecord {
  id?: string | null;
  type?: string | null;
  filePath?: string | null;
  status?: string | null;
  prompt?: string | null;
}

export interface OwnedMotionEligibilityResult {
  decision: MotionEligibilityDecision;
  inspection: MotionSourceInspection | null;
  faceAssessment: FaceAssessment | null;
}

function assetType(value: string | null | undefined): MotionAssetType | null {
  return value === "ai_generated"
    || value === "product_image"
    || value === "user_upload"
    || value === "stock_footage"
    ? value
    : null;
}

/** 只复用当前图片 + 当前检测模型的结果；人工复核用独立 revision 并可持续生效。 */
export function reusableFaceAssessment(
  cached: FaceAssessment | null | undefined,
  imageHash: string,
  detectorRevision: string,
): FaceAssessment | null {
  if (!cached || cached.checkedImageHash.toLowerCase() !== imageHash.toLowerCase()) return null;
  if (cached.source === "manual") return cached;
  return cached.modelRevision === detectorRevision ? cached : null;
}

/**
 * 服务端动态资格编排入口。它不信任浏览器上报的 policy/hash：
 * 从当前 asset/商品图引用解析本地文件，重算 hash + 尺寸，必要时调本地人脸检测，再返回可冻结的判定。
 */
export async function evaluateOwnedMotionEligibility(input: {
  merchantId: string;
  projectId: string;
  shot: Pick<Shot, "type" | "visualSource">;
  asset?: MotionAssetRecord | null;
  /** product_image 尚未落库时允许用项目商品图作静态锚点。 */
  fallbackImageRef?: string | null;
  faceDetector: FaceDetector;
  /** 只能由服务端已持久化记录传入，不得接受客户端自报。 */
  cachedFaceAssessment?: FaceAssessment | null;
}): Promise<OwnedMotionEligibilityResult> {
  const savedReady = !input.asset?.status || input.asset.status === "done";
  const productFallback = input.shot.visualSource === "product_image"
    ? input.fallbackImageRef || null
    : null;
  const imageRef = savedReady && input.asset?.filePath
    ? input.asset.filePath
    : productFallback;
  const facelessRetryAttempted = typeof input.asset?.prompt === "string"
    && input.asset.prompt.includes(MOTION_FACELESS_RETRY_MARKER);

  if (!imageRef) {
    return {
      decision: assessMotionEligibility({
        shot: input.shot,
        source: {
          assetId: input.asset?.id,
          assetType: assetType(input.asset?.type),
          imageRef: null,
        },
        facelessRetryAttempted,
      }),
      inspection: null,
      faceAssessment: null,
    };
  }

  const inspection = await inspectOwnedMotionSource({
    imageRef,
    merchantId: input.merchantId,
    projectId: input.projectId,
  });
  const source = motionSourceFromInspection({
    inspection,
    assetId: input.asset?.id,
    assetType: assetType(input.asset?.type),
  });

  // 非 AI 图分支先用纯规则收口，不做无意义的人脸推理。
  const policyOnly = assessMotionEligibility({
    shot: input.shot,
    source,
    facelessRetryAttempted,
  });
  if (policyOnly.reason !== "FACE_REVIEW_REQUIRED") {
    return { decision: policyOnly, inspection, faceAssessment: null };
  }

  const cached = reusableFaceAssessment(
    input.cachedFaceAssessment,
    inspection.imageHash,
    input.faceDetector.modelRevision,
  );
  const faceAssessment = cached ?? await assessFaceWithDetector(input.faceDetector, {
    imagePath: inspection.localPath,
    imageHash: inspection.imageHash,
    mimeType: inspection.mimeType,
  });
  return {
    decision: assessMotionEligibility({
      shot: input.shot,
      source,
      faceAssessment,
      facelessRetryAttempted,
    }),
    inspection,
    faceAssessment,
  };
}
