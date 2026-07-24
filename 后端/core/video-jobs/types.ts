import type { MotionEligibilityDecision, FaceAssessment } from "@backend/core/motion/eligibility";
import type { Shot } from "@backend/db/schema";
import type { ModelEndpointConfig, AgentEndpointRole } from "@server/admin/agents";

export type MotionVideoJobStatus =
  | "pending"
  | "submitting"
  | "submitted"
  | "polling"
  | "downloading"
  | "saving"
  | "succeeded"
  | "failed"
  | "submission_uncertain";

export interface PersistedMotionVideoOptions {
  width: number;
  height: number;
  duration: number;
  fps?: number;
  motionStrength?: number;
  guidanceScale?: number;
  seed?: number;
  negativePrompt?: string;
}

export interface PersistedMotionFrame {
  shot: {
    shotId: number;
    type: Shot["type"];
    visualSource: Shot["visualSource"];
  };
  assetId: string;
  imageRef: string;
  imageHash: string;
  width: number | null;
  height: number | null;
  decision: MotionEligibilityDecision;
  faceAssessment: FaceAssessment;
}

/**
 * 可持久化的安全业务快照。endpoint 只含公开配置与受控 secretRef，绝不含解析后的 API Key。
 */
export interface MotionVideoJobPayloadV1 extends Record<string, unknown> {
  version: 1;
  selectedScriptId: string;
  shot: {
    shotId: number;
    type: Shot["type"];
    visualSource: Shot["visualSource"];
    duration: number;
  };
  prompt: string;
  options: PersistedMotionVideoOptions;
  source: PersistedMotionFrame;
  lastFrame: PersistedMotionFrame | null;
  endpoint: ModelEndpointConfig;
  endpointRole: AgentEndpointRole;
  strategyRevision: number;
  promptVersion: string;
}

export interface MotionVideoJobErrorDto {
  code: string;
  category: string;
  message: string;
  retryable: boolean;
  retryAfterSeconds?: number;
  requestId?: string;
  suggestedAction?: string;
}

export interface MotionVideoJobDto {
  id: string;
  projectId: string;
  operationId: string;
  itemKey: string;
  shotId: number;
  sourceAssetId: string | null;
  status: MotionVideoJobStatus;
  stage: "queued" | "submitted" | "processing" | "downloading" | "saving" | "completed" | "failed";
  progress: number | null;
  policy: MotionEligibilityDecision["policy"];
  eligibilityState: MotionEligibilityDecision["state"];
  eligibilityReason: MotionEligibilityDecision["reason"];
  sourceImageHash: string;
  sourceModelRevision: string;
  eligibilityRevision: string;
  faceStatus: FaceAssessment["status"];
  faceDetectorRevision: string;
  provider: string;
  model: string;
  taskIdCheckpointed: boolean;
  outputUrl: string | null;
  error: MotionVideoJobErrorDto | null;
  pollAttempts: number;
  maxPollAttempts: number;
  createdAt: string;
  startedAt: string | null;
  submittedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
}

export interface MotionAssetAssessmentDto {
  assetId: string;
  shotId: number;
  imageRef: string;
  imageHash: string;
  mediaKind: "image" | "video" | "unknown";
  width: number | null;
  height: number | null;
  policy: MotionEligibilityDecision["policy"];
  state: MotionEligibilityDecision["state"];
  reason: MotionEligibilityDecision["reason"];
  eligibilityRevision: string;
  sourceModelRevision: string;
  faceStatus: FaceAssessment["status"];
  faceDetectorRevision: string;
  faceSource: FaceAssessment["source"];
  faceConfidence: number | null;
  faceCount: number | null;
  updatedAt: string;
}
