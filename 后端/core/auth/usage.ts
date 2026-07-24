import "server-only";

import { createHash, randomUUID } from "crypto";
import { and, eq, gt, gte, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import { getDb } from "@backend/db";
import {
  generationOperationItems,
  generationUsage,
  merchants,
  motionVideoJobs,
  plans,
} from "@backend/db/schema";
import { runAgentOperation } from "@backend/core/agent/agent-strategy";
import type { AgentId } from "@server/admin/agents/types";
import { ProviderError, toSafeProviderErrorDto } from "@backend/providers/base";

const MAX_OPERATION_ITEMS = 64;
const MAX_BATCH_OPERATION_ITEMS = 9;
const MAX_STORED_RESULT_BYTES = 512 * 1024;
export const GENERATION_PENDING_DEADLINE_MS = 30 * 60_000;
export const GENERATION_ITEM_LEASE_MS = 120_000;
export const GENERATION_ITEM_HEARTBEAT_MS = 30_000;
const IDEMPOTENCY_RE = /^[A-Za-z0-9._:-]+$/;

export type GenerationOperationStatus = "reserved" | "running" | "succeeded" | "partial" | "failed";

export interface GenerationManifestItem {
  itemKey: string;
  agentId: AgentId;
}

export interface CreateGenerationOperationInput {
  merchantId: string;
  projectId?: string | null;
  operationKey: string;
  operationType: string;
  agentId: AgentId;
  requestHash: string;
  items: readonly GenerationManifestItem[];
}

export interface GenerationOperationSummary {
  operationId: string;
  status: GenerationOperationStatus;
  expectedItems: number;
  completedItems: number;
  succeededItems: number;
  failedItems: number;
  duplicate: boolean;
}

export type GenerationUsageTransaction = Parameters<
  Parameters<ReturnType<typeof getDb>["transaction"]>[0]
>[0];

export interface ReservedGenerationOperation {
  usageId: string;
  summary: GenerationOperationSummary;
}

/** 配额用尽；路由的 catch 块应特判这个类型，返回 402 而不是通用 500。 */
export class QuotaExceededError extends Error {
  constructor() {
    super("本月生成额度已用完，请联系客服升级套餐");
    this.name = "QuotaExceededError";
  }
}

export class InvalidGenerationOperationError extends Error {
  constructor(message = "生成操作参数不合法") {
    super(message);
    this.name = "InvalidGenerationOperationError";
  }
}

export class GenerationOperationConflictError extends Error {
  constructor(message = "operationId 已用于另一组生成任务，请重新发起") {
    super(message);
    this.name = "GenerationOperationConflictError";
  }
}

export class GenerationItemInProgressError extends Error {
  constructor() {
    super("该生成项正在处理中，请稍后重试查询结果");
    this.name = "GenerationItemInProgressError";
  }
}

export class GenerationItemFailedError extends Error {
  readonly failureCode: string;

  constructor(failureCode = "generation_failed") {
    super("该生成项此前已失败；如需重试，请重新点击生成");
    this.name = "GenerationItemFailedError";
    this.failureCode = failureCode;
  }
}

export class GenerationItemLeaseLostError extends Error {
  constructor() {
    super("生成任务租约已失效，迟到结果已被丢弃，请重新发起生成");
    this.name = "GenerationItemLeaseLostError";
  }
}

function startOfCurrentMonth(now = new Date()): Date {
  return new Date(now.getFullYear(), now.getMonth(), 1);
}

function normalizeKey(value: string, label: string, minLength: number): string {
  const normalized = value.trim();
  if (
    normalized.length < minLength ||
    normalized.length > 128 ||
    !IDEMPOTENCY_RE.test(normalized)
  ) {
    throw new InvalidGenerationOperationError(`${label} 必须为 ${minLength}-128 位字母、数字或 ._:-`);
  }
  return normalized;
}

export function normalizeGenerationOperationKey(value: string): string {
  return normalizeKey(value, "operationId", 8);
}

export function normalizeGenerationItemKey(value: string): string {
  return normalizeKey(value, "itemKey", 1);
}

function normalizeOperationType(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 80 || !IDEMPOTENCY_RE.test(normalized)) {
    throw new InvalidGenerationOperationError("operationType 不合法");
  }
  return normalized;
}

function normalizeProjectId(value: string | null | undefined): string | null {
  if (value == null) return null;
  return normalizeKey(value, "projectId", 1);
}

function stableHashValue(value: unknown, seen: WeakSet<object>): unknown {
  if (value === undefined) return null;
  if (value == null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) throw new InvalidGenerationOperationError("请求包含循环引用");
  seen.add(value);
  if (Array.isArray(value)) {
    const result = value.map((item) => stableHashValue(item, seen));
    seen.delete(value);
    return result;
  }
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    result[key] = stableHashValue((value as Record<string, unknown>)[key], seen);
  }
  seen.delete(value);
  return result;
}

/** 对明确的安全业务 DTO 做稳定 SHA-256；调用方不得把 AgentRuntimeConfig/凭据放进 DTO。 */
export function hashGenerationRequest(value: unknown): string {
  const canonical = JSON.stringify(stableHashValue(value, new WeakSet()));
  return createHash("sha256").update(canonical).digest("hex");
}

function normalizeRequestHash(value: string, label: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    throw new InvalidGenerationOperationError(`${label} 必须为 SHA-256`);
  }
  return normalized;
}

function normalizeManifest(items: readonly GenerationManifestItem[]): GenerationManifestItem[] {
  if (items.length === 0 || items.length > MAX_OPERATION_ITEMS) {
    throw new InvalidGenerationOperationError(`生成项数量必须在 1-${MAX_OPERATION_ITEMS} 之间`);
  }
  const normalized = items.map((item) => ({
    itemKey: normalizeGenerationItemKey(item.itemKey),
    agentId: item.agentId,
  }));
  if (new Set(normalized.map((item) => item.itemKey)).size !== normalized.length) {
    throw new InvalidGenerationOperationError("itemKey 不得重复");
  }
  return normalized.sort((left, right) => left.itemKey.localeCompare(right.itemKey));
}

const SHOT_ITEM_RE = /^shot:(?:0|[1-9]\d{0,8})$/;
const PACK_ITEM_RE = /^pack:[0-8]$/;

/**
 * 数量、item schema 和 Agent 均由服务端固定。新增工作流必须在这里显式登记，
 * 不允许客户端用未知 operationType 把一个父额度扩展成任意数量的付费调用。
 */
function assertOperationPolicy(
  operationType: string,
  projectId: string | null,
  parentAgentId: AgentId,
  items: readonly GenerationManifestItem[],
): void {
  const allAgent = (agentId: AgentId) => items.every((item) => item.agentId === agentId);
  const exactKeys = (expected: readonly string[]) =>
    items.length === expected.length && expected.every((key) => items.some((item) => item.itemKey === key));

  if (operationType === "image-batch") {
    if (
      !projectId || parentAgentId !== "imageAgent" || !allAgent("imageAgent") ||
      items.length > MAX_BATCH_OPERATION_ITEMS ||
      !items.every((item) => SHOT_ITEM_RE.test(item.itemKey) || PACK_ITEM_RE.test(item.itemKey)) ||
      (items.some((item) => SHOT_ITEM_RE.test(item.itemKey)) && items.some((item) => PACK_ITEM_RE.test(item.itemKey)))
    ) throw new InvalidGenerationOperationError("图片批量任务必须绑定项目、且最多包含 9 个同类生成项");
    return;
  }
  if (operationType === "video-batch") {
    if (
      !projectId || parentAgentId !== "videoAgent" || !allAgent("videoAgent") ||
      items.length > MAX_BATCH_OPERATION_ITEMS || !items.every((item) => SHOT_ITEM_RE.test(item.itemKey))
    ) throw new InvalidGenerationOperationError("视频批量任务必须绑定项目、且最多包含 9 个分镜");
    return;
  }
  if (operationType === "image-single") {
    if (
      !projectId || parentAgentId !== "imageAgent" || !allAgent("imageAgent") || items.length !== 1 ||
      !items.every((item) => item.itemKey === "single" || SHOT_ITEM_RE.test(item.itemKey) || PACK_ITEM_RE.test(item.itemKey))
    ) throw new InvalidGenerationOperationError("单图生成只能绑定当前项目的 1 个生成项");
    return;
  }
  if (operationType === "video-single") {
    if (
      !projectId || parentAgentId !== "videoAgent" || !allAgent("videoAgent") || items.length !== 1 ||
      !items.every((item) => item.itemKey === "single" || SHOT_ITEM_RE.test(item.itemKey))
    ) throw new InvalidGenerationOperationError("单视频生成只能绑定当前项目的 1 个分镜");
    return;
  }
  if (operationType === "script-workflow") {
    const valid = parentAgentId === "script" && items.length <= 2 &&
      (exactKeys(["script"]) || exactKeys(["analysis", "script"])) &&
      items.every((item) =>
        (item.itemKey === "script" && item.agentId === "script") ||
        (item.itemKey === "analysis" && item.agentId === "product-analysis")
      );
    if (!valid) throw new InvalidGenerationOperationError("脚本工作流只允许 script 与可选 analysis 子项");
    return;
  }
  if (operationType === "compose-paid-tts") {
    if (parentAgentId !== "ttsAgent" || !allAgent("ttsAgent") || !exactKeys(["paid-tts"])) {
      throw new InvalidGenerationOperationError("合成付费配音工作流只允许单一 TTS 子项");
    }
    return;
  }
  if (operationType.startsWith("single:") && items.length === 1 && items[0]?.itemKey === "single" &&
      items[0]?.agentId === parentAgentId) return;
  throw new InvalidGenerationOperationError("未登记的生成工作流类型");
}

function sameManifest(
  stored: readonly { itemKey: string; agentId: string }[],
  requested: readonly GenerationManifestItem[],
) {
  if (stored.length !== requested.length) return false;
  const left = [...stored].sort((a, b) => a.itemKey.localeCompare(b.itemKey));
  return left.every(
    (item, index) => item.itemKey === requested[index]?.itemKey && item.agentId === requested[index]?.agentId,
  );
}

function toSummary(
  row: typeof generationUsage.$inferSelect,
  duplicate: boolean,
): GenerationOperationSummary {
  return {
    operationId: row.operationKey || row.id,
    status: row.status,
    expectedItems: row.expectedItems,
    completedItems: row.completedItems,
    succeededItems: row.succeededItems,
    failedItems: row.failedItems,
    duplicate,
  };
}

function refreshGenerationUsageSummaryInTransaction(
  tx: GenerationUsageTransaction,
  usageId: string,
  now = new Date(),
): GenerationOperationStatus {
  const counts = tx
    .select({ status: generationOperationItems.status, count: sql<number>`count(*)` })
    .from(generationOperationItems)
    .where(eq(generationOperationItems.usageId, usageId))
    .groupBy(generationOperationItems.status)
    .all();
  const countOf = (status: "pending" | "running" | "succeeded" | "failed") =>
    Number(counts.find((row) => row.status === status)?.count ?? 0);
  const succeeded = countOf("succeeded");
  const failed = countOf("failed");
  const completed = succeeded + failed;
  const expected = completed + countOf("pending") + countOf("running");
  const status: GenerationOperationStatus = completed < expected
    ? "running"
    : succeeded === 0
      ? "failed"
      : failed > 0
        ? "partial"
        : "succeeded";
  tx.update(generationUsage)
    .set({
      success: status !== "failed",
      status,
      expectedItems: expected,
      completedItems: completed,
      succeededItems: succeeded,
      failedItems: failed,
      updatedAt: now,
    })
    .where(eq(generationUsage.id, usageId))
    .run();
  return status;
}

/**
 * 普通图片/视频/脚本调用无法在进程崩溃后证明供应商是否已接单，
 * 因此过期 running 子项一律 fail-closed，禁止自动重提付费请求。用户可用新 operationId 重试。
 */
export function recoverStaleGenerationItems(now = new Date()): number {
  const db = getDb();
  const pendingCutoff = new Date(now.getTime() - GENERATION_PENDING_DEADLINE_MS);
  return db.transaction((tx) => {
    const expired = tx
      .update(generationOperationItems)
      .set({
        status: "failed",
        result: null,
        failureCode: "execution_deadline_expired",
        leaseToken: null,
        leaseExpiresAt: null,
        completedAt: now,
        updatedAt: now,
      })
      .where(and(
        inArray(generationOperationItems.status, ["pending", "running"]),
        // compose-paid-tts 的生命周期由 jobs lease 状态机结算，不得被这里回收。
        sql`${generationOperationItems.usageId} IN (
          SELECT ${generationUsage.id} FROM ${generationUsage}
          WHERE ${generationUsage.operationType} <> 'compose-paid-tts'
        )`,
        // 持久 motion job 与历史同步 video-batch 共用 operationType，不能按名字一刀切。
        // 只排除真正被 motion_video_jobs 引用的 item；已有 taskId 时保留 GET 恢复能力。
        sql`${generationOperationItems.id} NOT IN (
          SELECT ${motionVideoJobs.generationItemId} FROM ${motionVideoJobs}
          WHERE ${motionVideoJobs.generationItemId} IS NOT NULL
        )`,
        or(
          lte(generationOperationItems.leaseExpiresAt, now),
          and(
            isNull(generationOperationItems.leaseExpiresAt),
            lt(generationOperationItems.updatedAt, pendingCutoff),
          ),
        ),
      ))
      .returning({ usageId: generationOperationItems.usageId })
      .all();
    for (const usageId of new Set(expired.map((row) => row.usageId))) {
      refreshGenerationUsageSummaryInTransaction(tx, usageId, now);
    }
    return expired.length;
  });
}

/**
 * 释放只创建了 manifest、却从未真正开始任何子项的陈旧预占。
 * 已进入 running 的长视频调用不会被这里误杀；同 operationId 仍保持终态幂等，重试需新建操作。
 */
function expireStaleReservations(now = new Date()): void {
  const db = getDb();
  const cutoff = new Date(now.getTime() - GENERATION_PENDING_DEADLINE_MS);
  db.transaction((tx) => {
    const stale = tx
      .select({ id: generationUsage.id, expectedItems: generationUsage.expectedItems })
      .from(generationUsage)
      .where(
        and(
          eq(generationUsage.status, "reserved"),
          eq(generationUsage.completedItems, 0),
          lt(generationUsage.updatedAt, cutoff),
        ),
      )
      .all();
    if (!stale.length) return;
    const ids = stale.map((row) => row.id);
    tx.update(generationOperationItems)
      .set({ status: "failed", failureCode: "reservation_expired", completedAt: now, updatedAt: now })
      .where(
        and(
          inArray(generationOperationItems.usageId, ids),
          eq(generationOperationItems.status, "pending"),
        ),
      )
      .run();
    for (const row of stale) {
      tx.update(generationUsage)
        .set({
          success: false,
          status: "failed",
          completedItems: row.expectedItems,
          succeededItems: 0,
          failedItems: row.expectedItems,
          updatedAt: now,
        })
        .where(eq(generationUsage.id, row.id))
        .run();
    }
  });
}

/**
 * 为一次用户动作原子地预占一个额度并创建完整子项 manifest。
 * 同商家 + operationId 重放只返回原记录；manifest 或父流程类型不同则 409，绝不暗中追加子项。
 */
export function createGenerationOperation(input: CreateGenerationOperationInput): GenerationOperationSummary {
  recoverStaleGenerationItems();
  expireStaleReservations();
  return getDb().transaction((tx) => createGenerationOperationInTransaction(tx, input).summary);
}

/**
 * 供 job 入队等需要跨表原子性的调用方使用；调用方负责在自己的 transaction 中调用。
 * 不在这里开启嵌套事务，也不返回/保存任何请求明文或凭据。
 */
export function createGenerationOperationInTransaction(
  tx: GenerationUsageTransaction,
  input: CreateGenerationOperationInput,
  now = new Date(),
): ReservedGenerationOperation {
  const operationKey = normalizeGenerationOperationKey(input.operationKey);
  const operationType = normalizeOperationType(input.operationType);
  const projectId = normalizeProjectId(input.projectId);
  const items = normalizeManifest(input.items);
  assertOperationPolicy(operationType, projectId, input.agentId, items);
  const requestHash = normalizeRequestHash(input.requestHash, "requestHash");
  const manifestHash = hashGenerationRequest(items);
    const existing = tx
      .select()
      .from(generationUsage)
      .where(
        and(
          eq(generationUsage.merchantId, input.merchantId),
          eq(generationUsage.operationType, operationType),
          eq(generationUsage.operationKey, operationKey),
        ),
      )
      .all()[0];
    if (existing) {
      const storedItems = tx
        .select({ itemKey: generationOperationItems.itemKey, agentId: generationOperationItems.agentId })
        .from(generationOperationItems)
        .where(eq(generationOperationItems.usageId, existing.id))
        .all();
      if (
        existing.operationType !== operationType ||
        existing.projectId !== projectId ||
        existing.agentId !== input.agentId ||
        existing.requestHash !== requestHash ||
        existing.manifestHash !== manifestHash ||
        !sameManifest(storedItems, items)
      ) {
        throw new GenerationOperationConflictError();
      }
      return { usageId: existing.id, summary: toSummary(existing, true) };
    }

    const quotaRow = tx
      .select({ quota: plans.monthlyGenerationQuota, bonus: merchants.quotaBonus })
      .from(merchants)
      .innerJoin(plans, eq(merchants.planId, plans.id))
      .where(eq(merchants.id, input.merchantId))
      .all()[0];
    const quota = (quotaRow?.quota ?? 0) + (quotaRow?.bonus ?? 0);
    const used = Number(
      tx
        .select({ count: sql<number>`count(*)` })
        .from(generationUsage)
        .where(
          and(
            eq(generationUsage.merchantId, input.merchantId),
            eq(generationUsage.success, true),
            gte(generationUsage.createdAt, startOfCurrentMonth()),
          ),
        )
        .all()[0]?.count ?? 0,
    );
    if (used >= quota) throw new QuotaExceededError();

    const row = tx
      .insert(generationUsage)
      .values({
        merchantId: input.merchantId,
        projectId,
        agentId: input.agentId,
        operationKey,
        operationType,
        requestHash,
        manifestHash,
        status: "reserved",
        success: true,
        expectedItems: items.length,
        completedItems: 0,
        succeededItems: 0,
        failedItems: 0,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .all()[0];
    if (!row) throw new Error("生成额度预占失败");
    tx.insert(generationOperationItems)
      .values(
        items.map((item) => ({
          usageId: row.id,
          itemKey: item.itemKey,
          agentId: item.agentId,
          status: "pending" as const,
          // pending 也有最终截止时间：请求在 claim 前崩溃时不会永久占额度。
          leaseExpiresAt: operationType === "compose-paid-tts"
            ? null
            : new Date(now.getTime() + GENERATION_PENDING_DEADLINE_MS),
          createdAt: now,
          updatedAt: now,
        })),
      )
      .run();
    return { usageId: row.id, summary: toSummary(row, false) };
}

/** job claim 后把父额度/唯一子项推进 running；重复恢复不会新增流水或增加子调用数。 */
export function markGenerationOperationRunningInTransaction(
  tx: GenerationUsageTransaction,
  usageId: string,
  now = new Date(),
): void {
  const usage = tx.select().from(generationUsage).where(eq(generationUsage.id, usageId)).all()[0];
  if (!usage || usage.status === "succeeded" || usage.status === "partial" || usage.status === "failed") return;
  tx.update(generationOperationItems)
    .set({
      status: "running",
      requestHash: usage.requestHash,
      attempts: sql`CASE WHEN ${generationOperationItems.status} = 'pending' THEN ${generationOperationItems.attempts} + 1 ELSE ${generationOperationItems.attempts} END`,
      startedAt: sql`COALESCE(${generationOperationItems.startedAt}, ${Math.floor(now.getTime() / 1000)})`,
      updatedAt: now,
    })
    .where(
      and(
        eq(generationOperationItems.usageId, usageId),
        inArray(generationOperationItems.status, ["pending", "running"]),
      ),
    )
    .run();
  tx.update(generationUsage)
    .set({ status: "running", updatedAt: now })
    .where(eq(generationUsage.id, usageId))
    .run();
}

/**
 * 与 job 的 lease 条件终态更新放在同一事务调用：paid capability 实际产出才占额度；
 * 未产出（含取消/全失败/最终租约失败）写 failed 并把 success=false 释放额度。
 */
export function settleGenerationOperationInTransaction(
  tx: GenerationUsageTransaction,
  usageId: string,
  paidCapabilityUsed: boolean,
  failureCodeValue: string,
  now = new Date(),
): void {
  const usage = tx.select().from(generationUsage).where(eq(generationUsage.id, usageId)).all()[0];
  if (!usage || usage.status === "succeeded" || usage.status === "partial" || usage.status === "failed") return;
  tx.update(generationOperationItems)
    .set({
      status: paidCapabilityUsed ? "succeeded" : "failed",
      result: paidCapabilityUsed ? { paidCapabilityUsed: true } : null,
      failureCode: paidCapabilityUsed ? null : failureCodeValue.slice(0, 100),
      requestHash: usage.requestHash,
      completedAt: now,
      updatedAt: now,
    })
    .where(eq(generationOperationItems.usageId, usageId))
    .run();
  tx.update(generationUsage)
    .set({
      success: paidCapabilityUsed,
      status: paidCapabilityUsed ? "succeeded" : "failed",
      completedItems: 1,
      succeededItems: paidCapabilityUsed ? 1 : 0,
      failedItems: paidCapabilityUsed ? 0 : 1,
      updatedAt: now,
    })
    .where(eq(generationUsage.id, usageId))
    .run();
}

type ItemClaim =
  | { kind: "execute"; usageId: string; itemId: string; leaseToken: string }
  | { kind: "replay"; result: unknown };

function claimGenerationItem(
  merchantId: string,
  operationKey: string,
  operationType: string,
  itemKey: string,
  agentId: AgentId,
  projectId: string | null,
  requestHash: string,
): ItemClaim {
  const db = getDb();
  const now = new Date();
  return db.transaction((tx) => {
    const usage = tx
      .select()
      .from(generationUsage)
      .where(
        and(
          eq(generationUsage.merchantId, merchantId),
          eq(generationUsage.operationType, operationType),
          eq(generationUsage.operationKey, operationKey),
        ),
      )
      .all()[0];
    if (!usage) throw new InvalidGenerationOperationError("生成操作不存在，请重新点击生成");
    if (usage.projectId !== projectId) {
      throw new GenerationOperationConflictError("生成操作与当前项目不一致，请重新发起");
    }
    const item = tx
      .select()
      .from(generationOperationItems)
      .where(
        and(
          eq(generationOperationItems.usageId, usage.id),
          eq(generationOperationItems.itemKey, itemKey),
        ),
      )
      .all()[0];
    if (!item || item.agentId !== agentId) throw new GenerationOperationConflictError("生成项与 manifest 不一致");
    if (item.requestHash && item.requestHash !== requestHash) {
      throw new GenerationOperationConflictError("同一 itemKey 的请求内容已变化，请重新发起生成");
    }
    if (item.status === "succeeded") return { kind: "replay", result: item.result };
    if (item.status === "failed") throw new GenerationItemFailedError(item.failureCode || "generation_failed");
    if (item.status === "running") throw new GenerationItemInProgressError();
    if (usage.status === "failed" || usage.status === "partial" || usage.status === "succeeded") {
      throw new GenerationOperationConflictError("生成操作已经结束，请重新点击生成");
    }
    const leaseToken = randomUUID();
    const claimed = tx
      .update(generationOperationItems)
      .set({
        status: "running",
        requestHash,
        attempts: sql`${generationOperationItems.attempts} + 1`,
        leaseToken,
        leaseExpiresAt: new Date(now.getTime() + GENERATION_ITEM_LEASE_MS),
        startedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(generationOperationItems.id, item.id),
          eq(generationOperationItems.status, "pending"),
        ),
      )
      .returning({ id: generationOperationItems.id })
      .all()[0];
    if (!claimed) throw new GenerationItemInProgressError();
    tx.update(generationUsage)
      .set({ status: "running", updatedAt: now })
      .where(eq(generationUsage.id, usage.id))
      .run();
    return { kind: "execute", usageId: usage.id, itemId: item.id, leaseToken };
  });
}

function heartbeatGenerationItem(itemId: string, leaseToken: string, now = new Date()): boolean {
  return getDb()
    .update(generationOperationItems)
    .set({ leaseExpiresAt: new Date(now.getTime() + GENERATION_ITEM_LEASE_MS), updatedAt: now })
    .where(and(
      eq(generationOperationItems.id, itemId),
      eq(generationOperationItems.status, "running"),
      eq(generationOperationItems.leaseToken, leaseToken),
      gt(generationOperationItems.leaseExpiresAt, now),
    ))
    .returning({ id: generationOperationItems.id })
    .all().length === 1;
}

function failureCode(error: unknown): string {
  if (error instanceof ProviderError) {
    const codes: Record<ProviderError["category"], string> = {
      safety: "safety",
      billing: "billing",
      auth: "configuration",
      rate_limit: "rate_limit",
      invalid_input: "invalid_input",
      configuration: "configuration",
      provider_5xx: "provider_5xx",
      timeout: "timeout",
      network: "network",
      unknown: "generation_failed",
    };
    return codes[error.category];
  }
  const raw = error instanceof Error ? `${error.name} ${error.message}` : String(error ?? "");
  if (/safety|moderation|sensitive|安全|内容审核|肖像保护|InputImageSensitiveContentDetected/i.test(raw)) return "safety";
  if (/\b429\b|rate.?limit|too many requests|限流|频繁/i.test(raw)) return "rate_limit";
  if (/timeout|timed out|AbortError|ETIMEDOUT|超时/i.test(raw)) return "timeout";
  if (/ECONN|ENOTFOUND|EAI_AGAIN|fetch failed|network|网络|连接失败/i.test(raw)) return "network";
  if (/\b401\b|\b403\b|unauthorized|forbidden|api.?key|凭据|密钥/i.test(raw)) return "configuration";
  if (/\b5\d\d\b|server error|bad gateway|service unavailable/i.test(raw)) return "provider_5xx";
  return "generation_failed";
}

function completeGenerationItem(
  usageId: string,
  itemId: string,
  leaseToken: string,
  outcome: { ok: true; result: unknown } | { ok: false; failureCode: string },
): void {
  const db = getDb();
  const now = new Date();
  db.transaction((tx) => {
    const updated = tx
      .update(generationOperationItems)
      .set(
        outcome.ok
          ? {
              status: "succeeded", result: outcome.result, failureCode: null,
              leaseToken: null, leaseExpiresAt: null, completedAt: now, updatedAt: now,
            }
          : {
              status: "failed", result: null, failureCode: outcome.failureCode,
              leaseToken: null, leaseExpiresAt: null, completedAt: now, updatedAt: now,
            },
      )
      .where(
        and(
          eq(generationOperationItems.id, itemId),
          eq(generationOperationItems.usageId, usageId),
          eq(generationOperationItems.status, "running"),
          eq(generationOperationItems.leaseToken, leaseToken),
          gt(generationOperationItems.leaseExpiresAt, now),
        ),
      )
      .returning({ id: generationOperationItems.id })
      .all()[0];
    if (!updated) throw new GenerationItemLeaseLostError();
    refreshGenerationUsageSummaryInTransaction(tx, usageId, now);
  });
}

export interface FailGenerationItemBeforeClaimOptions {
  operationKey: string;
  operationType: string;
  itemKey: string;
  agentId: AgentId;
  projectId?: string | null;
  failureCode?: string;
}

/**
 * manifest 已预占、但子路由在供应商 claim 前就拒绝请求时，显式将 pending 收口。
 * 只能结算同商家、同项目、同类型、同 Agent 的既定 item，不能追加或跨项目操作。
 */
export function failGenerationOperationItemBeforeClaim(
  merchantId: string,
  options: FailGenerationItemBeforeClaimOptions,
): boolean {
  recoverStaleGenerationItems();
  const operationKey = normalizeGenerationOperationKey(options.operationKey);
  const operationType = normalizeOperationType(options.operationType);
  const itemKey = normalizeGenerationItemKey(options.itemKey);
  const projectId = normalizeProjectId(options.projectId);
  const code = (options.failureCode || "request_rejected").replace(/[^a-z0-9_:-]/gi, "_").slice(0, 100);
  return getDb().transaction((tx) => {
    const usage = tx.select().from(generationUsage).where(and(
      eq(generationUsage.merchantId, merchantId),
      eq(generationUsage.operationType, operationType),
      eq(generationUsage.operationKey, operationKey),
    )).all()[0];
    if (!usage || usage.projectId !== projectId) return false;
    const item = tx.select().from(generationOperationItems).where(and(
      eq(generationOperationItems.usageId, usage.id),
      eq(generationOperationItems.itemKey, itemKey),
    )).all()[0];
    if (!item || item.agentId !== options.agentId) return false;
    if (item.status === "failed") return true;
    if (item.status !== "pending") return false;
    const failed = tx.update(generationOperationItems).set({
      status: "failed",
      result: null,
      failureCode: code || "request_rejected",
      leaseToken: null,
      leaseExpiresAt: null,
      completedAt: new Date(),
      updatedAt: new Date(),
    }).where(and(
      eq(generationOperationItems.id, item.id),
      eq(generationOperationItems.status, "pending"),
    )).returning({ id: generationOperationItems.id }).all()[0];
    if (!failed) return false;
    refreshGenerationUsageSummaryInTransaction(tx, usage.id);
    return true;
  });
}

const FORBIDDEN_RESULT_KEY = /^(?:apiKey|api_key|authorization|accessToken|access_token|token|secret|password|credential|privateKey|private_key|session|cookie|baseUrl|base_url|groupId|group_id)$/i;

function redactSecretText(value: string): string {
  return value
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
    .replace(/(authorization\s*[:=]\s*(?:bearer|key)?\s*)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/((?:api[_-]?key|access[_-]?token|secret|password)\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/\b(?:sk|key)-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]");
}

function sanitizeResultValue(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === "string") return redactSecretText(value);
  if (value == null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) throw new InvalidGenerationOperationError("生成结果包含循环引用，无法安全保存");
  seen.add(value);
  if (Array.isArray(value)) {
    const result = value.map((item) => sanitizeResultValue(item, seen));
    seen.delete(value);
    return result;
  }
  const output: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_RESULT_KEY.test(key)) continue;
    output[key] = sanitizeResultValue(nested, seen);
  }
  seen.delete(value);
  return output;
}

/** 生成项幂等结果只保存公开响应，统一脱敏且限制体积。 */
export function sanitizeGenerationResult(value: unknown): unknown {
  const sanitized = sanitizeResultValue(value, new WeakSet());
  const serialized = JSON.stringify(sanitized);
  if (Buffer.byteLength(serialized, "utf8") > MAX_STORED_RESULT_BYTES) {
    throw new InvalidGenerationOperationError("生成结果过大，无法安全保存幂等结果");
  }
  return serialized === undefined ? null : JSON.parse(serialized) as unknown;
}

/** 对外错误只返回分类后的固定文案，避免供应商 SDK 把 Authorization/API Key 回显给浏览器。 */
export function safeGenerationErrorMessage(error: unknown, fallback = "生成失败，请稍后重试"): string {
  if (error instanceof QuotaExceededError || error instanceof InvalidGenerationOperationError ||
      error instanceof GenerationOperationConflictError || error instanceof GenerationItemInProgressError ||
      error instanceof GenerationItemFailedError || error instanceof GenerationItemLeaseLostError) {
    return redactSecretText(error.message);
  }
  if (error instanceof ProviderError) {
    return toSafeProviderErrorDto(error, fallback).message;
  }
  const code = failureCode(error);
  const messages: Record<string, string> = {
    safety: "素材未通过模型安全校验，请更换素材后重试",
    billing: "模型服务额度不足，请联系工作人员处理",
    rate_limit: "模型服务当前较忙，请稍后重试",
    invalid_input: "当前素材或参数不符合模型要求，请调整后重试",
    timeout: "模型生成超时，请稍后重试",
    network: "模型服务网络异常，请稍后重试",
    configuration: "模型策略暂不可用，请联系工作人员",
    provider_5xx: "模型服务暂时异常，请稍后重试",
  };
  return messages[code] ?? fallback;
}

export interface RunGenerationItemOptions {
  operationKey: string;
  operationType: string;
  itemKey: string;
  agentId: AgentId;
  projectId?: string | null;
  userLabel: string;
  /** 只对本子项的安全业务 DTO 求 SHA-256，防止同 key 换 payload 后误回放。 */
  requestHash: string;
  /** 开启后将公开响应持久化，重复 itemKey 直接回放而不再调用供应商。 */
  persistResult?: boolean;
}

/**
 * 执行 manifest 的一个子项。同 itemKey 成功重放会返回已保存结果；running/failed 不会再次调用供应商。
 * 如果父 manifest 尚不存在（单张按钮），自动创建只有这一项的父操作，因此单张仍计 1 次。
 */
export async function runGenerationOperationItem<T>(
  merchantId: string,
  options: RunGenerationItemOptions,
  operation: Parameters<typeof runAgentOperation<T>>[2],
): Promise<{ value: T; replayed: boolean; operationId: string }> {
  const operationKey = normalizeGenerationOperationKey(options.operationKey);
  const operationType = normalizeOperationType(options.operationType);
  const itemKey = normalizeGenerationItemKey(options.itemKey);
  const projectId = normalizeProjectId(options.projectId);
  const requestHash = normalizeRequestHash(options.requestHash, "item requestHash");
  recoverStaleGenerationItems();
  const db = getDb();
  const existing = db
    .select({ id: generationUsage.id })
    .from(generationUsage)
    .where(and(
      eq(generationUsage.merchantId, merchantId),
      eq(generationUsage.operationType, operationType),
      eq(generationUsage.operationKey, operationKey),
    ))
    .all()[0];
  if (!existing) {
    createGenerationOperation({
      merchantId,
      projectId,
      operationKey,
      operationType,
      agentId: options.agentId,
      requestHash,
      items: [{ itemKey, agentId: options.agentId }],
    });
  }

  const claim = claimGenerationItem(
    merchantId,
    operationKey,
    operationType,
    itemKey,
    options.agentId,
    projectId,
    requestHash,
  );
  if (claim.kind === "replay") {
    return { value: claim.result as T, replayed: true, operationId: operationKey };
  }

  let leaseLost = false;
  const heartbeat = setInterval(() => {
    try {
      if (!heartbeatGenerationItem(claim.itemId, claim.leaseToken)) leaseLost = true;
    } catch {
      leaseLost = true;
    }
  }, GENERATION_ITEM_HEARTBEAT_MS);
  heartbeat.unref?.();
  try {
    const value = await runAgentOperation(options.agentId, options.userLabel, operation);
    if (leaseLost) throw new GenerationItemLeaseLostError();
    const persisted = options.persistResult ? sanitizeGenerationResult(value) : null;
    completeGenerationItem(claim.usageId, claim.itemId, claim.leaseToken, { ok: true, result: persisted });
    return {
      value: (options.persistResult ? persisted : value) as T,
      replayed: false,
      operationId: operationKey,
    };
  } catch (error) {
    if (!(error instanceof GenerationItemLeaseLostError)) {
      completeGenerationItem(
        claim.usageId,
        claim.itemId,
        claim.leaseToken,
        { ok: false, failureCode: failureCode(error) },
      );
    }
    throw error;
  } finally {
    clearInterval(heartbeat);
  }
}

/**
 * 把已经由本商家项目缓存命中的公开结果写成一个完成子项，不经过 Agent 策略、更不会调用供应商。
 * 仍走相同 claim/requestHash/回放规则，保证脚本工作流在「视觉分析命中缓存」时也能完整收口。
 */
export function completeGenerationOperationItemFromCache<T>(
  merchantId: string,
  options: Omit<RunGenerationItemOptions, "userLabel" | "persistResult">,
  value: T,
): { value: T; replayed: boolean; operationId: string } {
  const operationKey = normalizeGenerationOperationKey(options.operationKey);
  const operationType = normalizeOperationType(options.operationType);
  const itemKey = normalizeGenerationItemKey(options.itemKey);
  const projectId = normalizeProjectId(options.projectId);
  const requestHash = normalizeRequestHash(options.requestHash, "item requestHash");
  recoverStaleGenerationItems();
  const claim = claimGenerationItem(
    merchantId,
    operationKey,
    operationType,
    itemKey,
    options.agentId,
    projectId,
    requestHash,
  );
  if (claim.kind === "replay") {
    return { value: claim.result as T, replayed: true, operationId: operationKey };
  }
  try {
    const persisted = sanitizeGenerationResult(value) as T;
    completeGenerationItem(claim.usageId, claim.itemId, claim.leaseToken, { ok: true, result: persisted });
    return { value: persisted, replayed: false, operationId: operationKey };
  } catch (error) {
    if (!(error instanceof GenerationItemLeaseLostError)) {
      completeGenerationItem(
        claim.usageId,
        claim.itemId,
        claim.leaseToken,
        { ok: false, failureCode: failureCode(error) },
      );
    }
    throw error;
  }
}

/**
 * 兼容现有单 Agent 路由：每次调用自动建立一个单项父流程。新批处理应显式预创建 manifest，
 * 再调用 runGenerationOperationItem，避免 N 个模型子调用被误记成 N 次商户额度。
 */
export async function runMeteredAgentOperation<T>(
  merchantId: string,
  agentId: AgentId,
  userLabel: string,
  operation: Parameters<typeof runAgentOperation<T>>[2],
): Promise<T> {
  const operationKey = `single:${crypto.randomUUID()}`;
  const operationType = `single:${agentId}`;
  const result = await runGenerationOperationItem(
    merchantId,
    {
      operationKey,
      operationType,
      itemKey: "single",
      agentId,
      userLabel,
      requestHash: hashGenerationRequest({ operationType, userLabel }),
      persistResult: false,
    },
    operation,
  );
  return result.value;
}
