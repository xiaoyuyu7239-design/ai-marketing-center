import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@backend/core/jobs/compose-handler", () => ({
  runComposeJob: vi.fn(),
}));

vi.mock("@backend/core/jobs/repository", () => ({
  JOB_HEARTBEAT_MS: 30_000,
  claimNextJob: vi.fn(),
  completeComposeJob: vi.fn(),
  failClaimedJob: vi.fn(),
  heartbeatJob: vi.fn(),
  recoverExpiredJobs: vi.fn(),
  sanitizeJobError: (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    return message
      .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
      .replace(/sk-[A-Za-z0-9_-]+/g, "[REDACTED]");
  },
}));

import {
  PersistentJobWorker,
  type JobWorkerDependencies,
} from "@backend/core/jobs/worker";
import type { JobRecord } from "@backend/core/jobs/repository";

function runningJob(): JobRecord {
  const now = new Date();
  return {
    id: "job-001",
    type: "compose",
    merchantId: "merchant-001",
    projectId: "project-001",
    compositionId: "composition-001",
    idempotencyKey: "compose-key-001",
    requestHash: null,
    generationUsageId: null,
    paidTtsUsed: false,
    payloadVersion: 1,
    payload: {},
    result: null,
    status: "running",
    attempts: 1,
    maxAttempts: 2,
    availableAt: now,
    leaseOwner: "test-worker",
    leaseToken: "lease-token-001",
    lockedAt: now,
    leaseExpiresAt: new Date(now.getTime() + 90_000),
    heartbeatAt: now,
    errorCode: null,
    errorMessage: null,
    startedAt: now,
    finishedAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

function dependencies(
  overrides: Partial<JobWorkerDependencies> = {},
): JobWorkerDependencies {
  return {
    recover: vi.fn(() => ({ requeued: [], failed: [] })),
    claim: vi.fn(() => runningJob()),
    heartbeat: vi.fn(() => true),
    process: vi.fn(async () => ({ outputPath: "/tmp/final.mp4", credits: [], paidTtsUsed: false })),
    complete: vi.fn(),
    fail: vi.fn(() => true),
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("PersistentJobWorker", () => {
  it("一次只 claim/执行一个任务，成功后用同一 lease token 提交", async () => {
    const deps = dependencies();
    const worker = new PersistentJobWorker(deps, "test-worker");

    await expect(worker.runOnce()).resolves.toBe(true);
    expect(deps.recover).toHaveBeenCalledTimes(1);
    expect(deps.claim).toHaveBeenCalledTimes(1);
    expect(deps.process).toHaveBeenCalledTimes(1);
    expect(deps.complete).toHaveBeenCalledWith(
      "job-001",
      "test-worker",
      "lease-token-001",
      { outputPath: "/tmp/final.mp4", credits: [], paidTtsUsed: false },
    );
    expect(deps.fail).not.toHaveBeenCalled();
  });

  it("30 秒心跳失去租约后不提交成功结果，旧 worker 只尝试带 token 的失败回写", async () => {
    vi.useFakeTimers();
    let finishProcess: ((value: { outputPath: string; credits: []; paidTtsUsed: boolean }) => void) | undefined;
    const processResult = new Promise<{ outputPath: string; credits: []; paidTtsUsed: boolean }>((resolve) => {
      finishProcess = resolve;
    });
    const deps = dependencies({
      heartbeat: vi.fn(() => false),
      process: vi.fn(() => processResult),
    });
    const worker = new PersistentJobWorker(deps, "test-worker");
    const running = worker.runOnce();

    await vi.advanceTimersByTimeAsync(30_000);
    expect(deps.heartbeat).toHaveBeenCalledWith(
      "job-001",
      "test-worker",
      "lease-token-001",
    );
    finishProcess?.({ outputPath: "/tmp/late.mp4", credits: [], paidTtsUsed: false });
    await expect(running).resolves.toBe(true);
    expect(deps.complete).not.toHaveBeenCalled();
    expect(deps.fail).toHaveBeenCalledWith(
      "job-001",
      "test-worker",
      "lease-token-001",
      expect.objectContaining({ message: expect.stringMatching(/租约已失效/) }),
    );
  });

  it("处理器异常会转交持久失败回写，不让 loop 崩溃", async () => {
    const failure = new Error("ffmpeg failed Authorization: Bearer sk-sensitive-token");
    const deps = dependencies({ process: vi.fn(async () => Promise.reject(failure)) });
    const worker = new PersistentJobWorker(deps, "test-worker");
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(worker.runOnce()).resolves.toBe(true);
    expect(deps.complete).not.toHaveBeenCalled();
    expect(deps.fail).toHaveBeenCalledWith(
      "job-001",
      "test-worker",
      "lease-token-001",
      failure,
    );
    const serializedLogs = JSON.stringify(errorLog.mock.calls);
    expect(serializedLogs).not.toContain("sk-sensitive-token");
    expect(serializedLogs).toContain("[REDACTED]");
  });
});
