import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EnqueueGoldenMediaEvalJobInput } from "@server/admin/evals/media-jobs/repository";

describe("Golden 媒体评测持久 job 状态机", () => {
  let dataDir: string;
  let dbModule: typeof import("@backend/db");
  let schema: typeof import("@backend/db/schema");
  let repository: typeof import("@server/admin/evals/media-jobs/repository");
  let adapter: typeof import("@server/admin/evals/media-jobs/provider-adapter");

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "huimai-golden-media-jobs-"));
    process.env.APP_DATA_DIR = dataDir;
    dbModule = await import("@backend/db");
    schema = await import("@backend/db/schema");
    repository = await import("@server/admin/evals/media-jobs/repository");
    adapter = await import("@server/admin/evals/media-jobs/provider-adapter");
  });

  beforeEach(() => {
    dbModule.db.delete(schema.goldenMediaEvalJobs).run();
  });

  afterAll(() => {
    delete process.env.APP_DATA_DIR;
    rmSync(dataDir, { recursive: true, force: true });
  });

  function input(
    idempotencyKey: string,
    overrides: Partial<EnqueueGoldenMediaEvalJobInput> = {},
  ): EnqueueGoldenMediaEvalJobInput {
    return {
      idempotencyKey,
      agentId: "videoAgent",
      caseId: "video.product-orbit.v1",
      candidateRole: "primary",
      candidateKey: "primary:atlas-cloud/model@fingerprint",
      provider: "atlas-cloud",
      model: "model",
      promptVersion: "v1",
      strategyRevision: 2,
      requestKind: "video-generation",
      payload: {
        version: 1,
        endpoint: {
          provider: "atlas-cloud",
          model: "model",
          baseUrl: "https://api.atlascloud.ai/api/v1",
          secretRef: "video.primary",
        },
        binding: { evaluationFingerprint: "a".repeat(64) },
      },
      ...overrides,
    };
  }

  it("幂等入队先持久候选快照，同键异请求冲突且 payload 不得存凭据", () => {
    const first = repository.enqueueGoldenMediaEvalJob(input("golden-operation-001"));
    const replay = repository.enqueueGoldenMediaEvalJob(input("golden-operation-001"));
    expect(first.duplicate).toBe(false);
    expect(replay.duplicate).toBe(true);
    expect(replay.job.id).toBe(first.job.id);
    expect(first.job).toMatchObject({ status: "pending", remoteTaskId: null });
    const dto = repository.toGoldenMediaEvalJobDto(first.job);
    expect(dto).toMatchObject({ id: first.job.id, status: "pending", taskIdCheckpointed: false });
    expect(dto).not.toHaveProperty("payload");
    expect(dto).not.toHaveProperty("idempotencyKey");
    expect(dto).not.toHaveProperty("remoteTaskId");
    expect(dto).not.toHaveProperty("leaseToken");

    expect(() => repository.enqueueGoldenMediaEvalJob(input("golden-operation-001", {
      model: "another-model",
      payload: { version: 1, marker: "different" },
    }))).toThrow(repository.GoldenMediaJobIdempotencyConflictError);

    expect(() => repository.enqueueGoldenMediaEvalJob(input("golden-operation-secret", {
      payload: { endpoint: { apiKey: "must-not-persist" } },
    }))).toThrow(/apiKey/);
    expect(JSON.stringify(dbModule.db.select().from(schema.goldenMediaEvalJobs).all())).not.toContain("must-not-persist");
  });

  it("primary/fallback 同批原子入队，容量不足时不留下半组付费候选", () => {
    const batch = repository.enqueueGoldenMediaEvalJobs([
      input("golden-batch-primary"),
      input("golden-batch-fallback", {
        candidateRole: "fallback",
        candidateKey: "fallback:atlas-cloud/model@fingerprint",
        payload: { version: 1, role: "fallback" },
      }),
    ]);
    expect(batch).toHaveLength(2);
    expect(dbModule.db.select().from(schema.goldenMediaEvalJobs).all()).toHaveLength(2);

    dbModule.db.delete(schema.goldenMediaEvalJobs).run();
    for (let index = 0; index < 19; index += 1) {
      repository.enqueueGoldenMediaEvalJob(input(`golden-capacity-${String(index).padStart(3, "0")}`, {
        payload: { version: 1, index },
      }));
    }
    expect(() => repository.enqueueGoldenMediaEvalJobs([
      input("golden-overflow-primary", { payload: { version: 1, role: "primary" } }),
      input("golden-overflow-fallback", {
        candidateRole: "fallback",
        candidateKey: "fallback:atlas-cloud/model@fingerprint",
        payload: { version: 1, role: "fallback" },
      }),
    ])).toThrow(repository.GoldenMediaJobQueueLimitError);
    expect(dbModule.db.select().from(schema.goldenMediaEvalJobs).all()).toHaveLength(19);
  });

  it("claim 在付费 POST 前先写 submitting；无 taskId 的过期租约永久终止且不再 claim", () => {
    const queued = repository.enqueueGoldenMediaEvalJob(input("golden-crash-before-id"));
    const started = new Date(Date.now() + 1_000);
    const claimed = repository.claimNextGoldenMediaEvalJob("worker-before-crash", started)!;
    expect(claimed).toMatchObject({
      id: queued.job.id,
      status: "submitting",
      remoteTaskId: null,
      leaseOwner: "worker-before-crash",
    });

    const recovered = repository.recoverExpiredGoldenMediaEvalJobs(
      new Date(started.getTime() + repository.GOLDEN_MEDIA_JOB_LEASE_MS + 1_000),
    );
    expect(recovered.uncertain).toEqual([queued.job.id]);
    expect(repository.getGoldenMediaEvalJob(queued.job.id)).toMatchObject({
      status: "submission_uncertain",
      errorCode: "SUBMISSION_UNCERTAIN",
      remoteTaskId: null,
    });
    expect(repository.claimNextGoldenMediaEvalJob("worker-must-not-resubmit", new Date(started.getTime() + 200_000))).toBeNull();
  });

  it("taskId 拿到后用 lease token 立即 checkpoint；之后崩溃只恢复轮询", () => {
    const queued = repository.enqueueGoldenMediaEvalJob(input("golden-crash-after-id"));
    const started = new Date(Date.now() + 1_000);
    const claimed = repository.claimNextGoldenMediaEvalJob("worker-a", started)!;
    expect(() => repository.checkpointGoldenMediaRemoteTask(
      claimed.id,
      "worker-a",
      "stale-token",
      "remote-task-001",
      new Date(started.getTime() + 1_000),
    )).toThrow(repository.GoldenMediaJobLeaseLostError);

    const checkpointed = repository.checkpointGoldenMediaRemoteTask(
      claimed.id,
      "worker-a",
      claimed.leaseToken!,
      "remote-task-001",
      new Date(started.getTime() + 1_000),
    );
    expect(checkpointed).toMatchObject({ status: "polling", remoteTaskId: "remote-task-001" });

    const recovered = repository.recoverExpiredGoldenMediaEvalJobs(
      new Date(started.getTime() + repository.GOLDEN_MEDIA_JOB_LEASE_MS + 2_000),
    );
    expect(recovered).toMatchObject({ resumed: [queued.job.id], uncertain: [] });
    expect(repository.getGoldenMediaEvalJob(queued.job.id)).toMatchObject({
      status: "submitted",
      remoteTaskId: "remote-task-001",
      errorCode: "LEASE_EXPIRED_RESUME_POLL",
    });
    const resumed = repository.claimNextGoldenMediaEvalJob(
      "worker-b",
      new Date(started.getTime() + repository.GOLDEN_MEDIA_JOB_LEASE_MS + 3_000),
    );
    expect(resumed).toMatchObject({ status: "polling", remoteTaskId: "remote-task-001" });
  });

  it("正常提交在 checkpoint 后释放 lease，不把“等待首次轮询”计成 poll attempt", () => {
    const queued = repository.enqueueGoldenMediaEvalJob(input("golden-release-after-submit"));
    const started = new Date(Date.now() + 1_000);
    const claimed = repository.claimNextGoldenMediaEvalJob("worker-release", started)!;
    repository.checkpointGoldenMediaRemoteTask(
      claimed.id,
      "worker-release",
      claimed.leaseToken!,
      "remote-task-release",
      new Date(started.getTime() + 1_000),
    );
    expect(repository.releaseGoldenMediaAfterSubmission(
      claimed.id,
      "worker-release",
      claimed.leaseToken!,
      new Date(started.getTime() + 2_000),
    )).toBe(true);
    expect(repository.getGoldenMediaEvalJob(queued.job.id)).toMatchObject({
      status: "submitted",
      remoteTaskId: "remote-task-release",
      pollAttempts: 0,
      leaseOwner: null,
      leaseToken: null,
    });
  });

  it("TTS one-shot 成功时允许无 taskId 终结；付费前互斥可安全退回 pending", () => {
    const queued = repository.enqueueGoldenMediaEvalJob(input("golden-tts-one-shot", {
      agentId: "ttsAgent",
      caseId: "tts.mandarin-product.zh.v1",
      provider: "openai",
      model: "tts-1",
      requestKind: "tts-generation",
      payload: { version: 1, kind: "tts-one-shot" },
    }));
    const started = new Date(Date.now() + 1_000);
    const claimed = repository.claimNextGoldenMediaEvalJob("worker-tts", started)!;
    expect(repository.failGoldenMediaEvalJob(
      claimed.id,
      "worker-tts",
      claimed.leaseToken!,
      new repository.GoldenMediaPreSubmitRetryableError(),
      new Date(started.getTime() + 1_000),
    )).toBe(true);
    expect(repository.getGoldenMediaEvalJob(queued.job.id)).toMatchObject({
      status: "pending",
      remoteTaskId: null,
      errorCode: "GOLDEN_MEDIA_PRE_SUBMIT_RETRYABLE",
    });

    const reclaimed = repository.claimNextGoldenMediaEvalJob(
      "worker-tts-retry",
      new Date(started.getTime() + repository.GOLDEN_MEDIA_JOB_POLL_INTERVAL_MS + 2_000),
    )!;
    const completed = repository.completeGoldenTtsEvalJob(
      reclaimed.id,
      "worker-tts-retry",
      reclaimed.leaseToken!,
      { evalId: reclaimed.id, actualCostUsd: null },
      [`/api/admin/model-evals/artifacts/${reclaimed.id}/audio.mp3`],
      new Date(started.getTime() + repository.GOLDEN_MEDIA_JOB_POLL_INTERVAL_MS + 3_000),
    );
    expect(completed).toMatchObject({
      status: "succeeded",
      requestKind: "tts-generation",
      remoteTaskId: null,
      result: { evalId: reclaimed.id, actualCostUsd: null },
    });

    const crashGap = repository.enqueueGoldenMediaEvalJob(input("golden-tts-reconcile", {
      agentId: "ttsAgent",
      caseId: "tts.mandarin-product.zh.v1",
      provider: "openai",
      requestKind: "tts-generation",
      payload: { version: 1, kind: "tts-reconcile" },
    }));
    const crashClaim = repository.claimNextGoldenMediaEvalJob(
      "worker-tts-crash",
      new Date(started.getTime() + repository.GOLDEN_MEDIA_JOB_POLL_INTERVAL_MS + 4_000),
    )!;
    repository.failGoldenMediaEvalJob(
      crashClaim.id,
      "worker-tts-crash",
      crashClaim.leaseToken!,
      new adapter.GoldenMediaSubmissionUncertainError("openai"),
      new Date(started.getTime() + repository.GOLDEN_MEDIA_JOB_POLL_INTERVAL_MS + 5_000),
    );
    expect(repository.listGoldenTtsJobsForReconciliation().map((item) => item.id))
      .toContain(crashGap.job.id);
    expect(repository.completeReconciledGoldenTtsEvalJob(
      crashGap.job.id,
      { evalId: crashGap.job.id, actualCostUsd: null },
      [`/api/admin/model-evals/artifacts/${crashGap.job.id}/audio.mp3`],
    )).toMatchObject({ status: "succeeded", remoteTaskId: null });
  });

  it("提交结果未知时保留幂等终态，已有 taskId 的短暂轮询错误只重排 GET", () => {
    const uncertainJob = repository.enqueueGoldenMediaEvalJob(input("golden-uncertain-error"));
    const firstStart = new Date(Date.now() + 1_000);
    const firstClaim = repository.claimNextGoldenMediaEvalJob("worker-a", firstStart)!;
    expect(repository.failGoldenMediaEvalJob(
      firstClaim.id,
      "worker-a",
      firstClaim.leaseToken!,
      new adapter.GoldenMediaSubmissionUncertainError("atlas-cloud"),
      new Date(firstStart.getTime() + 1_000),
    )).toBe(true);
    expect(repository.getGoldenMediaEvalJob(uncertainJob.job.id)).toMatchObject({
      status: "submission_uncertain",
      errorCode: "SUBMISSION_UNCERTAIN",
    });

    const pollJob = repository.enqueueGoldenMediaEvalJob(input("golden-poll-retry"));
    const secondStart = new Date(firstStart.getTime() + 2_000);
    const secondClaim = repository.claimNextGoldenMediaEvalJob("worker-b", secondStart)!;
    repository.checkpointGoldenMediaRemoteTask(
      secondClaim.id,
      "worker-b",
      secondClaim.leaseToken!,
      "remote-task-retry",
      new Date(secondStart.getTime() + 1_000),
    );
    expect(repository.failGoldenMediaEvalJob(
      secondClaim.id,
      "worker-b",
      secondClaim.leaseToken!,
      new adapter.GoldenMediaPollRetryableError(),
      new Date(secondStart.getTime() + 2_000),
    )).toBe(true);
    expect(repository.getGoldenMediaEvalJob(pollJob.job.id)).toMatchObject({
      status: "submitted",
      remoteTaskId: "remote-task-retry",
      pollAttempts: 1,
      errorCode: "GOLDEN_MEDIA_POLL_RETRYABLE",
    });
  });

  it("轮询用尽时保留 taskId 与 POLL_TIMEOUT 证据，不再 claim", () => {
    const queued = repository.enqueueGoldenMediaEvalJob(input("golden-poll-timeout", {
      maxPollAttempts: 1,
    }));
    const started = new Date(Date.now() + 1_000);
    const claimed = repository.claimNextGoldenMediaEvalJob("worker-timeout", started)!;
    repository.checkpointGoldenMediaRemoteTask(
      claimed.id,
      "worker-timeout",
      claimed.leaseToken!,
      "remote-task-timeout",
      new Date(started.getTime() + 1_000),
    );
    repository.rescheduleGoldenMediaPoll(
      claimed.id,
      "worker-timeout",
      claimed.leaseToken!,
      { now: new Date(started.getTime() + 2_000), delayMs: 0 },
    );

    expect(repository.claimNextGoldenMediaEvalJob(
      "worker-must-not-poll-again",
      new Date(started.getTime() + 3_000),
    )).toBeNull();
    const timedOut = repository.getGoldenMediaEvalJob(queued.job.id)!;
    expect(timedOut).toMatchObject({
      status: "failed",
      remoteTaskId: "remote-task-timeout",
      errorCode: "POLL_TIMEOUT",
      pollAttempts: 1,
    });
    expect(repository.toGoldenMediaEvalJobDto(timedOut)).toMatchObject({
      status: "failed",
      taskIdCheckpointed: true,
      errorCode: "POLL_TIMEOUT",
    });
  });
});
