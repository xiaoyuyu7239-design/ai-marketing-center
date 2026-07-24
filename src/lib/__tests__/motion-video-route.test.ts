import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  requireMerchant: vi.fn(async () => ({ merchant: { id: "merchant-1" } })),
  requireOwnedProject: vi.fn(async () => ({ project: { id: "project-1" } })),
  consumeRateLimit: vi.fn(() => ({ allowed: true })),
  evaluate: vi.fn(),
  list: vi.fn(),
  prepare: vi.fn(),
  enqueue: vi.fn(),
  toDto: vi.fn((job: unknown) => job),
  get: vi.fn(),
  normalizeOperation: vi.fn((value: string) => value),
}));

vi.mock("@backend/core/auth/require-merchant", () => ({
  requireMerchant: mocks.requireMerchant,
  requireOwnedProject: mocks.requireOwnedProject,
}));

vi.mock("@backend/core/security/rate-limit", () => ({
  consumeExpensiveRouteRateLimit: mocks.consumeRateLimit,
  EXPENSIVE_RATE_LIMIT_PRESETS: { video: { windowMs: 60_000, max: 10 } },
  rateLimitResponse: vi.fn(() => new Response(null, { status: 429 })),
}));

vi.mock("@backend/core/auth/usage", () => {
  class GenerationOperationConflictError extends Error {}
  class InvalidGenerationOperationError extends Error {}
  class QuotaExceededError extends Error {}
  return {
    GenerationOperationConflictError,
    InvalidGenerationOperationError,
    QuotaExceededError,
    safeGenerationErrorMessage: (error: unknown) => error instanceof Error ? error.message : "unknown",
  };
});

vi.mock("@backend/core/video-jobs", () => {
  class MotionVideoJobIdempotencyConflictError extends Error {}
  class MotionVideoJobInputError extends Error {
    code = "MOTION_JOB_INPUT_INVALID";
  }
  class MotionVideoJobQueueLimitError extends Error {
    code = "MOTION_JOB_QUEUE_FULL";
  }
  return {
    MotionVideoJobIdempotencyConflictError,
    MotionVideoJobInputError,
    MotionVideoJobQueueLimitError,
    enqueueMotionVideoJobs: mocks.enqueue,
    evaluateProjectMotionShots: mocks.evaluate,
    getMotionVideoJob: mocks.get,
    listMotionVideoJobs: mocks.list,
    normalizeMotionOperationKey: mocks.normalizeOperation,
    prepareMotionVideoJobs: mocks.prepare,
    toMotionVideoJobDto: mocks.toDto,
  };
});

import { GET as listJobs, POST as createJobs } from "@/app/api/project/[id]/motion-jobs/route";
import { GET as getJob } from "@/app/api/project/[id]/motion-jobs/[jobId]/route";

const shot = {
  shotId: 1,
  assetId: "asset-1",
  imageRef: "/api/files/project-1/shot-1.png",
  imageHash: "a".repeat(64),
  mediaKind: "image",
  width: 1080,
  height: 1920,
  decision: {
    policy: "ai_video",
    state: "eligible",
    reason: "AI_IMAGE_ELIGIBLE",
    binding: null,
  },
  faceAssessment: { status: "clear" },
  existingVideoUrl: null,
  existingVideoClipId: null,
};

const jobDto = {
  id: "job-1",
  projectId: "project-1",
  operationId: "motion-operation-001",
  itemKey: "shot:1",
  shotId: 1,
  status: "pending",
  stage: "queued",
  taskIdCheckpointed: false,
  outputUrl: null,
  error: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireMerchant.mockResolvedValue({ merchant: { id: "merchant-1" } });
  mocks.requireOwnedProject.mockResolvedValue({ project: { id: "project-1" } });
  mocks.consumeRateLimit.mockReturnValue({ allowed: true });
  mocks.evaluate.mockResolvedValue([shot]);
  mocks.list.mockReturnValue([]);
  mocks.prepare.mockResolvedValue({ inputs: [{ frozen: true }], shots: [shot] });
  mocks.enqueue.mockReturnValue([{ job: jobDto, duplicate: false }]);
  mocks.toDto.mockImplementation((job: unknown) => job);
  mocks.get.mockReturnValue(jobDto);
  mocks.normalizeOperation.mockImplementation((value: string) => value);
});

describe("/api/project/[id]/motion-jobs", () => {
  it("GET 返回分镜决策、任务和汇总，并禁止缓存", async () => {
    const response = await listJobs(
      new NextRequest("http://test.local/api/project/project-1/motion-jobs"),
      { params: Promise.resolve({ id: "project-1" }) },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.json()).toMatchObject({
      shots: [{ shotId: 1, latestJob: null, decision: { policy: "ai_video" } }],
      jobs: [],
      summary: { total: 1, aiVideo: 1, active: 0 },
    });
    expect(mocks.evaluate).toHaveBeenCalledWith("merchant-1", "project-1");
  });

  it("旧 asset 的任务不会冒充当前新分镜图的 latestJob", async () => {
    mocks.list.mockReturnValueOnce([{
      ...jobDto,
      sourceAssetId: "asset-old",
      sourceImageHash: "b".repeat(64),
      status: "succeeded",
    }]);
    const response = await listJobs(
      new NextRequest("http://test.local/api/project/project-1/motion-jobs"),
      { params: Promise.resolve({ id: "project-1" }) },
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.shots[0].latestJob).toBeNull();
    expect(body.summary).toMatchObject({ active: 0, succeeded: 0, failed: 0 });
  });

  it("背景 jobs-only 轮询不重算全项目 hash/ffprobe/人脸资格", async () => {
    mocks.list.mockReturnValueOnce([jobDto]);
    const response = await listJobs(
      new NextRequest("http://test.local/api/project/project-1/motion-jobs?view=jobs"),
      { params: Promise.resolve({ id: "project-1" }) },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("retry-after")).toBe("3");
    expect(await response.json()).toEqual({ jobs: [jobDto] });
    expect(mocks.evaluate).not.toHaveBeenCalled();
  });

  it("POST 批量只入队并立即 202，返回稳定轮询 URL", async () => {
    const response = await createJobs(
      new NextRequest("http://test.local/api/project/project-1/motion-jobs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          operationId: "motion-operation-001",
          shotIds: [1],
          items: [{ shotId: 1, prompt: "轻微向左摆动" }],
        }),
      }),
      { params: Promise.resolve({ id: "project-1" }) },
    );
    expect(response.status).toBe(202);
    expect(response.headers.get("location")).toBe("/api/project/project-1/motion-jobs");
    expect(response.headers.get("retry-after")).toBe("3");
    expect(await response.json()).toMatchObject({
      accepted: true,
      operationId: "motion-operation-001",
      jobs: [{ id: "job-1", duplicate: false }],
      pollUrl: "/api/project/project-1/motion-jobs",
      duplicate: false,
    });
    expect(mocks.prepare).toHaveBeenCalledWith({
      merchantId: "merchant-1",
      projectId: "project-1",
      operationKey: "motion-operation-001",
      requestedShots: [{ shotId: 1, prompt: "轻微向左摆动" }],
    });
  });

  it("任务详情不存在时返回隔离后的 404", async () => {
    mocks.get.mockReturnValueOnce(null);
    const response = await getJob(
      new NextRequest("http://test.local/api/project/project-1/motion-jobs/missing"),
      { params: Promise.resolve({ id: "project-1", jobId: "missing" }) },
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "MOTION_JOB_NOT_FOUND" });
    expect(mocks.get).toHaveBeenCalledWith("merchant-1", "project-1", "missing");
  });
});
