import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@server/admin/evals/media-jobs/processor", () => ({
  executePersistedGoldenTtsEvalJob: vi.fn(),
  submitPersistedGoldenMediaEvalJob: vi.fn(),
  pollPersistedGoldenMediaEvalJob: vi.fn(),
  reconcilePersistedGoldenTtsEvalJob: vi.fn(),
}));

vi.mock("@server/admin/evals/media-jobs/repository", () => ({
    GOLDEN_MEDIA_JOB_HEARTBEAT_MS: 30_000,
    GoldenMediaJobRetryableError: class GoldenMediaJobRetryableError extends Error {
      readonly code = "GOLDEN_MEDIA_JOB_RETRYABLE";
    },
    checkpointGoldenMediaRemoteTask: vi.fn(),
    claimNextGoldenMediaEvalJob: vi.fn(),
    completeGoldenMediaEvalJob: vi.fn(),
    completeGoldenTtsEvalJob: vi.fn(),
    failGoldenMediaEvalJob: vi.fn(),
    heartbeatGoldenMediaEvalJob: vi.fn(),
    recoverExpiredGoldenMediaEvalJobs: vi.fn(),
    releaseGoldenMediaAfterSubmission: vi.fn(),
    rescheduleGoldenMediaPoll: vi.fn(),
    sanitizeGoldenMediaJobError: (error: unknown) => error instanceof Error ? error.message : String(error),
}));

import {
  GoldenMediaEvalJobWorker,
  type GoldenMediaEvalWorkerDependencies,
} from "@server/admin/evals/media-jobs/worker";
import type { GoldenMediaEvalJobRecord } from "@server/admin/evals/media-jobs/repository";
import { GoldenMediaSubmissionUncertainError } from "@server/admin/evals/media-jobs/provider-adapter";

function job(overrides: Partial<GoldenMediaEvalJobRecord> = {}): GoldenMediaEvalJobRecord {
  const now = new Date();
  return {
    id: "eval_worker_001",
    idempotencyKey: "golden-worker-key",
    requestHash: "a".repeat(64),
    agentId: "videoAgent",
    caseId: "video.product-orbit.v1",
    candidateRole: "primary",
    candidateKey: "candidate-key",
    provider: "atlas-cloud",
    model: "model",
    promptVersion: "v1",
    strategyRevision: 1,
    requestKind: "video-generation",
    payloadVersion: 1,
    payload: {},
    status: "submitting",
    remoteTaskId: null,
    result: null,
    artifactUrls: [],
    pollAttempts: 0,
    maxPollAttempts: 240,
    availableAt: now,
    leaseOwner: "test-worker",
    leaseToken: "lease-token",
    leaseExpiresAt: new Date(now.getTime() + 90_000),
    heartbeatAt: now,
    errorCode: null,
    errorMessage: null,
    startedAt: now,
    submittedAt: null,
    finishedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function dependencies(
  claimed: GoldenMediaEvalJobRecord,
  overrides: Partial<GoldenMediaEvalWorkerDependencies> = {},
): GoldenMediaEvalWorkerDependencies {
  return {
    recover: vi.fn(() => ({ resumed: [], uncertain: [], timedOut: [] })),
    reconcileTts: vi.fn(async () => false),
    claim: vi.fn(() => claimed),
    heartbeat: vi.fn(() => true),
    submit: vi.fn(async () => "remote-task-001"),
    executeTts: vi.fn(async () => ({
      state: "completed" as const,
      result: { evalId: claimed.id, actualCostUsd: null },
      artifactUrls: [`/api/admin/model-evals/artifacts/${claimed.id}/artifact.mp3`],
    })),
    checkpoint: vi.fn((): GoldenMediaEvalJobRecord => ({
      ...claimed,
      status: "polling",
      remoteTaskId: "remote-task-001",
    })),
    releaseAfterSubmission: vi.fn(() => true),
    poll: vi.fn(async () => ({ state: "pending" as const })),
    reschedule: vi.fn(() => true),
    complete: vi.fn((): GoldenMediaEvalJobRecord => ({ ...claimed, status: "succeeded" })),
    completeTts: vi.fn((): GoldenMediaEvalJobRecord => ({ ...claimed, status: "succeeded" })),
    fail: vi.fn(() => true),
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Golden 媒体评测持久 worker", () => {
  it("优先收敛已落盘的 TTS uncertain 记录，该路径不会触发任何供应商调用", async () => {
    const claimed = job();
    const deps = dependencies(claimed, {
      reconcileTts: vi.fn(async () => true),
    });
    const worker = new GoldenMediaEvalJobWorker(deps, "test-worker");

    await worker.runOnce();
    expect(deps.reconcileTts).toHaveBeenCalledTimes(1);
    expect(deps.claim).not.toHaveBeenCalled();
    expect(deps.submit).not.toHaveBeenCalled();
    expect(deps.executeTts).not.toHaveBeenCalled();
  });

  it("无 taskId 的 submitting 任务只提交一次，随即 checkpoint 并释放为轮询任务", async () => {
    const claimed = job();
    const deps = dependencies(claimed);
    const worker = new GoldenMediaEvalJobWorker(deps, "test-worker");

    await expect(worker.runOnce()).resolves.toBe(true);
    expect(deps.submit).toHaveBeenCalledTimes(1);
    expect(deps.submit).toHaveBeenCalledWith(claimed);
    expect(deps.checkpoint).toHaveBeenCalledWith(
      claimed.id,
      "test-worker",
      "lease-token",
      "remote-task-001",
    );
    expect(deps.releaseAfterSubmission).toHaveBeenCalledWith(claimed.id, "test-worker", "lease-token");
    expect(deps.poll).not.toHaveBeenCalled();
    expect(deps.complete).not.toHaveBeenCalled();
  });

  it("TTS 在 submitting 证据落库后只执行一次 one-shot，不伪造 taskId 或成本", async () => {
    const claimed = job({
      agentId: "ttsAgent",
      caseId: "tts.mandarin-product.zh.v1",
      requestKind: "tts-generation",
    });
    const deps = dependencies(claimed);
    const worker = new GoldenMediaEvalJobWorker(deps, "test-worker");

    await worker.runOnce();
    expect(deps.executeTts).toHaveBeenCalledTimes(1);
    expect(deps.executeTts).toHaveBeenCalledWith(claimed);
    expect(deps.submit).not.toHaveBeenCalled();
    expect(deps.checkpoint).not.toHaveBeenCalled();
    expect(deps.completeTts).toHaveBeenCalledWith(
      claimed.id,
      "test-worker",
      "lease-token",
      expect.objectContaining({ actualCostUsd: null }),
      expect.arrayContaining([expect.stringContaining(".mp3")]),
    );
  });

  it("已有 taskId 的恢复任务只轮询，绝不再调 submit", async () => {
    const claimed = job({ status: "polling", remoteTaskId: "remote-existing" });
    const deps = dependencies(claimed, {
      poll: vi.fn(async () => ({ state: "pending" as const, delayMs: 8_000 })),
    });
    const worker = new GoldenMediaEvalJobWorker(deps, "test-worker");

    await worker.runOnce();
    expect(deps.submit).not.toHaveBeenCalled();
    expect(deps.poll).toHaveBeenCalledWith(claimed);
    expect(deps.reschedule).toHaveBeenCalledWith(
      claimed.id,
      "test-worker",
      "lease-token",
      { delayMs: 8_000 },
    );
  });

  it("轮询产物完成后使用同一 lease token 提交终态", async () => {
    const claimed = job({ status: "polling", remoteTaskId: "remote-existing" });
    const outcome = {
      state: "completed" as const,
      result: { evalId: claimed.id },
      artifactUrls: [`/api/admin/model-evals/artifacts/${claimed.id}/artifact.mp4`],
    };
    const deps = dependencies(claimed, { poll: vi.fn(async () => outcome) });
    const worker = new GoldenMediaEvalJobWorker(deps, "test-worker");

    await worker.runOnce();
    expect(deps.complete).toHaveBeenCalledWith(
      claimed.id,
      "test-worker",
      "lease-token",
      outcome.result,
      outcome.artifactUrls,
    );
    expect(deps.reschedule).not.toHaveBeenCalled();
  });

  it("产物已落盘但 job 终态 checkpoint 失败时转为可恢复错误", async () => {
    const claimed = job({ status: "polling", remoteTaskId: "remote-existing" });
    const deps = dependencies(claimed, {
      poll: vi.fn(async () => ({
        state: "completed" as const,
        result: { evalId: claimed.id },
        artifactUrls: ["/api/admin/model-evals/artifacts/eval_worker_001/artifact.mp4"],
      })),
      complete: vi.fn(() => { throw new Error("sqlite temporarily busy"); }),
    });
    const worker = new GoldenMediaEvalJobWorker(deps, "test-worker");

    await worker.runOnce();
    expect(deps.fail).toHaveBeenCalledWith(
      claimed.id,
      "test-worker",
      "lease-token",
      expect.objectContaining({ code: "GOLDEN_MEDIA_JOB_RETRYABLE" }),
    );
  });

  it("submission_uncertain 交给仓储层持久终止，worker 不内存重试", async () => {
    const claimed = job();
    const uncertain = new GoldenMediaSubmissionUncertainError("atlas-cloud");
    const deps = dependencies(claimed, {
      submit: vi.fn(async () => Promise.reject(uncertain)),
    });
    const worker = new GoldenMediaEvalJobWorker(deps, "test-worker");

    await expect(worker.runOnce()).resolves.toBe(true);
    expect(deps.submit).toHaveBeenCalledTimes(1);
    expect(deps.checkpoint).not.toHaveBeenCalled();
    expect(deps.fail).toHaveBeenCalledWith(
      claimed.id,
      "test-worker",
      "lease-token",
      uncertain,
    );
  });
});
