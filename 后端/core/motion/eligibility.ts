import type { Shot } from "@backend/db/schema";

/**
 * 动态资格策略版本。任何规则调整都必须升版，让旧判定自动失效。
 */
export const MOTION_ELIGIBILITY_REVISION = "motion-eligibility-v2";

/**
 * 无脸安全重生只允许自动执行一次。标记随新素材版本的 prompt 落库，
 * 因而刷新页面、重启服务后仍能阻止重复生图和重复扣额度。
 */
export const MOTION_FACELESS_RETRY_MARKER = "[motion-faceless-retry:v1]";

/** 纯规则分支不需要人脸模型，但仍用稳定 revision 参与绑定。 */
export const POLICY_ONLY_MODEL_REVISION = "motion-policy-only-v1";

export type MotionPolicy =
  | "ai_video"
  | "static_pan"
  | "regenerate_faceless"
  | "use_existing_video";

export type MotionEligibilityState =
  | "eligible"
  | "fallback"
  | "regenerate_required"
  | "manual_review";

/**
 * 稳定机器原因码：存库/统计/前端展示都依赖这些值，不要用中文错误文案代替。
 */
export type MotionEligibilityReason =
  | "AI_IMAGE_ELIGIBLE"
  | "PRODUCT_REVEAL_STATIC_ANCHOR"
  | "PRODUCT_IMAGE_STATIC"
  | "USER_UPLOAD_STATIC"
  | "STOCK_IMAGE_STATIC"
  | "VIDEO_ALREADY_DYNAMIC"
  | "FACE_RISK_DETECTED"
  | "FACE_RISK_AFTER_REGENERATION"
  | "FACE_REVIEW_REQUIRED"
  | "FACE_ASSESSMENT_STALE"
  | "SOURCE_BINDING_INCOMPLETE"
  | "MISSING_IMAGE"
  | "UNSUPPORTED_ASSET";

export type MotionAssetType =
  | "ai_generated"
  | "product_image"
  | "user_upload"
  | "stock_footage";

export type MotionMediaKind = "image" | "video" | "unknown";

export type FaceAssessmentStatus =
  | "clear"
  | "face_detected"
  | "review_required"
  | "not_applicable";

export interface FaceBoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
  score?: number;
}

export interface FaceAssessment {
  status: FaceAssessmentStatus;
  /** 必须是检查时真实图片内容的 SHA-256。 */
  checkedImageHash: string;
  /** 人脸检测器、人工审核规则或 unavailable 适配器的不可变版本。 */
  modelRevision: string;
  source: "detector" | "manual" | "unavailable";
  confidence?: number;
  faceCount?: number;
  boxes?: FaceBoundingBox[];
  note?: string;
}

export interface MotionSource {
  assetId?: string | null;
  imageRef?: string | null;
  imageHash?: string | null;
  assetType?: MotionAssetType | null;
  mediaKind?: MotionMediaKind | null;
  width?: number | null;
  height?: number | null;
}

/**
 * 判定与具体素材的完整绑定。只要换图、换素材行或换检测模型，旧判定就不能复用。
 */
export interface MotionEligibilityBinding {
  assetId: string | null;
  imageRef: string;
  imageHash: string;
  modelRevision: string;
  eligibilityRevision: typeof MOTION_ELIGIBILITY_REVISION;
  mediaKind: MotionMediaKind;
  width: number | null;
  height: number | null;
}

export interface MotionEligibilityDecision {
  policy: MotionPolicy;
  state: MotionEligibilityState;
  reason: MotionEligibilityReason;
  binding: MotionEligibilityBinding | null;
}

export interface AssessMotionEligibilityInput {
  shot: Pick<Shot, "type" | "visualSource">;
  source: MotionSource;
  faceAssessment?: FaceAssessment | null;
  /** 只能由服务端根据当前素材版本的持久化 prompt 标记推导。 */
  facelessRetryAttempted?: boolean;
}

const IMAGE_EXT = /\.(?:avif|bmp|gif|heic|heif|jpe?g|png|tiff?|webp)$/i;
const VIDEO_EXT = /\.(?:m4v|mov|mp4|webm)$/i;
const SHA256 = /^[a-f0-9]{64}$/i;

function clean(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

function positiveDimension(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : null;
}

/** 仅作轻量分类；服务端最终仍应用 ffprobe/文件 magic 检查真实媒体类型。 */
export function inferMotionMediaKind(ref: string | null | undefined): MotionMediaKind {
  const value = clean(ref);
  if (!value) return "unknown";
  if (/^data:image\//i.test(value)) return "image";
  if (/^data:video\//i.test(value)) return "video";
  const pathname = value.split(/[?#]/, 1)[0];
  if (VIDEO_EXT.test(pathname)) return "video";
  if (IMAGE_EXT.test(pathname)) return "image";
  return "unknown";
}

export function buildMotionEligibilityBinding(
  source: MotionSource,
  modelRevision: string,
): MotionEligibilityBinding | null {
  const imageRef = clean(source.imageRef);
  const imageHash = clean(source.imageHash).toLowerCase();
  const revision = clean(modelRevision);
  if (!imageRef || !SHA256.test(imageHash) || !revision) return null;
  return {
    assetId: clean(source.assetId) || null,
    imageRef,
    imageHash,
    modelRevision: revision,
    eligibilityRevision: MOTION_ELIGIBILITY_REVISION,
    mediaKind: source.mediaKind || inferMotionMediaKind(imageRef),
    width: positiveDimension(source.width),
    height: positiveDimension(source.height),
  };
}

function fallback(
  reason: MotionEligibilityReason,
  source: MotionSource,
  policy: MotionPolicy = "static_pan",
  state: MotionEligibilityState = "fallback",
  modelRevision = POLICY_ONLY_MODEL_REVISION,
): MotionEligibilityDecision {
  return {
    policy,
    state,
    reason,
    binding: buildMotionEligibilityBinding(source, modelRevision),
  };
}

/**
 * 动态资格总门禁。
 *
 * 安全原则：
 * - 商品原图和用户上传图不自动篡改，只用本地轻运镜；
 * - 免费素材图不花视频额度，已有视频直接复用；
 * - 只有“完整绑定 + 当前图片检查明确无脸”的 AI 图可提交付费视频模型；
 * - 检测器缺失/异常/结果过期一律 fail closed，留静态轻运镜并等待人工复核。
 */
export function assessMotionEligibility(
  input: AssessMotionEligibilityInput,
): MotionEligibilityDecision {
  const { shot, source } = input;
  const imageRef = clean(source.imageRef);
  if (!imageRef) return fallback("MISSING_IMAGE", source);

  const mediaKind = source.mediaKind || inferMotionMediaKind(imageRef);
  const normalizedSource: MotionSource = { ...source, mediaKind };

  if (mediaKind === "video") {
    return fallback("VIDEO_ALREADY_DYNAMIC", normalizedSource, "use_existing_video");
  }
  if (mediaKind !== "image") {
    return fallback("UNSUPPORTED_ASSET", normalizedSource);
  }

  if (source.assetType === "stock_footage") {
    return fallback("STOCK_IMAGE_STATIC", normalizedSource);
  }

  if (shot.type === "product_reveal" && shot.visualSource === "product_image") {
    return fallback("PRODUCT_REVEAL_STATIC_ANCHOR", normalizedSource);
  }
  if (source.assetType === "product_image" || shot.visualSource === "product_image") {
    return fallback("PRODUCT_IMAGE_STATIC", normalizedSource);
  }
  if (source.assetType === "user_upload" || shot.visualSource === "user_upload") {
    return fallback("USER_UPLOAD_STATIC", normalizedSource);
  }

  const assessment = input.faceAssessment;
  if (!assessment) {
    return fallback(
      "FACE_REVIEW_REQUIRED",
      normalizedSource,
      "static_pan",
      "manual_review",
      "face-detector-unavailable",
    );
  }

  const assessmentRevision = clean(assessment.modelRevision) || "face-detector-unavailable";
  const imageHash = clean(normalizedSource.imageHash).toLowerCase();
  if (!SHA256.test(imageHash) || clean(assessment.checkedImageHash).toLowerCase() !== imageHash) {
    return fallback(
      "FACE_ASSESSMENT_STALE",
      normalizedSource,
      "static_pan",
      "manual_review",
      assessmentRevision,
    );
  }

  if (assessment.status === "face_detected") {
    if (input.facelessRetryAttempted) {
      return fallback(
        "FACE_RISK_AFTER_REGENERATION",
        normalizedSource,
        "static_pan",
        "fallback",
        assessmentRevision,
      );
    }
    return fallback(
      "FACE_RISK_DETECTED",
      normalizedSource,
      "regenerate_faceless",
      "regenerate_required",
      assessmentRevision,
    );
  }

  if (assessment.status !== "clear") {
    return fallback(
      "FACE_REVIEW_REQUIRED",
      normalizedSource,
      "static_pan",
      "manual_review",
      assessmentRevision,
    );
  }

  const binding = buildMotionEligibilityBinding(normalizedSource, assessmentRevision);
  // AI 分镜必须先真正落库，不允许将短效外链/前端临时状态直接送付费模型。
  if (!binding?.assetId) {
    return {
      policy: "static_pan",
      state: "manual_review",
      reason: "SOURCE_BINDING_INCOMPLETE",
      binding,
    };
  }

  return {
    policy: "ai_video",
    state: "eligible",
    reason: "AI_IMAGE_ELIGIBLE",
    binding,
  };
}

/** 缓存判定只能复用于完全相同的素材、内容 hash、模型和规则版本。 */
export function motionEligibilityBindingsMatch(
  left: MotionEligibilityBinding | null | undefined,
  right: MotionEligibilityBinding | null | undefined,
): boolean {
  if (!left || !right) return false;
  return left.assetId === right.assetId
    && left.imageRef === right.imageRef
    && left.imageHash.toLowerCase() === right.imageHash.toLowerCase()
    && left.modelRevision === right.modelRevision
    && left.eligibilityRevision === right.eligibilityRevision
    && left.mediaKind === right.mediaKind
    && left.width === right.width
    && left.height === right.height;
}

export function canSubmitAiVideo(
  decision: MotionEligibilityDecision,
  currentBinding: MotionEligibilityBinding | null | undefined,
): boolean {
  return decision.policy === "ai_video"
    && decision.state === "eligible"
    && Boolean(decision.binding?.assetId)
    && motionEligibilityBindingsMatch(decision.binding, currentBinding);
}

export function areAspectRatiosCompatible(
  first: Pick<MotionEligibilityBinding, "width" | "height">,
  last: Pick<MotionEligibilityBinding, "width" | "height">,
  tolerance = 0.03,
): boolean {
  const firstWidth = positiveDimension(first.width);
  const firstHeight = positiveDimension(first.height);
  const lastWidth = positiveDimension(last.width);
  const lastHeight = positiveDimension(last.height);
  if (!firstWidth || !firstHeight || !lastWidth || !lastHeight) return false;
  if (!Number.isFinite(tolerance) || tolerance < 0) return false;
  const firstRatio = firstWidth / firstHeight;
  const lastRatio = lastWidth / lastHeight;
  return Math.abs(firstRatio - lastRatio) / Math.max(firstRatio, lastRatio) <= tolerance;
}

export type FramePairReason =
  | "COMPATIBLE"
  | "FIRST_NOT_ELIGIBLE"
  | "LAST_NOT_ELIGIBLE"
  | "MISSING_DIMENSIONS"
  | "ASPECT_RATIO_MISMATCH";

export interface EligibleFrameCandidate {
  decision: MotionEligibilityDecision;
  /** 提交当下从文件重新计算出的绑定，不能直接复用 decision.binding 充数。 */
  currentBinding: MotionEligibilityBinding | null;
}

export interface FramePairDecision {
  useLastFrame: boolean;
  reason: FramePairReason;
}

/** 首尾帧只在两张图都当前合格且宽高比兼容时开启。 */
export function decideLastFrame(
  first: EligibleFrameCandidate,
  last: EligibleFrameCandidate | null | undefined,
  tolerance = 0.03,
): FramePairDecision {
  if (!canSubmitAiVideo(first.decision, first.currentBinding)) {
    return { useLastFrame: false, reason: "FIRST_NOT_ELIGIBLE" };
  }
  if (!last || !canSubmitAiVideo(last.decision, last.currentBinding)) {
    return { useLastFrame: false, reason: "LAST_NOT_ELIGIBLE" };
  }
  const firstBinding = first.currentBinding;
  const lastBinding = last.currentBinding;
  if (
    !firstBinding?.width
    || !firstBinding.height
    || !lastBinding?.width
    || !lastBinding.height
  ) {
    return { useLastFrame: false, reason: "MISSING_DIMENSIONS" };
  }
  if (!areAspectRatiosCompatible(firstBinding, lastBinding, tolerance)) {
    return { useLastFrame: false, reason: "ASPECT_RATIO_MISMATCH" };
  }
  return { useLastFrame: true, reason: "COMPATIBLE" };
}
