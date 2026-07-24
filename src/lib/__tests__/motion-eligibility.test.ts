import { describe, expect, it } from "vitest";
import {
  MOTION_ELIGIBILITY_REVISION,
  MOTION_FACELESS_RETRY_MARKER,
  areAspectRatiosCompatible,
  assessMotionEligibility,
  buildMotionEligibilityBinding,
  canSubmitAiVideo,
  decideLastFrame,
  inferMotionMediaKind,
  motionEligibilityBindingsMatch,
  type FaceAssessment,
  type MotionEligibilityDecision,
  type MotionSource,
} from "@backend/core/motion/eligibility";
import {
  assessFaceWithDetector,
  createManualFaceAssessment,
  createUnavailableFaceDetector,
  type FaceDetector,
} from "@backend/core/motion/face-detector";
import { reusableFaceAssessment } from "@backend/core/motion/eligibility-service";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function aiSource(partial: Partial<MotionSource> = {}): MotionSource {
  return {
    assetId: "asset-1",
    imageRef: "/api/files/project-1/asset-1.jpg",
    imageHash: HASH_A,
    assetType: "ai_generated",
    mediaKind: "image",
    width: 1080,
    height: 1440,
    ...partial,
  };
}

function face(
  status: FaceAssessment["status"] = "clear",
  partial: Partial<FaceAssessment> = {},
): FaceAssessment {
  return {
    status,
    checkedImageHash: HASH_A,
    modelRevision: "ultraface-rfb-320@sha256:abc",
    source: "detector",
    ...partial,
  };
}

const AI_SHOT = { type: "demo" as const, visualSource: "ai_generate" as const };

function eligibleDecision(source = aiSource()): MotionEligibilityDecision {
  return assessMotionEligibility({ shot: AI_SHOT, source, faceAssessment: face("clear", { checkedImageHash: source.imageHash! }) });
}

describe("assessMotionEligibility", () => {
  it("product_reveal + product_image 是静态锚点，不调付费视频模型", () => {
    const decision = assessMotionEligibility({
      shot: { type: "product_reveal", visualSource: "product_image" },
      source: aiSource({ assetId: "product-1", assetType: "product_image" }),
    });
    expect(decision).toMatchObject({
      policy: "static_pan",
      state: "fallback",
      reason: "PRODUCT_REVEAL_STATIC_ANCHOR",
    });
  });

  it("其它 product_image 和 user_upload 也保留原图轻运镜", () => {
    const product = assessMotionEligibility({
      shot: { type: "cta", visualSource: "product_image" },
      source: aiSource({ assetType: "product_image" }),
    });
    const uploaded = assessMotionEligibility({
      shot: { type: "demo", visualSource: "user_upload" },
      source: aiSource({ assetType: "user_upload" }),
    });
    expect(product.reason).toBe("PRODUCT_IMAGE_STATIC");
    expect(uploaded.reason).toBe("USER_UPLOAD_STATIC");
    expect(product.policy).toBe("static_pan");
    expect(uploaded.policy).toBe("static_pan");
  });

  it("stock 图片静态轻运镜，stock/其它已有视频直接复用", () => {
    const stockImage = assessMotionEligibility({
      shot: AI_SHOT,
      source: aiSource({ assetType: "stock_footage" }),
    });
    const stockVideo = assessMotionEligibility({
      shot: AI_SHOT,
      source: aiSource({
        assetType: "stock_footage",
        imageRef: "/api/files/project-1/stock.mp4",
        mediaKind: "video",
      }),
    });
    const generatedVideo = assessMotionEligibility({
      shot: AI_SHOT,
      source: aiSource({ imageRef: "/api/files/project-1/generated.webm", mediaKind: "video" }),
    });
    expect(stockImage).toMatchObject({ policy: "static_pan", reason: "STOCK_IMAGE_STATIC" });
    expect(stockVideo).toMatchObject({ policy: "use_existing_video", reason: "VIDEO_ALREADY_DYNAMIC" });
    expect(generatedVideo).toMatchObject({ policy: "use_existing_video", reason: "VIDEO_ALREADY_DYNAMIC" });
  });

  it("无当前图片的人脸结果时 fail closed 到人工复核 + 静态兜底", () => {
    expect(assessMotionEligibility({ shot: AI_SHOT, source: aiSource() })).toMatchObject({
      policy: "static_pan",
      state: "manual_review",
      reason: "FACE_REVIEW_REQUIRED",
    });
  });

  it("AI 图确认有脸时要求重生无脸版", () => {
    expect(assessMotionEligibility({
      shot: AI_SHOT,
      source: aiSource(),
      faceAssessment: face("face_detected", { confidence: 0.93, faceCount: 1 }),
    })).toMatchObject({
      policy: "regenerate_faceless",
      state: "regenerate_required",
      reason: "FACE_RISK_DETECTED",
    });
  });

  it("当前素材已做过一次无脸重生但仍有脸时永久转静态，不再循环扣图像额度", () => {
    expect(assessMotionEligibility({
      shot: AI_SHOT,
      source: aiSource(),
      faceAssessment: face("face_detected", { confidence: 0.91, faceCount: 1 }),
      facelessRetryAttempted: true,
    })).toMatchObject({
      policy: "static_pan",
      state: "fallback",
      reason: "FACE_RISK_AFTER_REGENERATION",
    });
    expect(MOTION_FACELESS_RETRY_MARKER).toBe("[motion-faceless-retry:v1]");
  });

  it("检测结果的 hash 不是当前图时不可复用", () => {
    expect(assessMotionEligibility({
      shot: AI_SHOT,
      source: aiSource(),
      faceAssessment: face("clear", { checkedImageHash: HASH_B }),
    })).toMatchObject({
      policy: "static_pan",
      state: "manual_review",
      reason: "FACE_ASSESSMENT_STALE",
    });
  });

  it("只有已落库且内容/检测版本绑定完整的无脸 AI 图可转视频", () => {
    const eligible = eligibleDecision();
    const transient = eligibleDecision(aiSource({ assetId: null }));
    expect(eligible).toMatchObject({
      policy: "ai_video",
      state: "eligible",
      reason: "AI_IMAGE_ELIGIBLE",
      binding: {
        assetId: "asset-1",
        imageHash: HASH_A,
        modelRevision: "ultraface-rfb-320@sha256:abc",
        eligibilityRevision: MOTION_ELIGIBILITY_REVISION,
      },
    });
    expect(transient).toMatchObject({
      policy: "static_pan",
      state: "manual_review",
      reason: "SOURCE_BINDING_INCOMPLETE",
    });
  });

  it("缺图或非图像素材直接静态兜底", () => {
    expect(assessMotionEligibility({ shot: AI_SHOT, source: aiSource({ imageRef: null }) }).reason).toBe("MISSING_IMAGE");
    expect(assessMotionEligibility({
      shot: AI_SHOT,
      source: aiSource({ imageRef: "/api/files/project-1/blob.bin", mediaKind: "unknown" }),
    }).reason).toBe("UNSUPPORTED_ASSET");
  });
});

describe("资格绑定", () => {
  it("只有 asset/ref/hash/model/rule/media/dimensions 全部精确相同才复用", () => {
    const current = buildMotionEligibilityBinding(aiSource(), "detector-v1")!;
    expect(motionEligibilityBindingsMatch(current, { ...current })).toBe(true);
    expect(motionEligibilityBindingsMatch(current, { ...current, imageHash: HASH_B })).toBe(false);
    expect(motionEligibilityBindingsMatch(current, { ...current, modelRevision: "detector-v2" })).toBe(false);
    expect(motionEligibilityBindingsMatch(current, { ...current, assetId: "asset-2" })).toBe(false);
    expect(motionEligibilityBindingsMatch(current, { ...current, width: 720 })).toBe(false);
    expect(motionEligibilityBindingsMatch(current, null)).toBe(false);
  });

  it("AI 提交还会在当下重验 binding", () => {
    const decision = eligibleDecision();
    expect(canSubmitAiVideo(decision, decision.binding)).toBe(true);
    expect(canSubmitAiVideo(decision, decision.binding && { ...decision.binding, imageHash: HASH_B })).toBe(false);
    expect(canSubmitAiVideo({ ...decision, policy: "static_pan" }, decision.binding)).toBe(false);
  });
});

describe("首尾帧兼容门禁", () => {
  it("两端都合格且宽高比差在 3% 内才使用尾帧", () => {
    const first = eligibleDecision(aiSource({ width: 1080, height: 1440 }));
    const last = eligibleDecision(aiSource({
      assetId: "asset-2",
      imageRef: "/api/files/project-1/asset-2.jpg",
      imageHash: HASH_B,
      width: 1060,
      height: 1440,
    }));
    expect(decideLastFrame(
      { decision: first, currentBinding: first.binding },
      { decision: last, currentBinding: last.binding },
    )).toEqual({ useLastFrame: true, reason: "COMPATIBLE" });
  });

  it("比例不兼容时只送首帧", () => {
    const first = eligibleDecision(aiSource({ width: 1080, height: 1440 }));
    const last = eligibleDecision(aiSource({
      assetId: "asset-2",
      imageRef: "/api/files/project-1/asset-2.jpg",
      imageHash: HASH_B,
      width: 1920,
      height: 1080,
    }));
    expect(decideLastFrame(
      { decision: first, currentBinding: first.binding },
      { decision: last, currentBinding: last.binding },
    )).toEqual({ useLastFrame: false, reason: "ASPECT_RATIO_MISMATCH" });
  });

  it("任一端非当前 eligible，或缺尺寸，均不送尾帧", () => {
    const first = eligibleDecision();
    const staticLast = assessMotionEligibility({
      shot: { type: "product_reveal", visualSource: "product_image" },
      source: aiSource({ assetType: "product_image" }),
    });
    expect(decideLastFrame(
      { decision: first, currentBinding: first.binding },
      { decision: staticLast, currentBinding: staticLast.binding },
    ).reason).toBe("LAST_NOT_ELIGIBLE");

    const noSize = eligibleDecision(aiSource({ width: null, height: null }));
    expect(decideLastFrame(
      { decision: first, currentBinding: first.binding },
      { decision: noSize, currentBinding: noSize.binding },
    ).reason).toBe("MISSING_DIMENSIONS");

    expect(decideLastFrame(
      { decision: first, currentBinding: first.binding && { ...first.binding, imageHash: HASH_B } },
      null,
    ).reason).toBe("FIRST_NOT_ELIGIBLE");
  });

  it("比例判定不接受缺失尺寸或非法容差", () => {
    expect(areAspectRatiosCompatible({ width: 1080, height: 1440 }, { width: 750, height: 1000 })).toBe(true);
    expect(areAspectRatiosCompatible({ width: null, height: 1440 }, { width: 750, height: 1000 })).toBe(false);
    expect(areAspectRatiosCompatible({ width: 1080, height: 1440 }, { width: 750, height: 1000 }, -1)).toBe(false);
  });
});

describe("FaceDetector 适配层", () => {
  it("无本地模型时明确返回 review_required，不伪装 clear", async () => {
    const assessment = await assessFaceWithDetector(createUnavailableFaceDetector(), {
      imagePath: "/tmp/image.jpg",
      imageHash: HASH_A,
    });
    expect(assessment).toMatchObject({
      status: "review_required",
      source: "unavailable",
      checkedImageHash: HASH_A,
      modelRevision: "face-detector-unavailable",
    });
  });

  it("真实检测器的 score/boxes 被标准化，异常则 fail closed", async () => {
    const detector: FaceDetector = {
      available: true,
      modelRevision: "ultraface-v1",
      async detect() {
        return {
          status: "face_detected",
          score: 1.5,
          boxes: [{ x: 10, y: 20, width: 30, height: 40, score: 0.98 }],
        };
      },
    };
    const assessment = await assessFaceWithDetector(detector, { imagePath: "/tmp/image.jpg", imageHash: HASH_A });
    expect(assessment).toMatchObject({ status: "face_detected", confidence: 1, faceCount: 1 });
    expect(assessment.boxes).toHaveLength(1);

    const broken: FaceDetector = { ...detector, async detect() { throw new Error("boom"); } };
    await expect(assessFaceWithDetector(broken, {
      imagePath: "/tmp/image.jpg",
      imageHash: HASH_A,
    })).resolves.toMatchObject({ status: "review_required", source: "detector" });
  });

  it("人工复核同样绑定图片 hash 和审核版本", () => {
    expect(createManualFaceAssessment({
      imageHash: HASH_A,
      approvedForAiVideo: true,
      reviewRevision: "review-20260717",
    })).toMatchObject({
      status: "clear",
      checkedImageHash: HASH_A,
      modelRevision: "manual:review-20260717",
      source: "manual",
    });
  });

  it("缓存检测只在 hash + detector revision 均未变时复用", () => {
    const cached = face("clear");
    expect(reusableFaceAssessment(cached, HASH_A, cached.modelRevision)).toBe(cached);
    expect(reusableFaceAssessment(cached, HASH_B, cached.modelRevision)).toBeNull();
    expect(reusableFaceAssessment(cached, HASH_A, "ultraface-v2")).toBeNull();

    const manual = createManualFaceAssessment({
      imageHash: HASH_A,
      approvedForAiVideo: true,
      reviewRevision: "review-1",
    });
    expect(reusableFaceAssessment(manual, HASH_A, "ultraface-v999")).toBe(manual);
  });
});

describe("inferMotionMediaKind", () => {
  it("识别常见图像/视频引用并忽略 query", () => {
    expect(inferMotionMediaKind("/api/files/p/a.JPG?token=1")).toBe("image");
    expect(inferMotionMediaKind("/api/files/p/a.mp4#t=0")).toBe("video");
    expect(inferMotionMediaKind("data:image/png;base64,abc")).toBe("image");
    expect(inferMotionMediaKind("/api/files/p/a.bin")).toBe("unknown");
  });
});
