import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";

import type { EnqueueMotionVideoJobInput } from "@backend/core/video-jobs/repository";
import type { MotionVideoJobPayloadV1 } from "@backend/core/video-jobs/types";
import type { Shot } from "@backend/db/schema";

describe("分镜转动态持久任务状态机", () => {
  let dataDir: string;
  let dbModule: typeof import("@backend/db");
  let schema: typeof import("@backend/db/schema");
  let repository: typeof import("@backend/core/video-jobs/repository");
  let usage: typeof import("@backend/core/auth/usage");
  let errors: typeof import("@backend/core/video-jobs/errors");
  let preparation: typeof import("@backend/core/video-jobs/preparation");
  let processor: typeof import("@backend/core/video-jobs/processor");
  let merchantId: string;
  let otherMerchantId: string;
  let projectId: string;
  let assetId: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "huimai-motion-video-jobs-"));
    process.env.APP_DATA_DIR = dataDir;
    process.env.CLIPFORGE_VIDEO_API_KEY = "test-video-key";
    dbModule = await import("@backend/db");
    schema = await import("@backend/db/schema");
    repository = await import("@backend/core/video-jobs/repository");
    usage = await import("@backend/core/auth/usage");
    errors = await import("@backend/core/video-jobs/errors");
    preparation = await import("@backend/core/video-jobs/preparation");
    processor = await import("@backend/core/video-jobs/processor");
  });

  beforeEach(() => {
    dbModule.db.delete(schema.motionVideoJobs).run();
    dbModule.db.delete(schema.motionAssetAssessments).run();
    dbModule.db.delete(schema.videoClips).run();
    dbModule.db.delete(schema.generationUsage).run();
    dbModule.db.delete(schema.assets).run();
    dbModule.db.delete(schema.scripts).run();
    dbModule.db.delete(schema.projects).run();
    dbModule.db.delete(schema.merchants).run();
    merchantId = dbModule.db.insert(schema.merchants).values({
      email: `motion-${crypto.randomUUID()}@example.com`,
      passwordHash: "salt:hash",
      planId: "trial",
    }).returning({ id: schema.merchants.id }).all()[0].id;
    otherMerchantId = dbModule.db.insert(schema.merchants).values({
      email: `motion-other-${crypto.randomUUID()}@example.com`,
      passwordHash: "salt:hash",
      planId: "trial",
    }).returning({ id: schema.merchants.id }).all()[0].id;
    projectId = dbModule.db.insert(schema.projects).values({
      merchantId,
      name: "motion project",
      status: "assets",
    }).returning({ id: schema.projects.id }).all()[0].id;
    assetId = dbModule.db.insert(schema.assets).values({
      projectId,
      shotId: 1,
      type: "ai_generated",
      filePath: `/api/files/${projectId}/shot-1.png`,
      status: "done",
    }).returning({ id: schema.assets.id }).all()[0].id;
  });

  afterAll(() => {
    delete process.env.APP_DATA_DIR;
    delete process.env.CLIPFORGE_VIDEO_API_KEY;
    rmSync(dataDir, { recursive: true, force: true });
  });

  function payload(marker = "default"): MotionVideoJobPayloadV1 {
    const imageHash = "a".repeat(64);
    const decision = {
      policy: "ai_video" as const,
      state: "eligible" as const,
      reason: "AI_IMAGE_ELIGIBLE" as const,
      binding: {
        assetId,
        imageRef: `/api/files/${projectId}/shot-1.png`,
        imageHash,
        modelRevision: "face-detector-test-v1",
        eligibilityRevision: "motion-eligibility-v2" as const,
        mediaKind: "image" as const,
        width: 1080,
        height: 1920,
      },
    };
    return {
      version: 1,
      selectedScriptId: "script-001",
      shot: { shotId: 1, type: "demo", visualSource: "ai_generate", duration: 3 },
      prompt: `轻微动态 ${marker}`,
      options: { width: 1080, height: 1920, duration: 3 },
      source: {
        shot: { shotId: 1, type: "demo", visualSource: "ai_generate" },
        assetId,
        imageRef: `/api/files/${projectId}/shot-1.png`,
        imageHash,
        width: 1080,
        height: 1920,
        decision,
        faceAssessment: {
          status: "clear",
          checkedImageHash: imageHash,
          modelRevision: "face-detector-test-v1",
          source: "detector",
        },
      },
      lastFrame: null,
      endpoint: {
        provider: "volcengine",
        model: "video-model",
        baseUrl: "https://provider.example/api/v3",
        secretRef: "video.primary",
      },
      endpointRole: "primary",
      strategyRevision: 2,
      promptVersion: "v1",
    };
  }

  function input(operationKey: string, marker = "default"): EnqueueMotionVideoJobInput {
    return {
      merchantId,
      projectId,
      operationKey,
      itemKey: "shot:1",
      shotId: 1,
      sourceAssetId: assetId,
      payload: payload(marker),
    };
  }

  function installTwoShotProject() {
    const shots: Shot[] = [
      {
        shotId: 1,
        type: "demo",
        duration: 3,
        description: "红色上衣轻微摆动",
        camera: "固定镜头",
        visualSource: "ai_generate",
        transition: "ai_start_end",
        voiceover: "展示细节",
      },
      {
        shotId: 2,
        type: "demo",
        duration: 3,
        description: "红色上衣尾帧",
        camera: "固定镜头",
        visualSource: "ai_generate",
        transition: "ai_start_end",
        voiceover: "展示整体",
      },
    ];
    dbModule.db.insert(schema.scripts).values({
      projectId,
      styleType: "scene",
      selected: true,
      shots,
    }).run();
    const secondAssetId = dbModule.db.insert(schema.assets).values({
      projectId,
      shotId: 2,
      type: "ai_generated",
      filePath: `/api/files/${projectId}/shot-2.png`,
      status: "done",
    }).returning({ id: schema.assets.id }).all()[0].id;
    const uploadDir = join(dataDir, "uploads", projectId);
    mkdirSync(uploadDir, { recursive: true });
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    );
    writeFileSync(join(uploadDir, "shot-1.png"), png);
    writeFileSync(join(uploadDir, "shot-2.png"), png);
    return { secondAssetId, shots, png, uploadDir };
  }

  function clearFaceDetector() {
    return {
      modelRevision: "face-detector-test-v2",
      available: true,
      detect: vi.fn(async () => ({ status: "clear" as const })),
    };
  }

  it("原子预占一次额度并幂等入队，DTO 不泄漏 taskId/lease/payload，租户查询隔离", () => {
    const first = repository.enqueueMotionVideoJobs([input("motion-operation-001")])[0];
    const replay = repository.enqueueMotionVideoJobs([input("motion-operation-001")])[0];
    expect(first.duplicate).toBe(false);
    expect(replay).toMatchObject({ duplicate: true, job: { id: first.job.id } });
    expect(dbModule.db.select().from(schema.generationUsage).all()).toEqual([
      expect.objectContaining({ status: "running", success: true }),
    ]);
    expect(dbModule.db.select().from(schema.generationOperationItems).all()).toHaveLength(1);

    const dto = repository.toMotionVideoJobDto(first.job);
    expect(dto).toMatchObject({
      status: "pending",
      taskIdCheckpointed: false,
      shotId: 1,
      sourceAssetId: assetId,
    });
    expect(dto).not.toHaveProperty("remoteTaskId");
    expect(dto).not.toHaveProperty("leaseToken");
    expect(dto).not.toHaveProperty("payload");
    expect(repository.getMotionVideoJob(otherMerchantId, projectId, first.job.id)).toBeNull();
    expect(repository.listMotionVideoJobs(otherMerchantId, projectId)).toEqual([]);

    expect(() => repository.enqueueMotionVideoJobs([input("motion-operation-001", "changed")]))
      .toThrow(errors.MotionVideoJobIdempotencyConflictError);
  });

  it("同一秒入队的任务按真实插入顺序选最新，不用随机 UUID 猜新旧", () => {
    const first = repository.enqueueMotionVideoJobs([input("motion-order-first")])[0].job;
    const second = repository.enqueueMotionVideoJobs([input("motion-order-second")])[0].job;
    const sameSecond = new Date("2026-07-17T10:00:00.000Z");
    dbModule.db.update(schema.motionVideoJobs).set({ createdAt: sameSecond })
      .where(eq(schema.motionVideoJobs.id, first.id)).run();
    dbModule.db.update(schema.motionVideoJobs).set({ createdAt: sameSecond })
      .where(eq(schema.motionVideoJobs.id, second.id)).run();
    expect(repository.listMotionVideoJobs(merchantId, projectId).slice(0, 2).map((job) => job.id))
      .toEqual([second.id, first.id]);
  });

  it("无 taskId 的提交租约过期后 uncertain 且永不重提", () => {
    const queued = repository.enqueueMotionVideoJobs([input("motion-uncertain-001")])[0].job;
    const started = new Date(Date.now() + 1_000);
    const claimed = repository.claimNextMotionVideoJob("worker-a", started)!;
    expect(claimed).toMatchObject({ id: queued.id, status: "submitting", remoteTaskId: null });
    const recovered = repository.recoverExpiredMotionVideoJobs(
      new Date(started.getTime() + repository.MOTION_VIDEO_JOB_LEASE_MS + 1),
    );
    expect(recovered.uncertain).toEqual([queued.id]);
    expect(repository.getMotionVideoJob(merchantId, projectId, queued.id)).toMatchObject({
      status: "submission_uncertain",
      paidCapabilityUsed: false,
    });
    expect(repository.claimNextMotionVideoJob("worker-b", new Date(started.getTime() + 200_000))).toBeNull();
  });

  it("通用额度过期回收器不越权终止已持久入队的 motion item", () => {
    const queued = repository.enqueueMotionVideoJobs([input("motion-owned-recovery-001")])[0].job;
    expect(usage.recoverStaleGenerationItems(
      new Date(Date.now() + repository.MOTION_VIDEO_USAGE_DEADLINE_MS + 60_000),
    )).toBe(0);
    expect(repository.getMotionVideoJob(merchantId, projectId, queued.id)?.status).toBe("pending");
    expect(dbModule.db.select().from(schema.generationOperationItems).all()[0]).toMatchObject({
      status: "pending",
      failureCode: null,
    });
  });

  it("taskId 立即 checkpoint 后崩溃只恢复 GET，且远端失败仍保留付费用量", () => {
    const queued = repository.enqueueMotionVideoJobs([input("motion-checkpoint-001")])[0].job;
    const started = new Date(Date.now() + 1_000);
    const claimed = repository.claimNextMotionVideoJob("worker-a", started)!;
    const checkpointed = repository.checkpointMotionRemoteTask(
      claimed.id,
      "worker-a",
      claimed.leaseToken!,
      "remote-task-001",
      new Date(started.getTime() + 1_000),
    );
    expect(checkpointed).toMatchObject({ status: "polling", paidCapabilityUsed: true });

    const recovered = repository.recoverExpiredMotionVideoJobs(
      new Date(started.getTime() + repository.MOTION_VIDEO_JOB_LEASE_MS + 2_000),
    );
    expect(recovered.resumed).toEqual([queued.id]);
    const resumed = repository.claimNextMotionVideoJob(
      "worker-b",
      new Date(started.getTime() + repository.MOTION_VIDEO_JOB_LEASE_MS + 3_000),
    )!;
    expect(resumed).toMatchObject({ status: "polling", remoteTaskId: "remote-task-001" });
    expect(repository.failClaimedMotionVideoJob(
      resumed.id,
      "worker-b",
      resumed.leaseToken!,
      new errors.MotionVideoRemoteTaskError(
        "REMOTE_FAILED",
        "remote failed",
        "safety",
        "regenerate_faceless",
        "req-remote-001",
      ),
      new Date(started.getTime() + repository.MOTION_VIDEO_JOB_LEASE_MS + 4_000),
    )).toBe(true);
    expect(repository.getMotionVideoJob(merchantId, projectId, resumed.id)).toMatchObject({
      status: "failed",
      errorCategory: "safety",
      errorRequestId: "req-remote-001",
    });
    expect(dbModule.db.select().from(schema.generationUsage).all()[0]).toMatchObject({
      status: "succeeded",
      success: true,
      succeededItems: 1,
    });
  });

  it("已有 taskId 后本地心跳/磁盘/DB 未知异常只重排 GET，不终态失败", () => {
    const queued = repository.enqueueMotionVideoJobs([input("motion-local-recovery-001")])[0].job;
    const started = new Date(Date.now() + 1_000);
    const claimed = repository.claimNextMotionVideoJob("worker-a", started)!;
    repository.checkpointMotionRemoteTask(
      claimed.id,
      "worker-a",
      claimed.leaseToken!,
      "remote-task-local-recovery",
      new Date(started.getTime() + 1_000),
    );

    expect(repository.failClaimedMotionVideoJob(
      claimed.id,
      "worker-a",
      claimed.leaseToken!,
      new Error("temporary disk error"),
      new Date(started.getTime() + 2_000),
    )).toBe(true);
    expect(repository.getMotionVideoJob(merchantId, projectId, queued.id)).toMatchObject({
      status: "submitted",
      remoteTaskId: "remote-task-local-recovery",
      errorCode: "POLL_RETRYABLE",
      errorRetryable: true,
      paidCapabilityUsed: true,
    });
    expect(dbModule.db.select().from(schema.generationUsage).all()[0]).toMatchObject({
      status: "running",
      success: true,
      completedItems: 0,
    });

    const resumed = repository.claimNextMotionVideoJob(
      "worker-b",
      new Date(started.getTime() + 13_000),
    );
    expect(resumed).toMatchObject({
      id: queued.id,
      status: "polling",
      remoteTaskId: "remote-task-local-recovery",
    });
  });

  it("明确 429 在付费提交前按 Retry-After 重新排队，不显示为失败", () => {
    const queued = repository.enqueueMotionVideoJobs([input("motion-rate-limit-001")])[0].job;
    const started = new Date(Date.now() + 1_000);
    const claimed = repository.claimNextMotionVideoJob("worker-a", started)!;
    expect(repository.failClaimedMotionVideoJob(
      claimed.id,
      "worker-a",
      claimed.leaseToken!,
      new errors.MotionVideoRateLimitedError(120, "req-rate-001"),
      new Date(started.getTime() + 1_000),
    )).toBe(true);
    const saved = repository.getMotionVideoJob(merchantId, projectId, queued.id)!;
    expect(saved).toMatchObject({
      status: "pending",
      errorCode: "RATE_LIMITED",
      errorRequestId: "req-rate-001",
      retryAfterSeconds: 120,
    });
    expect(saved.availableAt.getTime()).toBe(
      Math.floor((started.getTime() + 121_000) / 1_000) * 1_000,
    );
  });

  it("taskId 已 checkpoint 的轮询超时终止任务，但保留已消耗的付费用量", () => {
    const queued = repository.enqueueMotionVideoJobs([{
      ...input("motion-poll-timeout-001"),
      maxPollAttempts: 1,
    }])[0].job;
    const started = new Date(Date.now() + 1_000);
    const submitting = repository.claimNextMotionVideoJob("worker-a", started)!;
    repository.checkpointMotionRemoteTask(
      submitting.id,
      "worker-a",
      submitting.leaseToken!,
      "remote-task-timeout",
      new Date(started.getTime() + 1_000),
    );
    expect(repository.releaseMotionAfterSubmission(
      submitting.id,
      "worker-a",
      submitting.leaseToken!,
      new Date(started.getTime() + 2_000),
    )).toBe(true);

    const polling = repository.claimNextMotionVideoJob(
      "worker-b",
      new Date(started.getTime() + 8_000),
    )!;
    expect(polling).toMatchObject({ status: "polling", remoteTaskId: "remote-task-timeout" });
    expect(repository.rescheduleMotionPoll(
      polling.id,
      "worker-b",
      polling.leaseToken!,
      { now: new Date(started.getTime() + 9_000), delayMs: 1 },
    )).toBe(true);

    const recovered = repository.recoverExpiredMotionVideoJobs(new Date(started.getTime() + 10_000));
    expect(recovered.timedOut).toEqual([queued.id]);
    expect(repository.getMotionVideoJob(merchantId, projectId, queued.id)).toMatchObject({
      status: "failed",
      errorCode: "POLL_TIMEOUT",
      paidCapabilityUsed: true,
    });
    expect(dbModule.db.select().from(schema.generationUsage).all()[0]).toMatchObject({
      status: "succeeded",
      success: true,
      succeededItems: 1,
    });
  });

  it("项目资格查询按租户隔离，且同路径换图会重算 hash 和人脸", async () => {
    const { png, uploadDir } = installTwoShotProject();
    const detector = clearFaceDetector();

    await expect(preparation.evaluateProjectMotionShots(otherMerchantId, projectId, { faceDetector: detector }))
      .rejects.toThrow("项目不存在");
    expect(detector.detect).not.toHaveBeenCalled();

    const before = await preparation.evaluateProjectMotionShots(merchantId, projectId, { faceDetector: detector });
    expect(before[0]).toMatchObject({
      shotId: 1,
      decision: { policy: "ai_video", state: "eligible" },
      faceAssessment: { status: "clear" },
    });
    expect(detector.detect).toHaveBeenCalledTimes(2);

    writeFileSync(join(uploadDir, "shot-1.png"), Buffer.concat([png, Buffer.from("changed-content")]));
    const after = await preparation.evaluateProjectMotionShots(merchantId, projectId, { faceDetector: detector });
    expect(after[0].imageHash).not.toBe(before[0].imageHash);
    // shot 2 精确命中 hash+revision 缓存；同路径已换内容的 shot 1 必须重检。
    expect(detector.detect).toHaveBeenCalledTimes(3);
  });

  it("尾帧入队后改成商品静态图，付费前拒绝且不调用模型 POST", async () => {
    const { secondAssetId, shots } = installTwoShotProject();
    const detector = clearFaceDetector();
    const evaluated = await preparation.evaluateProjectMotionShots(merchantId, projectId, { faceDetector: detector });
    const source = evaluated[0];
    const tail = evaluated[1];
    expect(source.faceAssessment && tail.faceAssessment).toBeTruthy();

    const frozen = payload("tail-frame");
    frozen.shot = {
      shotId: shots[0].shotId,
      type: shots[0].type,
      visualSource: shots[0].visualSource,
      duration: shots[0].duration,
    };
    frozen.source = {
      shot: { shotId: shots[0].shotId, type: shots[0].type, visualSource: shots[0].visualSource },
      assetId,
      imageRef: source.imageRef!,
      imageHash: source.imageHash!,
      width: source.width,
      height: source.height,
      decision: source.decision,
      faceAssessment: source.faceAssessment!,
    };
    frozen.lastFrame = {
      shot: { shotId: shots[1].shotId, type: shots[1].type, visualSource: shots[1].visualSource },
      assetId: secondAssetId,
      imageRef: tail.imageRef!,
      imageHash: tail.imageHash!,
      width: tail.width,
      height: tail.height,
      decision: tail.decision,
      faceAssessment: tail.faceAssessment!,
    };
    const queued = repository.enqueueMotionVideoJobs([{
      merchantId,
      projectId,
      operationKey: "motion-tail-stale-001",
      itemKey: "shot:1",
      shotId: 1,
      sourceAssetId: assetId,
      payload: frozen,
    }])[0].job;
    const claimed = repository.claimNextMotionVideoJob("worker-tail")!;
    expect(claimed.id).toBe(queued.id);
    dbModule.db.update(schema.assets).set({ type: "product_image" })
      .where(eq(schema.assets.id, secondAssetId)).run();
    const submitTask = vi.fn(async () => "must-not-submit");

    await expect(processor.submitPersistedMotionVideoJob(claimed, { faceDetector: detector, submitTask }))
      .rejects.toMatchObject({ code: "MOTION_ELIGIBILITY_STALE" });
    expect(submitTask).not.toHaveBeenCalled();
  });

  it("换了新分镜图后不复用绑定旧 assetId 的动态视频", async () => {
    const { png, uploadDir } = installTwoShotProject();
    dbModule.db.insert(schema.videoClips).values({
      projectId,
      shotId: 1,
      assetId,
      filePath: `/api/files/${projectId}/old-motion.mp4`,
      status: "done",
    }).run();
    const newImageRef = `/api/files/${projectId}/shot-1-v2.png`;
    writeFileSync(join(uploadDir, "shot-1-v2.png"), Buffer.concat([png, Buffer.from("v2")]));
    const newAssetId = dbModule.db.insert(schema.assets).values({
      projectId,
      shotId: 1,
      type: "ai_generated",
      filePath: newImageRef,
      status: "done",
      createdAt: new Date(Date.now() + 5_000),
    }).returning({ id: schema.assets.id }).all()[0].id;

    const evaluated = await preparation.evaluateProjectMotionShots(merchantId, projectId, {
      faceDetector: clearFaceDetector(),
    });
    expect(evaluated[0]).toMatchObject({
      assetId: newAssetId,
      imageRef: newImageRef,
      existingVideoUrl: null,
      existingVideoClipId: null,
      decision: { policy: "ai_video", state: "eligible" },
    });
  });

  it("旧 asset 的视频晚完成时，仍选当前 asset 已有的最新有效 clip", async () => {
    const { png, uploadDir } = installTwoShotProject();
    const newImageRef = `/api/files/${projectId}/shot-1-current.png`;
    writeFileSync(join(uploadDir, "shot-1-current.png"), Buffer.concat([png, Buffer.from("current")]));
    const newAssetId = dbModule.db.insert(schema.assets).values({
      projectId,
      shotId: 1,
      type: "ai_generated",
      filePath: newImageRef,
      status: "done",
      createdAt: new Date(Date.now() + 5_000),
    }).returning({ id: schema.assets.id }).all()[0].id;
    const validClipId = dbModule.db.insert(schema.videoClips).values({
      projectId,
      shotId: 1,
      assetId: newAssetId,
      filePath: `/api/files/${projectId}/current-motion.mp4`,
      status: "done",
      createdAt: new Date(Date.now() + 6_000),
    }).returning({ id: schema.videoClips.id }).all()[0].id;
    // 旧图任务晚一秒完成；它在全局排序上更新，但不属于当前 asset。
    dbModule.db.insert(schema.videoClips).values({
      projectId,
      shotId: 1,
      assetId,
      filePath: `/api/files/${projectId}/stale-late-motion.mp4`,
      status: "done",
      createdAt: new Date(Date.now() + 7_000),
    }).run();

    const evaluated = await preparation.evaluateProjectMotionShots(merchantId, projectId, {
      faceDetector: clearFaceDetector(),
    });
    expect(evaluated[0]).toMatchObject({
      assetId: newAssetId,
      existingVideoUrl: `/api/files/${projectId}/current-motion.mp4`,
      existingVideoClipId: validClipId,
      decision: { policy: "use_existing_video" },
    });
  });
});
