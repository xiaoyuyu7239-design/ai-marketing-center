import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  assertRuntimeConfiguration: vi.fn(),
  assertAdminConfiguration: vi.fn(),
  startPersistentJobWorker: vi.fn(),
  startGoldenMediaEvalJobWorker: vi.fn(),
  startMotionVideoJobWorker: vi.fn(),
  startReminderScheduler: vi.fn(),
}));

vi.mock("@backend/core/security/runtime-config", () => ({
  assertRuntimeConfiguration: mocks.assertRuntimeConfiguration,
}));
vi.mock("@server/admin/admin-auth", () => ({
  assertAdminConfiguration: mocks.assertAdminConfiguration,
}));
vi.mock("@backend/db", () => ({}));
vi.mock("@backend/core/jobs/worker", () => ({
  startPersistentJobWorker: mocks.startPersistentJobWorker,
}));
vi.mock("@server/admin/evals/media-jobs/worker", () => ({
  startGoldenMediaEvalJobWorker: mocks.startGoldenMediaEvalJobWorker,
}));
vi.mock("@backend/core/video-jobs/worker", () => ({
  startMotionVideoJobWorker: mocks.startMotionVideoJobWorker,
}));
vi.mock("@backend/core/schedule/reminder-scheduler", () => ({
  startReminderScheduler: mocks.startReminderScheduler,
}));

import { register } from "@/instrumentation";

const originalRuntime = process.env.NEXT_RUNTIME;
const originalPhase = process.env.NEXT_PHASE;
const originalDisableScheduler = process.env.CLIPFORGE_DISABLE_SCHEDULER;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.NEXT_RUNTIME = "nodejs";
  delete process.env.NEXT_PHASE;
  delete process.env.CLIPFORGE_DISABLE_SCHEDULER;
});

afterEach(() => {
  if (originalRuntime === undefined) delete process.env.NEXT_RUNTIME;
  else process.env.NEXT_RUNTIME = originalRuntime;
  if (originalPhase === undefined) delete process.env.NEXT_PHASE;
  else process.env.NEXT_PHASE = originalPhase;
  if (originalDisableScheduler === undefined) delete process.env.CLIPFORGE_DISABLE_SCHEDULER;
  else process.env.CLIPFORGE_DISABLE_SCHEDULER = originalDisableScheduler;
});

describe("Next instrumentation 持久任务生命线", () => {
  it("提醒 scheduler 关闭时仍执行运行时门禁、DB 迁移并启动 jobs worker", async () => {
    process.env.CLIPFORGE_DISABLE_SCHEDULER = "1";
    await register();

    expect(mocks.assertRuntimeConfiguration).toHaveBeenCalledTimes(1);
    expect(mocks.assertAdminConfiguration).toHaveBeenCalledTimes(1);
    expect(mocks.startPersistentJobWorker).toHaveBeenCalledTimes(1);
    expect(mocks.startGoldenMediaEvalJobWorker).toHaveBeenCalledTimes(1);
    expect(mocks.startMotionVideoJobWorker).toHaveBeenCalledTimes(1);
    expect(mocks.startReminderScheduler).not.toHaveBeenCalled();
  });

  it("Edge/build 阶段绝不加载 native DB 与 worker", async () => {
    process.env.NEXT_RUNTIME = "edge";
    await register();
    expect(mocks.startPersistentJobWorker).not.toHaveBeenCalled();
    expect(mocks.startGoldenMediaEvalJobWorker).not.toHaveBeenCalled();
    expect(mocks.startMotionVideoJobWorker).not.toHaveBeenCalled();

    process.env.NEXT_RUNTIME = "nodejs";
    process.env.NEXT_PHASE = "phase-production-build";
    await register();
    expect(mocks.startPersistentJobWorker).not.toHaveBeenCalled();
    expect(mocks.startGoldenMediaEvalJobWorker).not.toHaveBeenCalled();
    expect(mocks.startMotionVideoJobWorker).not.toHaveBeenCalled();
  });
});
