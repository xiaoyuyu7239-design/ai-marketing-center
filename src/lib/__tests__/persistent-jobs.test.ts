import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("持久 jobs 状态机", () => {
  let dataDir: string;
  let dbModule: typeof import("@backend/db");
  let schema: typeof import("@backend/db/schema");
  let repository: typeof import("@backend/core/jobs/repository");
  let payloadModule: typeof import("@backend/core/jobs/compose-payload");
  let usageModule: typeof import("@backend/core/auth/usage");

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "huimai-persistent-jobs-"));
    process.env.APP_DATA_DIR = dataDir;
    dbModule = await import("@backend/db");
    schema = await import("@backend/db/schema");
    repository = await import("@backend/core/jobs/repository");
    payloadModule = await import("@backend/core/jobs/compose-payload");
    usageModule = await import("@backend/core/auth/usage");
  });

  beforeEach(() => {
    dbModule.db.delete(schema.jobs).run();
    dbModule.db.delete(schema.compositions).run();
    dbModule.db.delete(schema.projects).run();
    dbModule.db.delete(schema.merchants).run();
  });

  afterAll(() => {
    delete process.env.APP_DATA_DIR;
    rmSync(dataDir, { recursive: true, force: true });
  });

  function createMerchant(label: string): string {
    return dbModule.db
      .insert(schema.merchants)
      .values({
        email: `${label}-${crypto.randomUUID()}@example.com`,
        passwordHash: "salt:hash",
        planId: "trial",
      })
      .returning({ id: schema.merchants.id })
      .all()[0].id;
  }

  function createProject(merchantId: string, label: string): string {
    return dbModule.db
      .insert(schema.projects)
      .values({ merchantId, name: label, status: "video" })
      .returning({ id: schema.projects.id })
      .all()[0].id;
  }

  function enqueue(
    merchantId: string,
    projectId: string,
    idempotencyKey: string,
    options: { paidTtsRequested?: boolean; payloadMarker?: string; ttsEnabled?: boolean } = {},
  ) {
    const payload = {
      version: 1,
      merchantId,
      projectId,
      marker: options.payloadMarker ?? "default",
      options: { agentTts: options.paidTtsRequested === true },
    };
    return repository.enqueueComposeJob({
      merchantId,
      projectId,
      idempotencyKey,
      payload,
      requestHash: usageModule.hashGenerationRequest(payload),
      paidTtsRequested: options.paidTtsRequested === true,
      resolution: "720p",
      aspectRatio: "9:16",
      ttsEnabled: options.ttsEnabled ?? options.paidTtsRequested === true,
    });
  }

  it("job payload 递归拒绝 API Key/服务器配置，只接受业务快照", () => {
    expect(() =>
      payloadModule.assertComposePayloadHasNoSecrets({
        version: 1,
        nested: { apiKey: "must-not-persist" },
      }),
    ).toThrow(/禁止持久化/);
    expect(() =>
      payloadModule.assertComposePayloadHasNoSecrets({
        version: 1,
        options: { baseUrl: "https://provider.example", accessToken: "secret" },
      }),
    ).toThrow(/禁止持久化/);
    expect(() =>
      payloadModule.assertComposePayloadHasNoSecrets({
        version: 1,
        project: { name: "可持久业务快照" },
        options: { freeTts: { voice: "zh-CN-XiaoxiaoNeural" } },
      }),
    ).not.toThrow();
  });

  it("合成只使用绑定当前最新素材的动态片段，并通过 assetId 保留原图许可与来源", () => {
    const sourceDefaults = {
      provider: null,
      author: null,
      license: null,
      sourceUrl: null,
      licenseUrl: null,
      attributionText: null,
      requiresAttribution: null,
    };
    const snapshots = payloadModule.selectComposeAssetSnapshots(
      [
        {
          ...sourceDefaults,
          id: "asset-ai-new",
          shotId: 1,
          filePath: "/api/files/project/shot-1-new.png",
          type: "ai_generated",
          createdAt: new Date("2026-07-17T08:00:20.000Z"),
        },
        {
          ...sourceDefaults,
          id: "asset-stock-old",
          shotId: 1,
          filePath: "/api/files/project/shot-1-stock.jpg",
          type: "stock_footage",
          provider: "openverse",
          author: "Alice",
          license: "CC BY 4.0",
          sourceUrl: "https://media.example/stock-1",
          licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
          attributionText: "Alice / CC BY 4.0",
          requiresAttribution: true,
          createdAt: new Date("2026-07-17T08:00:00.000Z"),
        },
        {
          ...sourceDefaults,
          id: "asset-shot-2",
          shotId: 2,
          filePath: "/api/files/project/shot-2.png",
          type: "ai_generated",
          createdAt: new Date("2026-07-17T08:00:05.000Z"),
        },
      ],
      [
        {
          id: "clip-failed-newer",
          shotId: 1,
          assetId: "asset-ai-new",
          filePath: "/api/files/project/failed.mp4",
          status: "failed",
          createdAt: new Date("2026-07-17T08:00:40.000Z"),
        },
        {
          id: "clip-success-latest",
          shotId: 1,
          assetId: "asset-stock-old",
          filePath: "/api/files/project/shot-1-motion.mp4",
          status: "done",
          createdAt: new Date("2026-07-17T08:00:30.000Z"),
        },
        {
          id: "clip-success-old",
          shotId: 1,
          assetId: "asset-ai-new",
          filePath: "/api/files/project/shot-1-old-motion.mp4",
          status: "done",
          createdAt: new Date("2026-07-17T08:00:10.000Z"),
        },
      ],
    );

    expect(snapshots.find((asset) => asset.shotId === 1)).toEqual({
      id: "asset-ai-new",
      shotId: 1,
      fileRef: "/api/files/project/shot-1-old-motion.mp4",
      type: "ai_generated",
      provider: null,
      author: null,
      license: null,
      sourceUrl: null,
      licenseUrl: null,
      attributionText: null,
      requiresAttribution: null,
    });
    expect(snapshots.find((asset) => asset.shotId === 2)?.fileRef).toBe(
      "/api/files/project/shot-2.png",
    );
  });

  it("buildComposeJobPayload 忽略绑定旧素材的动态片段，冻结当前新图", async () => {
    const merchantId = createMerchant("compose-motion-asset");
    const projectId = createProject(merchantId, "动态素材合成");
    dbModule.db.insert(schema.scripts).values({
      projectId,
      styleType: "scene",
      selected: true,
      shots: [
        {
          shotId: 1,
          type: "hook",
          duration: 3,
          description: "展示商品",
          camera: "static",
          visualSource: "ai_generate",
          transition: "direct_concat",
          voiceover: "测试旁白",
          prompt: "原图 prompt",
        },
      ],
    }).run();
    dbModule.db.insert(schema.assets).values([
      {
        id: "asset-license-source",
        projectId,
        shotId: 1,
        type: "stock_footage",
        filePath: `/api/files/${projectId}/source.jpg`,
        provider: "openverse",
        author: "Alice",
        license: "CC BY 4.0",
        sourceUrl: "https://media.example/source",
        status: "done",
        createdAt: new Date("2026-07-17T08:00:00.000Z"),
      },
      {
        id: "asset-newer-image",
        projectId,
        shotId: 1,
        type: "ai_generated",
        filePath: `/api/files/${projectId}/newer.png`,
        status: "done",
        createdAt: new Date("2026-07-17T08:00:10.000Z"),
      },
    ]).run();
    const clipRef = `/api/files/${projectId}/motion.mp4`;
    const projectUploadDir = join(dataDir, "uploads", projectId);
    mkdirSync(projectUploadDir, { recursive: true });
    writeFileSync(join(projectUploadDir, "motion.mp4"), "motion");
    writeFileSync(join(projectUploadDir, "newer.png"), "new current frame");
    dbModule.db.insert(schema.videoClips).values({
      projectId,
      shotId: 1,
      assetId: "asset-license-source",
      filePath: clipRef,
      status: "done",
      createdAt: new Date("2026-07-17T08:00:20.000Z"),
    }).run();

    const built = await payloadModule.buildComposeJobPayload(merchantId, projectId, {});
    expect(built.payload.assets).toContainEqual(expect.objectContaining({
      id: "asset-newer-image",
      shotId: 1,
      fileRef: `/api/files/${projectId}/newer.png`,
      type: "ai_generated",
    }));
    expect(built.payload.assets).not.toContainEqual(expect.objectContaining({ fileRef: clipRef }));
  });

  it("持久失败原因不泄露 FFmpeg 整条命令、主机绝对路径或 JSON 密钥", () => {
    const commandError = repository.sanitizeJobError(
      new Error(
        'Command failed: "/opt/homebrew/bin/ffmpeg" -i "/Users/operator/private/uploads/project/asset.png" "\u89d2\u8272\u6587\u6848"',
      ),
    );
    expect(commandError).toContain("视频合成工具执行失败");
    expect(commandError).not.toContain("ffmpeg");
    expect(commandError).not.toContain("/Users/");
    expect(commandError).not.toContain("角色文案");

    const providerError = repository.sanitizeJobError(
      new Error('provider {"apiKey":"top-secret","access_token":"second-secret"} /tmp/private.log'),
    );
    expect(providerError).toContain("[REDACTED]");
    expect(providerError).toContain("[LOCAL_PATH]");
    expect(providerError).not.toContain("top-secret");
    expect(providerError).not.toContain("second-secret");
    expect(providerError).not.toContain("/tmp/private.log");
  });

  it("同一 Idempotency-Key 只创建一个 job/composition，账号最多 2 个未完成任务", () => {
    const merchantId = createMerchant("idempotency");
    const projectId = createProject(merchantId, "幂等与限流");
    const first = enqueue(merchantId, projectId, "compose-key-0001");
    const duplicate = enqueue(merchantId, projectId, "compose-key-0001");
    expect(duplicate.duplicate).toBe(true);
    expect(duplicate.job.id).toBe(first.job.id);
    expect(duplicate.composition.id).toBe(first.composition.id);

    enqueue(merchantId, projectId, "compose-key-0002");
    expect(() => enqueue(merchantId, projectId, "compose-key-0003")).toThrow(
      repository.JobQueueLimitError,
    );
    expect(dbModule.db.select().from(schema.jobs).all()).toHaveLength(2);
    expect(dbModule.db.select().from(schema.compositions).all()).toHaveLength(2);
  });

  it("全局最多 20 个未完成任务，不会在限流失败时留下孤儿 composition", () => {
    for (let index = 0; index < 10; index += 1) {
      const merchantId = createMerchant(`global-${index}`);
      const projectId = createProject(merchantId, `全局队列 ${index}`);
      enqueue(merchantId, projectId, `global-${index}-a`);
      enqueue(merchantId, projectId, `global-${index}-b`);
    }
    const overflowMerchant = createMerchant("global-overflow");
    const overflowProject = createProject(overflowMerchant, "全局超限");
    expect(() => enqueue(overflowMerchant, overflowProject, "global-overflow-key")).toThrow(
      repository.JobQueueLimitError,
    );
    expect(dbModule.db.select().from(schema.jobs).all()).toHaveLength(20);
    expect(dbModule.db.select().from(schema.compositions).all()).toHaveLength(20);
  });

  it("全局严格并发 1，lease token 防 ABA，失败原因持久且脱敏", () => {
    const merchantId = createMerchant("lease");
    const projectId = createProject(merchantId, "租约与串行");
    const first = enqueue(merchantId, projectId, "lease-key-0001");
    const second = enqueue(merchantId, projectId, "lease-key-0002");
    const startedAt = new Date(Date.now() + 1_000);

    const claimed = repository.claimNextJob("worker-a", startedAt);
    expect(claimed?.id).toBe(first.job.id);
    expect(claimed?.attempts).toBe(1);
    expect(claimed?.leaseExpiresAt?.getTime()).toBe(
      Math.floor((startedAt.getTime() + repository.JOB_LEASE_MS) / 1_000) * 1_000,
    );
    expect(repository.claimNextJob("worker-b", startedAt)).toBeNull();
    expect(repository.heartbeatJob(claimed!.id, "worker-a", "stale-token", startedAt)).toBe(false);
    expect(() =>
      repository.completeComposeJob(
        claimed!.id,
        "worker-a",
        "stale-token",
        { outputPath: "/tmp/stale.mp4", credits: [], paidTtsUsed: false },
        new Date(startedAt.getTime() + 1_000),
      ),
    ).toThrow(repository.JobLeaseLostError);

    expect(
      repository.heartbeatJob(
        claimed!.id,
        "worker-a",
        claimed!.leaseToken!,
        new Date(startedAt.getTime() + 30_000),
      ),
    ).toBe(true);
    repository.completeComposeJob(
      claimed!.id,
      "worker-a",
      claimed!.leaseToken!,
      { outputPath: "/tmp/final-first.mp4", credits: [], paidTtsUsed: false },
      new Date(startedAt.getTime() + 31_000),
    );

    const claimedSecond = repository.claimNextJob(
      "worker-b",
      new Date(startedAt.getTime() + 32_000),
    );
    expect(claimedSecond?.id).toBe(second.job.id);
    expect(
      repository.failClaimedJob(
        claimedSecond!.id,
        "worker-b",
        claimedSecond!.leaseToken!,
        new Error("provider failed api_key=super-secret access_token=another-secret"),
        new Date(startedAt.getTime() + 33_000),
      ),
    ).toBe(true);
    const failed = repository.getJobByCompositionId(second.composition.id);
    expect(failed).toMatchObject({ status: "failed", errorCode: "COMPOSE_FAILED" });
    expect(failed?.errorMessage).toContain("[REDACTED]");
    expect(failed?.errorMessage).not.toContain("super-secret");
    expect(failed?.errorMessage).not.toContain("another-secret");
  });

  it("进程崩溃/重启后只自动恢复一次，第二次过期持久失败", () => {
    const merchantId = createMerchant("restart");
    const projectId = createProject(merchantId, "crash recovery");
    const queued = enqueue(merchantId, projectId, "restart-key-001");
    const firstStart = new Date(Date.now() + 1_000);
    const firstClaim = repository.claimNextJob("worker-before-crash", firstStart)!;

    // 模拟旧进程消失：新进程只靠 DB 租约恢复，不依赖内存。
    expect(() =>
      repository.completeComposeJob(
        firstClaim.id,
        "worker-before-crash",
        firstClaim.leaseToken!,
        { outputPath: "/tmp/expired.mp4", credits: [], paidTtsUsed: false },
        new Date(firstStart.getTime() + repository.JOB_LEASE_MS + 1),
      ),
    ).toThrow(repository.JobLeaseLostError);
    const firstRecovery = repository.recoverExpiredJobs(
      new Date(firstStart.getTime() + repository.JOB_LEASE_MS + 1),
    );
    expect(firstRecovery).toEqual({ requeued: [queued.job.id], failed: [] });
    expect(repository.getJobByCompositionId(queued.composition.id)).toMatchObject({
      status: "pending",
      attempts: 1,
      errorCode: "LEASE_EXPIRED_RETRY",
    });

    const secondStart = new Date(firstStart.getTime() + repository.JOB_LEASE_MS + 2);
    const secondClaim = repository.claimNextJob("worker-after-restart", secondStart)!;
    expect(secondClaim.attempts).toBe(2);
    expect(secondClaim.leaseToken).not.toBe(firstClaim.leaseToken);
    // 旧 worker 即使“复活”也无权覆盖新租约。
    expect(
      repository.failClaimedJob(
        secondClaim.id,
        "worker-before-crash",
        firstClaim.leaseToken!,
        new Error("stale process"),
        new Date(secondStart.getTime() + 1),
      ),
    ).toBe(false);

    const secondRecovery = repository.recoverExpiredJobs(
      new Date(secondStart.getTime() + repository.JOB_LEASE_MS + 1),
    );
    expect(secondRecovery).toEqual({ requeued: [], failed: [queued.job.id] });
    expect(repository.getJobByCompositionId(queued.composition.id)).toMatchObject({
      status: "failed",
      attempts: 2,
      errorCode: "LEASE_EXPIRED",
      errorMessage: "任务执行进程中断，自动恢复次数已用完，请重新发起合成",
    });
  });

  it("待执行任务可持久取消且不再 claim；running 任务拒绝假取消", () => {
    const merchantId = createMerchant("cancel");
    const projectId = createProject(merchantId, "取消语义");
    const queued = enqueue(merchantId, projectId, "cancel-key-0001");
    const cancelled = repository.cancelPendingComposeJob(
      merchantId,
      projectId,
      queued.composition.id,
    );
    expect(cancelled).toMatchObject({ cancelled: true, job: { status: "cancelled" } });
    expect(repository.claimNextJob("worker-after-cancel")).toBeNull();
    // 取消后不占用账号的 2 个 unfinished 槽位。
    enqueue(merchantId, projectId, "cancel-key-0002");
    enqueue(merchantId, projectId, "cancel-key-0003");
    const running = repository.claimNextJob("worker-running")!;
    expect(() =>
      repository.cancelPendingComposeJob(merchantId, projectId, running.compositionId!),
    ).toThrow(repository.JobCancellationConflictError);
  });

  it("纯 FFmpeg / free TTS 不建额度流水；agentTts 入队原子预占 1 次且重放不重复扣", () => {
    const merchantId = createMerchant("compose-quota-kind");
    const projectId = createProject(merchantId, "合成额度能力判定");
    const ffmpegOnly = enqueue(merchantId, projectId, "compose-free-0001");
    const freeTts = enqueue(merchantId, projectId, "compose-free-0002", { ttsEnabled: true });
    expect(ffmpegOnly.job.generationUsageId).toBeNull();
    expect(freeTts.job.generationUsageId).toBeNull();
    expect(dbModule.db.select().from(schema.generationUsage).all()).toHaveLength(0);

    // 先把两个免费任务结算，释放账号 active job 槽位。
    for (const queued of [ffmpegOnly, freeTts]) {
      const claimed = repository.claimNextJob(`free-${queued.job.id}`)!;
      repository.completeComposeJob(
        claimed.id,
        `free-${queued.job.id}`,
        claimed.leaseToken!,
        { outputPath: `/tmp/${queued.job.id}.mp4`, credits: [], paidTtsUsed: false },
      );
    }

    const paid = enqueue(merchantId, projectId, "compose-paid-0001", { paidTtsRequested: true });
    const duplicate = enqueue(merchantId, projectId, "compose-paid-0001", { paidTtsRequested: true });
    expect(paid.job.generationUsageId).toBeTruthy();
    expect(duplicate.job.id).toBe(paid.job.id);
    expect(duplicate.job.generationUsageId).toBe(paid.job.generationUsageId);
    const ledgers = dbModule.db.select().from(schema.generationUsage).all();
    expect(ledgers).toHaveLength(1);
    expect(ledgers[0]).toMatchObject({
      operationType: "compose-paid-tts",
      operationKey: "compose-paid-0001",
      status: "running",
      success: true,
    });
  });

  it("compose 同 key 换冻结 payload 返回 409；额度不足时 job/composition/ledger 同事务全回滚", () => {
    const merchantId = createMerchant("compose-hash");
    const projectId = createProject(merchantId, "合成请求哈希");
    enqueue(merchantId, projectId, "compose-hash-0001", {
      paidTtsRequested: true,
      payloadMarker: "first",
    });
    expect(() => enqueue(merchantId, projectId, "compose-hash-0001", {
      paidTtsRequested: true,
      payloadMarker: "changed",
    })).toThrow(repository.IdempotencyConflictError);
    expect(dbModule.db.select().from(schema.jobs).all()).toHaveLength(1);
    expect(dbModule.db.select().from(schema.generationUsage).all()).toHaveLength(1);

    // 清空本例后用 0 额度商家验证「预占 + job + composition」没有半成品。
    dbModule.db.delete(schema.jobs).run();
    dbModule.db.delete(schema.compositions).run();
    dbModule.db.delete(schema.projects).run();
    dbModule.db.delete(schema.merchants).run();
    const planId = `zero-${crypto.randomUUID()}`;
    dbModule.db.insert(schema.plans).values({ id: planId, name: "零额度", monthlyGenerationQuota: 0 }).run();
    const zeroMerchant = dbModule.db.insert(schema.merchants).values({
      email: `zero-${crypto.randomUUID()}@example.com`,
      passwordHash: "salt:hash",
      planId,
    }).returning({ id: schema.merchants.id }).all()[0].id;
    const zeroProject = createProject(zeroMerchant, "零额度原子回滚");
    expect(() => enqueue(zeroMerchant, zeroProject, "compose-zero-0001", { paidTtsRequested: true }))
      .toThrow(usageModule.QuotaExceededError);
    expect(dbModule.db.select().from(schema.jobs).all()).toHaveLength(0);
    expect(dbModule.db.select().from(schema.compositions).all()).toHaveLength(0);
    expect(dbModule.db.select().from(schema.generationUsage).all()).toHaveLength(0);
  });

  it("pending 取消、成功但未用付费 TTS、失败且未用付费 TTS都会释放父额度", () => {
    const merchantId = createMerchant("compose-release");
    const projectId = createProject(merchantId, "合成额度释放");

    const cancelled = enqueue(merchantId, projectId, "compose-release-0001", { paidTtsRequested: true });
    repository.cancelPendingComposeJob(merchantId, projectId, cancelled.composition.id);

    const noPaidSuccess = enqueue(merchantId, projectId, "compose-release-0002", { paidTtsRequested: true });
    const successClaim = repository.claimNextJob("worker-no-paid-success")!;
    expect(successClaim.id).toBe(noPaidSuccess.job.id);
    repository.completeComposeJob(
      successClaim.id,
      "worker-no-paid-success",
      successClaim.leaseToken!,
      { outputPath: "/tmp/no-paid.mp4", credits: [], paidTtsUsed: false },
    );

    const noPaidFailure = enqueue(merchantId, projectId, "compose-release-0003", { paidTtsRequested: true });
    const failClaim = repository.claimNextJob("worker-no-paid-fail")!;
    expect(failClaim.id).toBe(noPaidFailure.job.id);
    expect(repository.failClaimedJob(
      failClaim.id,
      "worker-no-paid-fail",
      failClaim.leaseToken!,
      new Error("ffmpeg failed"),
    )).toBe(true);

    const ledgers = dbModule.db.select().from(schema.generationUsage)
      .where(eq(schema.generationUsage.merchantId, merchantId)).all();
    expect(ledgers).toHaveLength(3);
    expect(ledgers.every((row) => row.status === "failed" && row.success === false)).toBe(true);
  });

  it("至少一段付费 TTS 落盘留证后，即使 compose 最终失败也只占 1 次额度", () => {
    const merchantId = createMerchant("compose-paid-used");
    const projectId = createProject(merchantId, "付费 TTS 实际使用");
    const queued = enqueue(merchantId, projectId, "compose-paid-used-0001", { paidTtsRequested: true });
    const claimed = repository.claimNextJob("worker-paid")!;
    expect(claimed.id).toBe(queued.job.id);
    expect(repository.markJobPaidTtsUsed(
      claimed.id,
      "worker-paid",
      claimed.leaseToken!,
    )).toBe(true);
    expect(repository.failClaimedJob(
      claimed.id,
      "worker-paid",
      claimed.leaseToken!,
      new Error("ffmpeg failed after paid audio"),
    )).toBe(true);
    const [ledger] = dbModule.db.select().from(schema.generationUsage)
      .where(eq(schema.generationUsage.id, queued.job.generationUsageId!)).all();
    expect(ledger).toMatchObject({ status: "succeeded", success: true, succeededItems: 1 });
    expect(dbModule.db.select().from(schema.generationUsage)
      .where(eq(schema.generationUsage.merchantId, merchantId)).all()).toHaveLength(1);
  });

  it("stale lease token 不能标记付费或结算额度；最终租约失败按 DB paidTtsUsed 结算", () => {
    const merchantId = createMerchant("compose-stale-settle");
    const projectId = createProject(merchantId, "旧租约禁止结算");
    const queued = enqueue(merchantId, projectId, "compose-stale-0001", { paidTtsRequested: true });
    const startedAt = new Date(Date.now() + 1_000);
    const first = repository.claimNextJob("worker-first", startedAt)!;
    expect(repository.markJobPaidTtsUsed(first.id, "worker-first", "stale-token", startedAt)).toBe(false);
    expect(repository.failClaimedJob(
      first.id,
      "worker-first",
      "stale-token",
      new Error("stale"),
      new Date(startedAt.getTime() + 1_000),
    )).toBe(false);
    let [ledger] = dbModule.db.select().from(schema.generationUsage)
      .where(eq(schema.generationUsage.id, queued.job.generationUsageId!)).all();
    expect(ledger).toMatchObject({ status: "running", success: true, completedItems: 0 });

    repository.recoverExpiredJobs(new Date(startedAt.getTime() + repository.JOB_LEASE_MS + 1));
    const secondStart = new Date(startedAt.getTime() + repository.JOB_LEASE_MS + 2);
    const second = repository.claimNextJob("worker-second", secondStart)!;
    expect(repository.markJobPaidTtsUsed(
      second.id,
      "worker-second",
      second.leaseToken!,
      new Date(secondStart.getTime() + 1_000),
    )).toBe(true);
    repository.recoverExpiredJobs(new Date(secondStart.getTime() + repository.JOB_LEASE_MS + 1));
    [ledger] = dbModule.db.select().from(schema.generationUsage)
      .where(eq(schema.generationUsage.id, queued.job.generationUsageId!)).all();
    expect(ledger).toMatchObject({ status: "succeeded", success: true, completedItems: 1 });
  });

  it("启动清理只失败化无 job 的历史孤儿 composition，job 是唯一恢复权威", () => {
    const merchantId = createMerchant("sweep");
    const projectId = createProject(merchantId, "orphan sweep");
    const protectedTask = enqueue(merchantId, projectId, "sweep-key-0001");
    const orphan = dbModule.db
      .insert(schema.compositions)
      .values({
        projectId,
        status: "composing",
        aigcDisclosure: true,
        createdAt: new Date("2020-01-01T00:00:00.000Z"),
      })
      .returning()
      .all()[0];

    const swept = dbModule.sweepStaleOrphanCompositions(
      Math.floor(Date.now() / 1000) + 60,
    );
    expect(swept).toBe(1);
    expect(
      dbModule.db
        .select()
        .from(schema.compositions)
        .where(eq(schema.compositions.id, orphan.id))
        .all()[0].status,
    ).toBe("failed");
    expect(
      dbModule.db
        .select()
        .from(schema.compositions)
        .where(eq(schema.compositions.id, protectedTask.composition.id))
        .all()[0].status,
    ).toBe("pending");
  });
});
