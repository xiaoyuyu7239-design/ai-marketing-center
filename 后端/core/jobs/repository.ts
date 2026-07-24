import "server-only";

import { randomUUID } from "node:crypto";
import { and, asc, eq, gt, inArray, isNull, lt, lte, or } from "drizzle-orm";
import { getDb } from "@backend/db";
import { compositions, jobs, projects } from "@backend/db/schema";
import type { MediaCredit } from "@backend/core/publish/media-credit-types";
import {
  createGenerationOperationInTransaction,
  hashGenerationRequest,
  markGenerationOperationRunningInTransaction,
  settleGenerationOperationInTransaction,
} from "@backend/core/auth/usage";

export const COMPOSE_JOB_TYPE = "compose";
export const JOB_LEASE_MS = 90_000;
export const JOB_HEARTBEAT_MS = 30_000;
export const MAX_ACTIVE_JOBS_PER_MERCHANT = 2;
export const MAX_ACTIVE_JOBS_GLOBAL = 20;
export const MAX_JOB_ERROR_LENGTH = 800;

const ACTIVE_JOB_STATUSES = ["pending", "running"] as const;

export type JobRecord = typeof jobs.$inferSelect;
export type CompositionRecord = typeof compositions.$inferSelect;

export class InvalidIdempotencyKeyError extends Error {
  constructor() {
    super("缺少或无效的 Idempotency-Key；请使用 8–128 位字母、数字、点、冒号、下划线或连字符");
    this.name = "InvalidIdempotencyKeyError";
  }
}

export class IdempotencyConflictError extends Error {
  constructor() {
    super("该 Idempotency-Key 已用于不同的项目或合成参数，请为新操作生成新的键");
    this.name = "IdempotencyConflictError";
  }
}

export class JobQueueLimitError extends Error {
  readonly scope: "merchant" | "global";

  constructor(scope: "merchant" | "global") {
    super(
      scope === "merchant"
        ? "当前账号已有 2 个未完成任务，请等待其中一个完成后重试"
        : "当前生成队列已满，请稍后重试",
    );
    this.name = "JobQueueLimitError";
    this.scope = scope;
  }
}

export class JobLeaseLostError extends Error {
  constructor() {
    super("任务租约已失效，旧 worker 无权提交结果");
    this.name = "JobLeaseLostError";
  }
}

export class JobCancellationConflictError extends Error {
  constructor() {
    super("任务已开始合成，当前版本不强制终止正在运行的 FFmpeg；请等待结束或租约恢复");
    this.name = "JobCancellationConflictError";
  }
}

export function normalizeIdempotencyKey(value: string | null | undefined): string {
  const key = value?.trim() || "";
  if (key.length < 8 || key.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(key)) {
    throw new InvalidIdempotencyKeyError();
  }
  return key;
}

export function sanitizeJobError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error || "视频合成失败");
  // node:child_process 的默认 Error.message 会把整条 FFmpeg 命令原样带回，其中含
  // 运行主机绝对路径、素材文件名和字幕文案；job.errorMessage 会经过 GET 返给商家，不能持久这条命令。
  let safe = raw;
  if (/Command failed:/i.test(safe)) {
    safe = /invalid data|invalid argument|could not find codec parameters|moov atom not found/i.test(safe)
      ? "素材文件无法解析或格式不受支持，请更换素材后重试"
      : /permission denied|operation not permitted/i.test(safe)
        ? "合成进程无法读写媒体目录，请联系绘卖团队检查存储权限"
        : "视频合成工具执行失败，请检查素材格式后重试；若持续失败请联系绘卖团队";
  }
  for (const root of [process.env.APP_DATA_DIR, process.cwd()].filter(
    (value): value is string => Boolean(value),
  )) {
    safe = safe.split(root).join("[LOCAL_PATH]");
  }
  const redacted = safe
    .replace(/Bearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
    .replace(
      /((?:api[_-]?key|authorization|access[_-]?token|secret)["'\s]*[:=]["'\s]*)[^\s,;}"']+/gi,
      "$1[REDACTED]",
    )
    .replace(/(["'])(?:\/|[A-Za-z]:[\\/])[^"'\r\n]+\1/g, "$1[LOCAL_PATH]$1")
    .replace(
      /(?<![:\w])\/(?:Users|home|private|tmp|var|data|app|opt|usr|Volumes)(?:\/[^\s,;:'")\]}]+)+/g,
      "[LOCAL_PATH]",
    );
  return redacted.length > MAX_JOB_ERROR_LENGTH
    ? `${redacted.slice(0, MAX_JOB_ERROR_LENGTH)}...`
    : redacted;
}

export interface EnqueueComposeJobInput {
  merchantId: string;
  projectId: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
  /** 冻结后的完整安全业务 payload SHA-256；省略时由 repository 从 payload 计算（测试/旧调用兼容）。 */
  requestHash?: string;
  /** 必须严格对应冻结 payload.options.agentTts===true。 */
  paidTtsRequested?: boolean;
  resolution: "720p" | "1080p";
  aspectRatio: "9:16" | "16:9" | "1:1";
  ttsEnabled: boolean;
  bgmPath?: string;
}

export interface EnqueueComposeJobResult {
  job: JobRecord;
  composition: CompositionRecord;
  duplicate: boolean;
}

function composeRequestHash(job: JobRecord): string {
  return job.requestHash || hashGenerationRequest(job.payload);
}

function frozenPayloadRequestsPaidTts(payload: Record<string, unknown>): boolean {
  const options = payload.options;
  return Boolean(
    options &&
    typeof options === "object" &&
    !Array.isArray(options) &&
    (options as Record<string, unknown>).agentTts === true,
  );
}

function existingComposeJob(
  merchantId: string,
  idempotencyKey: string,
): EnqueueComposeJobResult | null {
  const db = getDb();
  const job = db
    .select()
    .from(jobs)
    .where(
      and(
        eq(jobs.merchantId, merchantId),
        eq(jobs.type, COMPOSE_JOB_TYPE),
        eq(jobs.idempotencyKey, idempotencyKey),
      ),
    )
    .limit(1)
    .all()[0];
  if (!job) return null;
  const composition = job.compositionId
    ? db.select().from(compositions).where(eq(compositions.id, job.compositionId)).limit(1).all()[0]
    : undefined;
  if (!composition) throw new Error("幂等任务关联的合成记录不存在");
  return { job, composition, duplicate: true };
}

export function findComposeJobByIdempotency(
  merchantId: string,
  projectId: string,
  idempotencyKey: string,
  requestHash?: string,
): EnqueueComposeJobResult | null {
  const existing = existingComposeJob(merchantId, idempotencyKey);
  if (!existing) return null;
  if (
    existing.job.projectId !== projectId ||
    existing.composition.projectId !== projectId ||
    (requestHash != null && composeRequestHash(existing.job) !== requestHash)
  ) {
    throw new IdempotencyConflictError();
  }
  return existing;
}

export function enqueueComposeJob(input: EnqueueComposeJobInput): EnqueueComposeJobResult {
  const db = getDb();
  const now = new Date();
  const requestHash = input.requestHash || hashGenerationRequest(input.payload);
  const paidTtsRequested = frozenPayloadRequestsPaidTts(input.payload);
  if (input.paidTtsRequested != null && input.paidTtsRequested !== paidTtsRequested) {
    throw new Error("paidTtsRequested 与冻结 payload.options.agentTts 不一致");
  }

  try {
    return db.transaction((tx) => {
      const existing = tx
        .select()
        .from(jobs)
        .where(
          and(
            eq(jobs.merchantId, input.merchantId),
            eq(jobs.type, COMPOSE_JOB_TYPE),
            eq(jobs.idempotencyKey, input.idempotencyKey),
          ),
        )
        .limit(1)
        .all()[0];
      if (existing) {
        if (
          existing.projectId !== input.projectId ||
          composeRequestHash(existing) !== requestHash
        ) throw new IdempotencyConflictError();
        const composition = existing.compositionId
          ? tx.select().from(compositions).where(eq(compositions.id, existing.compositionId)).limit(1).all()[0]
          : undefined;
        if (!composition) throw new Error("幂等任务关联的合成记录不存在");
        return { job: existing, composition, duplicate: true };
      }

      const merchantActive = tx
        .select({ id: jobs.id })
        .from(jobs)
        .where(and(eq(jobs.merchantId, input.merchantId), inArray(jobs.status, ACTIVE_JOB_STATUSES)))
        .limit(MAX_ACTIVE_JOBS_PER_MERCHANT)
        .all().length;
      if (merchantActive >= MAX_ACTIVE_JOBS_PER_MERCHANT) {
        throw new JobQueueLimitError("merchant");
      }

      const globalActive = tx
        .select({ id: jobs.id })
        .from(jobs)
        .where(inArray(jobs.status, ACTIVE_JOB_STATUSES))
        .limit(MAX_ACTIVE_JOBS_GLOBAL)
        .all().length;
      if (globalActive >= MAX_ACTIVE_JOBS_GLOBAL) {
        throw new JobQueueLimitError("global");
      }

      let generationUsageId: string | null = null;
      if (paidTtsRequested) {
        const reserved = createGenerationOperationInTransaction(tx, {
          merchantId: input.merchantId,
          operationKey: input.idempotencyKey,
          operationType: "compose-paid-tts",
          agentId: "ttsAgent",
          requestHash,
          items: [{ itemKey: "paid-tts", agentId: "ttsAgent" }],
        }, now);
        generationUsageId = reserved.usageId;
        // compose 可能在队列等待超过普通 manifest 的过期窗口；入队即进入 running，直到 job 终态结算。
        markGenerationOperationRunningInTransaction(tx, generationUsageId, now);
      }

      const composition = tx
        .insert(compositions)
        .values({
          projectId: input.projectId,
          resolution: input.resolution,
          aspectRatio: input.aspectRatio,
          bgmPath: input.bgmPath,
          ttsEnabled: input.ttsEnabled,
          aigcDisclosure: true,
          status: "pending",
        })
        .returning()
        .all()[0];

      const job = tx
        .insert(jobs)
        .values({
          type: COMPOSE_JOB_TYPE,
          merchantId: input.merchantId,
          projectId: input.projectId,
          compositionId: composition.id,
          idempotencyKey: input.idempotencyKey,
          requestHash,
          generationUsageId,
          paidTtsUsed: false,
          payloadVersion: 1,
          payload: input.payload,
          status: "pending",
          attempts: 0,
          maxAttempts: 2,
          availableAt: now,
          createdAt: now,
          updatedAt: now,
        })
        .returning()
        .all()[0];

      tx.update(projects)
        .set({ status: "composing", updatedAt: now })
        .where(eq(projects.id, input.projectId))
        .run();
      return { job, composition, duplicate: false };
    });
  } catch (error) {
    // 另一个请求可能在唯一索引处先完成；回读幂等结果，仍只返回同一个 job/composition。
    const existing = findComposeJobByIdempotency(
      input.merchantId,
      input.projectId,
      input.idempotencyKey,
      requestHash,
    );
    if (existing) return existing;
    throw error;
  }
}

export function getJobByCompositionId(compositionId: string): JobRecord | null {
  return (
    getDb().select().from(jobs).where(eq(jobs.compositionId, compositionId)).limit(1).all()[0] ?? null
  );
}

export interface CancelComposeJobResult {
  job: JobRecord;
  composition: CompositionRecord;
  cancelled: boolean;
}

/**
 * 只允许取消尚未被 claim 的持久任务。running 任务没有安全的跨平台 FFmpeg 中断机制，
 * 若直接改库状态会留下不可控的孤儿输出，因此明确拒绝而不做“假取消”。
 */
export function cancelPendingComposeJob(
  merchantId: string,
  projectId: string,
  compositionId: string,
  now = new Date(),
): CancelComposeJobResult | null {
  const db = getDb();
  return db.transaction((tx) => {
    const existing = tx
      .select()
      .from(jobs)
      .where(
        and(
          eq(jobs.type, COMPOSE_JOB_TYPE),
          eq(jobs.merchantId, merchantId),
          eq(jobs.projectId, projectId),
          eq(jobs.compositionId, compositionId),
        ),
      )
      .limit(1)
      .all()[0];
    if (!existing) return null;
    if (existing.status === "running") throw new JobCancellationConflictError();

    const composition = tx
      .select()
      .from(compositions)
      .where(and(eq(compositions.id, compositionId), eq(compositions.projectId, projectId)))
      .limit(1)
      .all()[0];
    if (!composition) return null;
    if (existing.status !== "pending") {
      return { job: existing, composition, cancelled: existing.status === "cancelled" };
    }

    const cancelled = tx
      .update(jobs)
      .set({
        status: "cancelled",
        errorCode: "CANCELLED_BY_USER",
        errorMessage: "任务已由用户取消",
        finishedAt: now,
        updatedAt: now,
      })
      .where(and(eq(jobs.id, existing.id), eq(jobs.status, "pending")))
      .returning()
      .all()[0];
    if (!cancelled) throw new JobCancellationConflictError();

    const cancelledComposition = tx
      .update(compositions)
      .set({ status: "failed" })
      .where(eq(compositions.id, compositionId))
      .returning()
      .all()[0];
    if (cancelled.generationUsageId) {
      settleGenerationOperationInTransaction(
        tx,
        cancelled.generationUsageId,
        false,
        "compose_cancelled",
        now,
      );
    }
    updateProjectAfterTerminalJob(tx, projectId, now);
    return { job: cancelled, composition: cancelledComposition, cancelled: true };
  });
}

export function claimNextJob(workerId: string, now = new Date()): JobRecord | null {
  const db = getDb();
  return db.transaction((tx) => {
    // 数据库级全局并发 1：即使误启动两个 worker，也只有当前 running 任务结束/租约恢复后才能再 claim。
    const running = tx
      .select({ id: jobs.id })
      .from(jobs)
      .where(eq(jobs.status, "running"))
      .limit(1)
      .all()[0];
    if (running) return null;

    const candidate = tx
      .select()
      .from(jobs)
      .where(
        and(
          eq(jobs.status, "pending"),
          lte(jobs.availableAt, now),
          lt(jobs.attempts, jobs.maxAttempts),
        ),
      )
      .orderBy(asc(jobs.createdAt))
      .limit(1)
      .all()[0];
    if (!candidate) return null;

    const leaseToken = randomUUID();
    const claimed = tx
      .update(jobs)
      .set({
        status: "running",
        attempts: candidate.attempts + 1,
        leaseOwner: workerId,
        leaseToken,
        lockedAt: now,
        heartbeatAt: now,
        leaseExpiresAt: new Date(now.getTime() + JOB_LEASE_MS),
        startedAt: candidate.startedAt ?? now,
        updatedAt: now,
        errorCode: null,
        errorMessage: null,
      })
      .where(and(eq(jobs.id, candidate.id), eq(jobs.status, "pending")))
      .returning()
      .all()[0];
    if (!claimed) return null;

    if (claimed.compositionId) {
      tx.update(compositions)
        .set({ status: "composing" })
        .where(eq(compositions.id, claimed.compositionId))
        .run();
    }
    if (claimed.projectId) {
      tx.update(projects)
        .set({ status: "composing", updatedAt: now })
        .where(eq(projects.id, claimed.projectId))
        .run();
    }
    if (claimed.generationUsageId) {
      markGenerationOperationRunningInTransaction(tx, claimed.generationUsageId, now);
    }
    return claimed;
  });
}

export function heartbeatJob(
  jobId: string,
  workerId: string,
  leaseToken: string,
  now = new Date(),
): boolean {
  const updated = getDb()
    .update(jobs)
    .set({
      heartbeatAt: now,
      leaseExpiresAt: new Date(now.getTime() + JOB_LEASE_MS),
      updatedAt: now,
    })
    .where(
      and(
        eq(jobs.id, jobId),
        eq(jobs.status, "running"),
        eq(jobs.leaseOwner, workerId),
        eq(jobs.leaseToken, leaseToken),
        gt(jobs.leaseExpiresAt, now),
      ),
    )
    .returning({ id: jobs.id })
    .all();
  return updated.length === 1;
}

/** 保存可复用的中间产物（当前用于免费 BGM），旧 lease token 不能覆盖新 worker 的 checkpoint。 */
export function checkpointJobResult(
  jobId: string,
  workerId: string,
  leaseToken: string,
  result: Record<string, unknown>,
  now = new Date(),
): boolean {
  const updated = getDb()
    .update(jobs)
    .set({ result, updatedAt: now })
    .where(
      and(
        eq(jobs.id, jobId),
        eq(jobs.status, "running"),
        eq(jobs.leaseOwner, workerId),
        eq(jobs.leaseToken, leaseToken),
        gt(jobs.leaseExpiresAt, now),
      ),
    )
    .returning({ id: jobs.id })
    .all();
  return updated.length === 1;
}

/**
 * 付费 TTS 音频原子落盘/可信复用后立即留证。必须持有当前有效 lease；旧 worker 不能把额度改成已使用。
 */
export function markJobPaidTtsUsed(
  jobId: string,
  workerId: string,
  leaseToken: string,
  now = new Date(),
): boolean {
  const updated = getDb()
    .update(jobs)
    .set({ paidTtsUsed: true, updatedAt: now })
    .where(
      and(
        eq(jobs.id, jobId),
        eq(jobs.status, "running"),
        eq(jobs.leaseOwner, workerId),
        eq(jobs.leaseToken, leaseToken),
        gt(jobs.leaseExpiresAt, now),
      ),
    )
    .returning({ id: jobs.id })
    .all();
  return updated.length === 1;
}

function hasActiveProjectJob(
  tx: Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0],
  projectId: string,
): boolean {
  return Boolean(
    tx
      .select({ id: jobs.id })
      .from(jobs)
      .where(and(eq(jobs.projectId, projectId), inArray(jobs.status, ACTIVE_JOB_STATUSES)))
      .limit(1)
      .all()[0],
  );
}

function projectHasDoneComposition(
  tx: Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0],
  projectId: string,
): boolean {
  return Boolean(
    tx
      .select({ id: compositions.id })
      .from(compositions)
      .where(and(eq(compositions.projectId, projectId), eq(compositions.status, "done")))
      .limit(1)
      .all()[0],
  );
}

function updateProjectAfterTerminalJob(
  tx: Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0],
  projectId: string,
  now: Date,
): void {
  const status = hasActiveProjectJob(tx, projectId)
    ? "composing"
    : projectHasDoneComposition(tx, projectId)
      ? "done"
      : "video";
  tx.update(projects).set({ status, updatedAt: now }).where(eq(projects.id, projectId)).run();
}

export function completeComposeJob(
  jobId: string,
  workerId: string,
  leaseToken: string,
  result: { outputPath: string; credits: MediaCredit[]; paidTtsUsed: boolean },
  now = new Date(),
): void {
  const db = getDb();
  db.transaction((tx) => {
    const current = tx.select().from(jobs).where(eq(jobs.id, jobId)).limit(1).all()[0];
    const paidTtsUsed = Boolean(current?.paidTtsUsed || result.paidTtsUsed);
    const completed = tx
      .update(jobs)
      .set({
        status: "succeeded",
        result: { outputPath: result.outputPath, paidTtsUsed },
        paidTtsUsed,
        leaseOwner: null,
        leaseToken: null,
        leaseExpiresAt: null,
        heartbeatAt: now,
        errorCode: null,
        errorMessage: null,
        finishedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(jobs.id, jobId),
          eq(jobs.status, "running"),
          eq(jobs.leaseOwner, workerId),
          eq(jobs.leaseToken, leaseToken),
          gt(jobs.leaseExpiresAt, now),
        ),
      )
      .returning()
      .all()[0];
    if (!completed) throw new JobLeaseLostError();

    if (completed.compositionId) {
      tx.update(compositions)
        .set({ outputPath: result.outputPath, credits: result.credits, status: "done" })
        .where(eq(compositions.id, completed.compositionId))
        .run();
    }
    if (completed.generationUsageId) {
      settleGenerationOperationInTransaction(
        tx,
        completed.generationUsageId,
        paidTtsUsed,
        "paid_tts_not_used",
        now,
      );
    }
    if (completed.projectId) updateProjectAfterTerminalJob(tx, completed.projectId, now);
  });
}

export function failClaimedJob(
  jobId: string,
  workerId: string,
  leaseToken: string,
  error: unknown,
  now = new Date(),
): boolean {
  const db = getDb();
  const message = sanitizeJobError(error);
  return db.transaction((tx) => {
    const failed = tx
      .update(jobs)
      .set({
        status: "failed",
        leaseOwner: null,
        leaseToken: null,
        leaseExpiresAt: null,
        heartbeatAt: now,
        errorCode: "COMPOSE_FAILED",
        errorMessage: message,
        finishedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(jobs.id, jobId),
          eq(jobs.status, "running"),
          eq(jobs.leaseOwner, workerId),
          eq(jobs.leaseToken, leaseToken),
          gt(jobs.leaseExpiresAt, now),
        ),
      )
      .returning()
      .all()[0];
    if (!failed) return false;

    if (failed.compositionId) {
      tx.update(compositions)
        .set({ status: "failed" })
        .where(eq(compositions.id, failed.compositionId))
        .run();
    }
    if (failed.generationUsageId) {
      settleGenerationOperationInTransaction(
        tx,
        failed.generationUsageId,
        failed.paidTtsUsed,
        "compose_failed_without_paid_tts",
        now,
      );
    }
    if (failed.projectId) updateProjectAfterTerminalJob(tx, failed.projectId, now);
    return true;
  });
}

export interface RecoverExpiredJobsResult {
  requeued: string[];
  failed: string[];
}

export function recoverExpiredJobs(now = new Date()): RecoverExpiredJobsResult {
  const db = getDb();
  return db.transaction((tx) => {
    const expired = tx
      .select()
      .from(jobs)
      .where(
        and(
          eq(jobs.status, "running"),
          or(isNull(jobs.leaseExpiresAt), lte(jobs.leaseExpiresAt, now)),
        ),
      )
      .orderBy(asc(jobs.createdAt))
      .all();
    const result: RecoverExpiredJobsResult = { requeued: [], failed: [] };

    for (const job of expired) {
      if (job.attempts < job.maxAttempts) {
        tx.update(jobs)
          .set({
            status: "pending",
            availableAt: now,
            leaseOwner: null,
            leaseToken: null,
            lockedAt: null,
            leaseExpiresAt: null,
            errorCode: "LEASE_EXPIRED_RETRY",
            errorMessage: "任务执行进程中断，已安排唯一一次自动恢复",
            updatedAt: now,
          })
          .where(and(eq(jobs.id, job.id), eq(jobs.status, "running")))
          .run();
        if (job.compositionId) {
          tx.update(compositions)
            .set({ status: "pending" })
            .where(eq(compositions.id, job.compositionId))
            .run();
        }
        if (job.projectId) {
          tx.update(projects)
            .set({ status: "composing", updatedAt: now })
            .where(eq(projects.id, job.projectId))
            .run();
        }
        result.requeued.push(job.id);
        continue;
      }

      const terminal = tx.update(jobs)
        .set({
          status: "failed",
          leaseOwner: null,
          leaseToken: null,
          leaseExpiresAt: null,
          errorCode: "LEASE_EXPIRED",
          errorMessage: "任务执行进程中断，自动恢复次数已用完，请重新发起合成",
          finishedAt: now,
          updatedAt: now,
        })
        .where(and(eq(jobs.id, job.id), eq(jobs.status, "running")))
        .returning()
        .all()[0];
      if (!terminal) continue;
      if (terminal.compositionId) {
        tx.update(compositions)
          .set({ status: "failed" })
          .where(eq(compositions.id, terminal.compositionId))
          .run();
      }
      if (terminal.generationUsageId) {
        settleGenerationOperationInTransaction(
          tx,
          terminal.generationUsageId,
          terminal.paidTtsUsed,
          "compose_lease_exhausted_without_paid_tts",
          now,
        );
      }
      if (terminal.projectId) updateProjectAfterTerminalJob(tx, terminal.projectId, now);
      result.failed.push(terminal.id);
    }
    return result;
  });
}
