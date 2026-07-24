import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { and, eq } from "drizzle-orm";

const mocks = vi.hoisted(() => ({ runAgentOperation: vi.fn() }));

vi.mock("@backend/core/agent/agent-strategy", () => ({
  runAgentOperation: mocks.runAgentOperation,
}));

describe("workflow-level 商家生成配额", () => {
  let dataDir: string;
  let db: ReturnType<typeof import("@backend/db").getDb>;
  let schema: typeof import("@backend/db/schema");
  let usage: typeof import("@backend/core/auth/usage");
  let serial = 0;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "huimai-workflow-quota-test-"));
    process.env.APP_DATA_DIR = dataDir;
    usage = await import("@backend/core/auth/usage");
    const dbModule = await import("@backend/db");
    schema = await import("@backend/db/schema");
    db = dbModule.getDb();
  });

  beforeEach(() => {
    mocks.runAgentOperation.mockReset();
    mocks.runAgentOperation.mockImplementation(async (_agentId, _label, operation) =>
      operation(
        { provider: "openai-compatible", baseUrl: "https://safe.example/v1", apiKey: "test-key", model: "test-model" },
        "test-prompt",
        false,
      )
    );
  });

  afterAll(() => {
    delete process.env.APP_DATA_DIR;
    rmSync(dataDir, { recursive: true, force: true });
  });

  async function createMerchant(quota: number) {
    serial += 1;
    const planId = `quota-plan-${serial}`;
    await db.insert(schema.plans).values({ id: planId, name: `限额 ${quota}`, monthlyGenerationQuota: quota });
    const [merchant] = await db
      .insert(schema.merchants)
      .values({ email: `quota-${serial}@example.com`, passwordHash: "salt:hash", planId })
      .returning();
    return merchant.id;
  }

  function createManifest(
    merchantId: string,
    operationKey: string,
    itemKeys: string[],
    request: unknown = { projectId: "project-1", itemKeys },
  ) {
    return usage.createGenerationOperation({
      merchantId,
      projectId: "project-1",
      operationKey,
      operationType: "image-batch",
      agentId: "imageAgent",
      requestHash: usage.hashGenerationRequest(request),
      items: itemKeys.map((itemKey) => ({ itemKey, agentId: "imageAgent" as const })),
    });
  }

  function runImageItem<T>(
    merchantId: string,
    operationKey: string,
    itemKey: string,
    request: unknown,
    operation: Parameters<typeof usage.runGenerationOperationItem<T>>[2],
  ) {
    return usage.runGenerationOperationItem(merchantId, {
      operationKey,
      operationType: "image-batch",
      itemKey,
      agentId: "imageAgent",
      projectId: "project-1",
      userLabel: itemKey,
      requestHash: usage.hashGenerationRequest(request),
      persistResult: true,
    }, operation);
  }

  it("兼容单项包装：失败不占额度，成功占 1，配额边界前原子拦截", async () => {
    const merchantId = await createMerchant(2);
    mocks.runAgentOperation.mockRejectedValueOnce(new Error("模拟模型调用失败"));
    await expect(
      usage.runMeteredAgentOperation(merchantId, "script", "failed", async () => "unused"),
    ).rejects.toThrow("模拟模型调用失败");
    await expect(usage.runMeteredAgentOperation(merchantId, "script", "one", async () => "one")).resolves.toBe("one");
    await expect(usage.runMeteredAgentOperation(merchantId, "script", "two", async () => "two")).resolves.toBe("two");
    await expect(
      usage.runMeteredAgentOperation(merchantId, "script", "three", async () => "three"),
    ).rejects.toBeInstanceOf(usage.QuotaExceededError);

    const rows = await db.select().from(schema.generationUsage)
      .where(eq(schema.generationUsage.merchantId, merchantId));
    expect(rows.filter((row) => row.success)).toHaveLength(2);
    expect(rows.filter((row) => !row.success)).toHaveLength(1);
  });

  it("同一 manifest 重放不重复扣；同 key 换父请求或 manifest 会冲突", async () => {
    const merchantId = await createMerchant(1);
    const first = createManifest(merchantId, "image-batch:duplicate", ["shot:1", "shot:2"]);
    const replay = createManifest(merchantId, "image-batch:duplicate", ["shot:1", "shot:2"]);
    expect(first.duplicate).toBe(false);
    expect(replay.duplicate).toBe(true);
    expect(() => createManifest(
      merchantId,
      "image-batch:duplicate",
      ["shot:1", "shot:2"],
      { projectId: "different" },
    )).toThrow(usage.GenerationOperationConflictError);
    expect(() => createManifest(
      merchantId,
      "image-batch:duplicate",
      ["shot:1", "shot:3"],
    )).toThrow(usage.GenerationOperationConflictError);

    const rows = await db.select().from(schema.generationUsage)
      .where(eq(schema.generationUsage.merchantId, merchantId));
    expect(rows).toHaveLength(1);
  });

  it("9 个分镜执行 9 次 provider，但父流程只占 1 次商户额度", async () => {
    const merchantId = await createMerchant(1);
    const itemKeys = Array.from({ length: 9 }, (_, index) => `shot:${index + 1}`);
    createManifest(merchantId, "image-batch:nine-shots", itemKeys);

    for (const itemKey of itemKeys) {
      await runImageItem(
        merchantId,
        "image-batch:nine-shots",
        itemKey,
        { prompt: itemKey },
        async () => ({ imageUrls: [`https://cdn.example/${itemKey}.png`] }),
      );
    }

    expect(mocks.runAgentOperation).toHaveBeenCalledTimes(9);
    const [parent] = await db.select().from(schema.generationUsage)
      .where(eq(schema.generationUsage.merchantId, merchantId));
    expect(parent).toMatchObject({
      status: "succeeded",
      success: true,
      expectedItems: 9,
      completedItems: 9,
      succeededItems: 9,
      failedItems: 0,
    });
    const children = await db.select().from(schema.generationOperationItems)
      .where(eq(schema.generationOperationItems.usageId, parent.id));
    expect(children).toHaveLength(9);
    expect(children.every((item) => item.status === "succeeded" && item.attempts === 1)).toBe(true);
    expect(() => createManifest(merchantId, "image-batch:over-quota", ["shot:1"]))
      .toThrow(usage.QuotaExceededError);
  });

  it("同 itemKey 成功重放直接返回已存安全 DTO，不再调用 provider；换 payload 会 409", async () => {
    const merchantId = await createMerchant(1);
    createManifest(merchantId, "image-batch:item-replay", ["shot:1"]);
    const first = await runImageItem(
      merchantId,
      "image-batch:item-replay",
      "shot:1",
      { prompt: "same" },
      async () => ({ imageUrls: ["https://cdn.example/one.png"] }),
    );
    const replay = await runImageItem(
      merchantId,
      "image-batch:item-replay",
      "shot:1",
      { prompt: "same" },
      async () => ({ imageUrls: ["https://cdn.example/should-not-run.png"] }),
    );
    expect(first.replayed).toBe(false);
    expect(replay).toMatchObject({ replayed: true, value: first.value });
    expect(mocks.runAgentOperation).toHaveBeenCalledTimes(1);
    await expect(runImageItem(
      merchantId,
      "image-batch:item-replay",
      "shot:1",
      { prompt: "changed" },
      async () => ({ imageUrls: [] }),
    )).rejects.toBeInstanceOf(usage.GenerationOperationConflictError);
    expect(mocks.runAgentOperation).toHaveBeenCalledTimes(1);
  });

  it("并发重复 item 只有首个请求能进入 provider，第二个得到 in-progress", async () => {
    const merchantId = await createMerchant(1);
    createManifest(merchantId, "video-batch:concurrent", ["shot:1"]);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let providerCalls = 0;
    const first = runImageItem(
      merchantId,
      "video-batch:concurrent",
      "shot:1",
      { prompt: "same" },
      async () => {
        providerCalls += 1;
        await gate;
        return { imageUrls: ["https://cdn.example/concurrent.png"] };
      },
    );
    await vi.waitFor(() => expect(providerCalls).toBe(1));
    await expect(runImageItem(
      merchantId,
      "video-batch:concurrent",
      "shot:1",
      { prompt: "same" },
      async () => ({ imageUrls: [] }),
    )).rejects.toBeInstanceOf(usage.GenerationItemInProgressError);
    expect(providerCalls).toBe(1);
    release();
    await expect(first).resolves.toMatchObject({ replayed: false });
  });

  it("全失败释放父额度，原 operationId 终态不重跑；新操作可以继续预占", async () => {
    const merchantId = await createMerchant(1);
    createManifest(merchantId, "image-batch:all-failed", ["shot:1", "shot:2"]);
    for (const itemKey of ["shot:1", "shot:2"]) {
      await expect(runImageItem(
        merchantId,
        "image-batch:all-failed",
        itemKey,
        { prompt: itemKey },
        async () => { throw new Error("provider failed"); },
      )).rejects.toThrow("provider failed");
    }
    const [failed] = await db.select().from(schema.generationUsage).where(and(
      eq(schema.generationUsage.merchantId, merchantId),
      eq(schema.generationUsage.operationKey, "image-batch:all-failed"),
    ));
    expect(failed).toMatchObject({ status: "failed", success: false, failedItems: 2, completedItems: 2 });
    await expect(runImageItem(
      merchantId,
      "image-batch:all-failed",
      "shot:1",
      { prompt: "shot:1" },
      async () => ({ imageUrls: [] }),
    )).rejects.toBeInstanceOf(usage.GenerationItemFailedError);
    expect(() => createManifest(merchantId, "image-batch:after-failure", ["shot:1"]))
      .not.toThrow();
  });

  it("部分成功按 1 次计费并封账为 partial，不能借失败子项释放额度", async () => {
    const merchantId = await createMerchant(1);
    createManifest(merchantId, "image-batch:partial", ["shot:1", "shot:2"]);
    await runImageItem(
      merchantId,
      "image-batch:partial",
      "shot:1",
      { prompt: "one" },
      async () => ({ imageUrls: ["https://cdn.example/one.png"] }),
    );
    await expect(runImageItem(
      merchantId,
      "image-batch:partial",
      "shot:2",
      { prompt: "two" },
      async () => { throw new Error("provider failed"); },
    )).rejects.toThrow("provider failed");
    const [parent] = await db.select().from(schema.generationUsage).where(and(
      eq(schema.generationUsage.merchantId, merchantId),
      eq(schema.generationUsage.operationKey, "image-batch:partial"),
    ));
    expect(parent).toMatchObject({
      status: "partial",
      success: true,
      succeededItems: 1,
      failedItems: 1,
      completedItems: 2,
    });
    expect(() => createManifest(merchantId, "image-batch:no-slot", ["shot:1"]))
      .toThrow(usage.QuotaExceededError);
  });

  it("幂等结果入库前深度删除凭据字段并脱敏可疑字符串", async () => {
    const merchantId = await createMerchant(1);
    createManifest(merchantId, "image-batch:redaction", ["shot:1"]);
    const result = await runImageItem(
      merchantId,
      "image-batch:redaction",
      "shot:1",
      { prompt: "redact" },
      async () => ({
        imageUrls: ["https://cdn.example/safe.png"],
        apiKey: "super-secret",
        nested: {
          authorization: "Bearer secret-token",
          password: "secret-password",
          note: "api_key=another-secret",
        },
      }),
    );
    expect(result.value).toEqual({
      imageUrls: ["https://cdn.example/safe.png"],
      nested: { note: "api_key=[REDACTED]" },
    });
    const [stored] = await db.select().from(schema.generationOperationItems)
      .where(eq(schema.generationOperationItems.itemKey, "shot:1"));
    expect(JSON.stringify(stored.result)).not.toMatch(/super-secret|secret-token|secret-password|another-secret/);
  });

  it("服务端强制批量最多 9 项、固定 item schema/Agent，且子项不得跨项目 claim", async () => {
    const merchantId = await createMerchant(3);
    expect(() => createManifest(
      merchantId,
      "image-batch:too-many",
      Array.from({ length: 10 }, (_, index) => `shot:${index + 1}`),
    )).toThrow(usage.InvalidGenerationOperationError);
    expect(() => createManifest(
      merchantId,
      "image-batch:mixed-schema",
      ["shot:1", "pack:0"],
    )).toThrow(usage.InvalidGenerationOperationError);
    expect(() => usage.createGenerationOperation({
      merchantId,
      projectId: "project-1",
      operationKey: "image-batch:wrong-agent",
      operationType: "image-batch",
      agentId: "imageAgent",
      requestHash: usage.hashGenerationRequest({ projectId: "project-1" }),
      items: [{ itemKey: "shot:1", agentId: "videoAgent" }],
    })).toThrow(usage.InvalidGenerationOperationError);

    createManifest(merchantId, "image-batch:project-frozen", ["shot:1"]);
    await expect(usage.runGenerationOperationItem(merchantId, {
      operationKey: "image-batch:project-frozen",
      operationType: "image-batch",
      itemKey: "shot:1",
      agentId: "imageAgent",
      projectId: "project-2",
      userLabel: "cross-project",
      requestHash: usage.hashGenerationRequest({ prompt: "same" }),
      persistResult: true,
    }, async () => ({ imageUrls: ["https://cdn.example/forbidden.png"] })))
      .rejects.toBeInstanceOf(usage.GenerationOperationConflictError);
    expect(mocks.runAgentOperation).not.toHaveBeenCalled();
  });

  it("claim 前拒绝也会收口 item；全失败父流水立即释放额度", async () => {
    const merchantId = await createMerchant(1);
    createManifest(merchantId, "image-batch:preclaim-failed", ["shot:1", "shot:2"]);
    for (const itemKey of ["shot:1", "shot:2"]) {
      expect(usage.failGenerationOperationItemBeforeClaim(merchantId, {
        operationKey: "image-batch:preclaim-failed",
        operationType: "image-batch",
        itemKey,
        agentId: "imageAgent",
        projectId: "project-1",
        failureCode: "invalid_request",
      })).toBe(true);
    }
    const [parent] = await db.select().from(schema.generationUsage).where(and(
      eq(schema.generationUsage.merchantId, merchantId),
      eq(schema.generationUsage.operationKey, "image-batch:preclaim-failed"),
    ));
    expect(parent).toMatchObject({ status: "failed", success: false, completedItems: 2, failedItems: 2 });
    expect(() => createManifest(merchantId, "image-batch:after-preclaim-failure", ["shot:1"]))
      .not.toThrow();
  });

  it("过期 running 子项 fail-closed 且迟到结果不能回写，同 operation 不自动重提供应商", async () => {
    const merchantId = await createMerchant(1);
    createManifest(merchantId, "video-batch:lease-expired", ["shot:1"]);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    const running = runImageItem(
      merchantId,
      "video-batch:lease-expired",
      "shot:1",
      { prompt: "paid-submit-once" },
      async () => {
        calls += 1;
        await gate;
        return { imageUrls: ["https://cdn.example/late.png"] };
      },
    );
    await vi.waitFor(() => expect(calls).toBe(1));
    expect(usage.recoverStaleGenerationItems(
      new Date(Date.now() + usage.GENERATION_ITEM_LEASE_MS + 2_000),
    )).toBe(1);
    release();
    await expect(running).rejects.toBeInstanceOf(usage.GenerationItemLeaseLostError);
    await expect(runImageItem(
      merchantId,
      "video-batch:lease-expired",
      "shot:1",
      { prompt: "paid-submit-once" },
      async () => ({ imageUrls: ["https://cdn.example/must-not-run.png"] }),
    )).rejects.toBeInstanceOf(usage.GenerationItemFailedError);
    expect(calls).toBe(1);
    const [parent] = await db.select().from(schema.generationUsage).where(and(
      eq(schema.generationUsage.merchantId, merchantId),
      eq(schema.generationUsage.operationKey, "video-batch:lease-expired"),
    ));
    expect(parent).toMatchObject({ status: "failed", success: false, failedItems: 1 });
  });

  it("进程在下一个 item claim 前中断时，pending 截止时间会最终收口并释放全失败额度", async () => {
    const merchantId = await createMerchant(1);
    createManifest(merchantId, "image-batch:pending-deadline", ["shot:1", "shot:2"]);
    await expect(runImageItem(
      merchantId,
      "image-batch:pending-deadline",
      "shot:1",
      { prompt: "first-fails" },
      async () => { throw new Error("provider failed"); },
    )).rejects.toThrow("provider failed");

    expect(usage.recoverStaleGenerationItems(
      new Date(Date.now() + usage.GENERATION_PENDING_DEADLINE_MS + 2_000),
    )).toBeGreaterThanOrEqual(1);
    const [parent] = await db.select().from(schema.generationUsage).where(and(
      eq(schema.generationUsage.merchantId, merchantId),
      eq(schema.generationUsage.operationKey, "image-batch:pending-deadline"),
    ));
    expect(parent).toMatchObject({ status: "failed", success: false, completedItems: 2, failedItems: 2 });
    expect(() => createManifest(merchantId, "image-batch:after-pending-deadline", ["shot:1"]))
      .not.toThrow();
  });

  it("对外/日志安全错误不回显供应商凭据", () => {
    const message = usage.safeGenerationErrorMessage(
      new Error("provider failed Authorization: Bearer sk-top-secret api_key=another-secret"),
    );
    expect(message).not.toMatch(/sk-top-secret|another-secret/);
    expect(message).toBe("模型策略暂不可用，请联系工作人员");
  });

  it("ProviderError 优先使用结构化分类生成固定安全文案", async () => {
    const { ProviderError } = await import("@backend/providers/base");
    expect(usage.safeGenerationErrorMessage(new ProviderError(
      "upstream Authorization: Bearer sk-must-not-leak",
      "AUTH_FAILED",
      "probe",
      401,
      { category: "auth" },
    ))).toBe("模型服务鉴权失败，请联系工作人员检查配置");
    expect(usage.safeGenerationErrorMessage(new ProviderError(
      "insufficient balance sk-must-not-leak",
      "BILLING_REQUIRED",
      "probe",
      402,
      { category: "billing" },
    ))).toBe("模型服务额度不足，请联系工作人员处理");
  });
});
