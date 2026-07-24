import type { FaceAssessment, FaceBoundingBox } from "./eligibility";

export interface FaceDetectionInput {
  /** 只允许传已通过商家/项目归属校验的本地文件。 */
  imagePath: string;
  imageHash: string;
  mimeType?: string;
}

export interface FaceDetectionOutput {
  status: "clear" | "face_detected" | "review_required";
  /** 可选：检测器返回的最高人脸分数（0-1）。 */
  score?: number;
  /** @deprecated 兼容旧适配器，新实现优先返回 score。 */
  confidence?: number;
  faceCount?: number;
  boxes?: FaceBoundingBox[];
  note?: string;
}

/**
 * 可插拔的本地人脸检测器。实现必须完全在服务端本地运行，不得将商家图片暗中上传第三方。
 */
export interface FaceDetector {
  readonly modelRevision: string;
  readonly available: boolean;
  detect(input: FaceDetectionInput): Promise<FaceDetectionOutput>;
}

/**
 * 当本地没有可靠检测模型时的显式适配器。返回 review_required，不会伪装成“未检测到脸”。
 */
export function createUnavailableFaceDetector(
  note = "本地人脸检测模型未配置",
): FaceDetector {
  return {
    modelRevision: "face-detector-unavailable",
    available: false,
    async detect() {
      return { status: "review_required", note };
    },
  };
}

/**
 * 统一执行入口：检测器抛错也是需复核，永不在异常时 fail open。
 */
export async function assessFaceWithDetector(
  detector: FaceDetector,
  input: FaceDetectionInput,
): Promise<FaceAssessment> {
  try {
    const output = await detector.detect(input);
    const confidence = typeof output.score === "number" ? output.score : output.confidence;
    const boxes = Array.isArray(output.boxes)
      ? output.boxes.filter((box) => [box.x, box.y, box.width, box.height].every(Number.isFinite))
      : undefined;
    return {
      status: output.status,
      checkedImageHash: input.imageHash.toLowerCase(),
      modelRevision: detector.modelRevision,
      source: detector.available ? "detector" : "unavailable",
      ...(typeof confidence === "number" ? { confidence: Math.max(0, Math.min(1, confidence)) } : {}),
      ...(typeof output.faceCount === "number"
        ? { faceCount: Math.max(0, Math.round(output.faceCount)) }
        : boxes ? { faceCount: boxes.length } : {}),
      ...(boxes ? { boxes } : {}),
      ...(output.note ? { note: output.note } : {}),
    };
  } catch {
    return {
      status: "review_required",
      checkedImageHash: input.imageHash.toLowerCase(),
      modelRevision: detector.modelRevision || "face-detector-unavailable",
      source: detector.available ? "detector" : "unavailable",
      note: "人脸检测异常，已安全转入人工复核",
    };
  }
}

export function createManualFaceAssessment(input: {
  imageHash: string;
  approvedForAiVideo: boolean;
  reviewRevision: string;
  note?: string;
}): FaceAssessment {
  return {
    status: input.approvedForAiVideo ? "clear" : "face_detected",
    checkedImageHash: input.imageHash.toLowerCase(),
    modelRevision: `manual:${input.reviewRevision.trim() || "unspecified"}`,
    source: "manual",
    ...(input.note ? { note: input.note } : {}),
  };
}
