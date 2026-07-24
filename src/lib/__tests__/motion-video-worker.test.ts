import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MotionVideoJobWorker,
  type MotionVideoJobWorkerDependencies,
} from "@backend/core/video-jobs/worker";
import type { MotionVideoJobRecord } from "@backend/core/video-jobs/repository";

function job(overrides: Partial<MotionVideoJobRecord> = {}): MotionVideoJobRecord {
  return {
    id: "motion-job-001",
    status: "submitting",
    remoteTaskId: null,
    leaseToken: "lease-001",
    ...overrides,
  } as MotionVideoJobRecord;
}

function dependencies(
  claimed: MotionVideoJobRecord,
  overrides: Partial<MotionVideoJobWorkerDependencies> = {},
): MotionVideoJobWorkerDependencies {
  return {
    recover: vi.fn(() => ({ resumed: [], uncertain: [], timedOut: [] })),
    claim: vi.fn(() => claimed),
    heartbeat: vi.fn(() => true),
    submit: vi.fn(async () => "remote-task-001"),
    checkpointTask: vi.fn(() => job({ ...claimed, remoteTaskId: "remote-task-001", status: "polling" })),
    releaseAfterSubmission: vi.fn(() => true),
    poll: vi.fn(async () => ({ state: "pending" as const, progress: null, retryAfterSeconds: 5 })),
    reschedule: vi.fn(() => true),
    checkpointDownloading: vi.fn(() => job({ ...claimed, status: "downloading" })),
    persist: vi.fn(async () => "/api/files/project-001/motion.mp4"),
    checkpointSaving: vi.fn(() => job({ ...claimed, status: "saving" })),
    complete: vi.fn(() => job({ ...claimed, status: "succeeded" })),
    fail: vi.fn(() => true),
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("分镜动态持久 worker", () => {
  it("提交期间 heartbeat 瞬时返回 false 仍优先原子 checkpoint taskId", async () => {
    vi.useFakeTimers();
    const claimed = job();
    let resolveSubmit!: (taskId: string) => void;
    const submit = vi.fn(() => new Promise<string>((resolve) => {
      resolveSubmit = resolve;
    }));
    const deps = dependencies(claimed, {
      heartbeat: vi.fn(() => false),
      submit,
    });
    const worker = new MotionVideoJobWorker(deps, "worker-heartbeat");

    const running = worker.runOnce();
    await vi.advanceTimersByTimeAsync(30_001);
    expect(deps.heartbeat).toHaveBeenCalledWith(
      claimed.id,
      "worker-heartbeat",
      claimed.leaseToken,
    );
    resolveSubmit("remote-task-after-heartbeat");
    await running;

    expect(deps.checkpointTask).toHaveBeenCalledWith(
      claimed.id,
      "worker-heartbeat",
      claimed.leaseToken,
      "remote-task-after-heartbeat",
    );
    expect(deps.releaseAfterSubmission).toHaveBeenCalledOnce();
    expect(deps.fail).not.toHaveBeenCalled();
  });

  it("已有 taskId 的恢复任务只调 GET 轮询，不再调付费提交", async () => {
    const claimed = job({ status: "polling", remoteTaskId: "remote-task-existing" });
    const deps = dependencies(claimed, {
      poll: vi.fn(async () => ({ state: "pending" as const, retryAfterSeconds: 17, progress: 42 })),
    });
    const worker = new MotionVideoJobWorker(deps, "worker-poll-only");

    await expect(worker.runOnce()).resolves.toBe(true);

    expect(deps.submit).not.toHaveBeenCalled();
    expect(deps.poll).toHaveBeenCalledWith(claimed);
    expect(deps.reschedule).toHaveBeenCalledWith(
      claimed.id,
      "worker-poll-only",
      claimed.leaseToken,
      { delayMs: 17_000, progress: 42 },
    );
  });
});
