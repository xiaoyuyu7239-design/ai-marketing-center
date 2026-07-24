import "server-only";

import { randomUUID } from "node:crypto";

import { and, asc, eq, gt, inArray, isNull, lte, or, sql } from "drizzle-orm";

import { hashGenerationRequest } from "@backend/core/auth/usage";
import { getDb } from "@backend/db";
import { goldenMediaEvalJobs } from "@backend/db/schema";
import {
  GoldenMediaPollRetryableError,
  GoldenMediaRateLimitedError,
  GoldenMediaSubmissionUncertainError,
} from "./provider-adapter";

export const GOLDEN_MEDIA_JOB_LEASE_MS = 90_000;
export const GOLDEN_MEDIA_JOB_HEARTBEAT_MS = 30_000;
export const GOLDEN_MEDIA_JOB_POLL_INTERVAL_MS = 5_000;
export const MAX_ACTIVE_GOLDEN_MEDIA_JOBS = 20;

const ACTIVE_STATUSES = ["pending", "submitting", "submitted", "polling"] as const;
const CLAIMABLE_STATUSES = ["pending", "submitted"] as const;
const LEASED_STATUSES = ["submitting", "polling"] as const;
const IDEMPOTENCY_RE = /^[A-Za-z0-9._:-]+$/;
const MAX_ERROR_LENGTH = 800;
const MAX_RESULT_BYTES = 512 * 1024;

export type GoldenMediaEvalJobRecord = typeof goldenMediaEvalJobs.$inferSelect;

export interface GoldenMediaEvalJobDto {
  id: string;
  agentId: string;
  caseId: string;
  candidateRole: "primary" | "fallback";
  candidateKey: string;
  provider: string;
  model: string;
  promptVersion: string;
  strategyRevision: number;
  requestKind: GoldenMediaEvalJobRecord["requestKind"];
  status: GoldenMediaEvalJobRecord["status"];
  taskIdCheckpointed: boolean;
  pollAttempts: number;
  maxPollAttempts: number;
  errorCode: string | null;
  errorMessage: string | null;
  artifactUrls: string[];
  createdAt: string;
  startedAt: string | null;
  submittedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
}

function isoOrNull(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

/**
 * Admin API 只暴露调度和审计必需字段；冻结 payload、secretRef、endpoint、lease token
 * 与供应商 taskId 不返回浏览器。
 */
export function toGoldenMediaEvalJobDto(job: GoldenMediaEvalJobRecord): GoldenMediaEvalJobDto {
  return {
    id: job.id,
    agentId: job.agentId,
    caseId: job.caseId,
    candidateRole: job.candidateRole,
    candidateKey: job.candidateKey,
    provider: job.provider,
    model: job.model,
    promptVersion: job.promptVersion,
    strategyRevision: job.strategyRevision,
    requestKind: job.requestKind,
    status: job.status,
    taskIdCheckpointed: Boolean(job.remoteTaskId),
    pollAttempts: job.pollAttempts,
    maxPollAttempts: job.maxPollAttempts,
    errorCode: job.errorCode,
    errorMessage: job.errorMessage,
    artifactUrls: job.artifactUrls ?? [],
    createdAt: job.createdAt.toISOString(),
    startedAt: isoOrNull(job.startedAt),
    submittedAt: isoOrNull(job.submittedAt),
    finishedAt: isoOrNull(job.finishedAt),
    updatedAt: job.updatedAt.toISOString(),
  };
}

export interface EnqueueGoldenMediaEvalJobInput {
  id?: string;
  idempotencyKey: string;
  requestHash?: string;
  agentId: string;
  caseId: string;
  candidateRole: "primary" | "fallback";
  candidateKey: string;
  provider: string;
  model: string;
  promptVersion: string;
  strategyRevision: number;
  requestKind: "image-generation" | "video-generation" | "tts-generation";
  payload: Record<string, unknown>;
  maxPollAttempts?: number;
}

export interface EnqueueGoldenMediaEvalJobResult {
  job: GoldenMediaEvalJobRecord;
  duplicate: boolean;
}

export interface RecoverGoldenMediaEvalJobsResult {
  resumed: string[];
  uncertain: string[];
  timedOut: string[];
}

export class GoldenMediaJobInputError extends Error {
  readonly code = "GOLDEN_MEDIA_JOB_INPUT_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "GoldenMediaJobInputError";
  }
}

export class GoldenMediaJobIdempotencyConflictError extends Error {
  readonly code = "GOLDEN_MEDIA_JOB_IDEMPOTENCY_CONFLICT";

  constructor() {
    super("该 Golden 评测幂等键已用于另一个候选或请求");
    this.name = "GoldenMediaJobIdempotencyConflictError";
  }
}

export class GoldenMediaJobQueueLimitError extends Error {
  readonly code = "GOLDEN_MEDIA_JOB_QUEUE_FULL";

  constructor() {
    super("当前媒体 Golden 评测队列已满，请等待已有任务完成");
    this.name = "GoldenMediaJobQueueLimitError";
  }
}

export class GoldenMediaJobLeaseLostError extends Error {
  readonly code = "GOLDEN_MEDIA_JOB_LEASE_LOST";

  constructor() {
    super("媒体 Golden 任务租约已失效，旧 worker 无权回写");
    this.name = "GoldenMediaJobLeaseLostError";
  }
}

export class GoldenMediaJobRetryableError extends Error {
  readonly code = "GOLDEN_MEDIA_JOB_RETRYABLE";

  constructor(message = "评测任务的可恢复步骤暂时失败") {
    super(message);
    this.name = "GoldenMediaJobRetryableError";
  }
}

/** 只允许用于明确发生在付费请求之前的短暂互斥；该错误才能安全退回 pending。 */
export class GoldenMediaPreSubmitRetryableError extends Error {
  readonly code = "GOLDEN_MEDIA_PRE_SUBMIT_RETRYABLE";

  constructor(message = "付费提交前的评测互斥正忙") {
    super(message);
    this.name = "GoldenMediaPreSubmitRetryableError";
  }
}

function normalizeText(value: string, label: string, maxLength: number): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) {
    throw new GoldenMediaJobInputError(`${label} 不合法`);
  }
  return normalized;
}

export function normalizeGoldenMediaIdempotencyKey(value: string): string {
  const normalized = value.trim();
  if (normalized.length < 8 || normalized.length > 128 || !IDEMPOTENCY_RE.test(normalized)) {
    throw new GoldenMediaJobInputError("Idempotency-Key 必须为 8-128 位字母、数字或 ._:-");
  }
  return normalized;
}

function assertPayloadHasNoSecrets(value: unknown, path = "payload", seen = new WeakSet<object>()): void {
  if (!value || typeof value !== "object") return;
  if (seen.has(value)) throw new GoldenMediaJobInputError("任务 payload 不得包含循环引用");
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertPayloadHasNoSecrets(item, `${path}[${index}]`, seen));
    seen.delete(value);
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const normalizedKey = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
    if (
      normalizedKey !== "secretref" &&
      /^(?:apikey|authorization|accesstoken|refreshtoken|password|secret|token)$/.test(normalizedKey)
    ) {
      throw new GoldenMediaJobInputError(`任务 payload 禁止持久化凭据字段：${path}.${key}`);
    }
    assertPayloadHasNoSecrets(child, `${path}.${key}`, seen);
  }
  seen.delete(value);
}

function normalizeRequestHash(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) throw new GoldenMediaJobInputError("requestHash 必须为 SHA-256");
  return normalized;
}

function safeJsonResult(result: Record<string, unknown>): Record<string, unknown> {
  const serialized = JSON.stringify(result);
  if (Buffer.byteLength(serialized) > MAX_RESULT_BYTES) {
    throw new GoldenMediaJobInputError("媒体评测任务结果超过 512KB 限制");
  }
  return JSON.parse(serialized) as Record<string, unknown>;
}

export function sanitizeGoldenMediaJobError(error: unknown): string {
  let safe = error instanceof Error ? error.message : String(error || "媒体 Golden 任务失败");
  for (const root of [process.env.APP_DATA_DIR, process.cwd()].filter(
    (value): value is string => Boolean(value),
  )) safe = safe.split(root).join("[LOCAL_PATH]");
  safe = safe
    .replace(/Bearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
    .replace(/Key\s+[^\s,;]+/gi, "Key [REDACTED]")
    .replace(
      /((?:api[_-]?key|authorization|access[_-]?token|refresh[_-]?token|secret|password)["'\s]*[:=]["'\s]*)[^\s,;}"']+/gi,
      "$1[REDACTED]",
    )
    .replace(/(?<![:\w])\/(?:Users|home|private|tmp|var|data|app|opt|usr|Volumes)(?:\/[^\s,;:'")\]}]+)+/g, "[LOCAL_PATH]");
  return safe.length > MAX_ERROR_LENGTH ? `${safe.slice(0, MAX_ERROR_LENGTH)}...` : safe;
}

function errorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") {
    return error.code.slice(0, 120);
  }
  return "GOLDEN_MEDIA_JOB_FAILED";
}

function existingByIdempotencyKey(idempotencyKey: string): GoldenMediaEvalJobRecord | null {
  return getDb()
    .select()
    .from(goldenMediaEvalJobs)
    .where(eq(goldenMediaEvalJobs.idempotencyKey, idempotencyKey))
    .limit(1)
    .all()[0] ?? null;
}

function sameRequest(existing: GoldenMediaEvalJobRecord, input: EnqueueGoldenMediaEvalJobInput, requestHash: string) {
  return existing.requestHash === requestHash
    && existing.agentId === input.agentId
    && existing.caseId === input.caseId
    && existing.candidateRole === input.candidateRole
    && existing.candidateKey === input.candidateKey
    && existing.provider === input.provider
    && existing.model === input.model
    && existing.promptVersion === input.promptVersion
    && existing.strategyRevision === input.strategyRevision
    && existing.requestKind === input.requestKind;
}

function prepareEnqueueInput(input: EnqueueGoldenMediaEvalJobInput) {
  const idempotencyKey = normalizeGoldenMediaIdempotencyKey(input.idempotencyKey);
  assertPayloadHasNoSecrets(input.payload);
  const computedHash = hashGenerationRequest(input.payload);
  const requestHash = input.requestHash ? normalizeRequestHash(input.requestHash) : computedHash;
  if (requestHash !== computedHash) throw new GoldenMediaJobInputError("requestHash 与冻结 payload 不一致");

  const normalized = {
    agentId: normalizeText(input.agentId, "agentId", 100),
    caseId: normalizeText(input.caseId, "caseId", 200),
    candidateKey: normalizeText(input.candidateKey, "candidateKey", 1_000),
    provider: normalizeText(input.provider, "provider", 100),
    model: normalizeText(input.model, "model", 500),
    promptVersion: normalizeText(input.promptVersion, "promptVersion", 200),
  };
  if (!Number.isInteger(input.strategyRevision) || input.strategyRevision < 1) {
    throw new GoldenMediaJobInputError("strategyRevision 不合法");
  }
  const maxPollAttempts = input.maxPollAttempts ?? 240;
  if (!Number.isInteger(maxPollAttempts) || maxPollAttempts < 1 || maxPollAttempts > 720) {
    throw new GoldenMediaJobInputError("maxPollAttempts 必须在 1-720 之间");
  }
  return { input, idempotencyKey, requestHash, normalized, maxPollAttempts };
}

/**
 * 一次 POST 选中的 primary/fallback 必须在同一 SQLite 事务中入队；否则第二个候选入队失败时，
 * worker 可能已经 claim 并为第一个候选付费。此函数本身绝不调用任何模型端点。
 */
export function enqueueGoldenMediaEvalJobs(
  inputs: readonly EnqueueGoldenMediaEvalJobInput[],
): EnqueueGoldenMediaEvalJobResult[] {
  if (!inputs.length || inputs.length > 4) throw new GoldenMediaJobInputError("媒体 Golden 候选数量必须在 1-4 之间");
  const prepared = inputs.map(prepareEnqueueInput);
  if (new Set(prepared.map((item) => item.idempotencyKey)).size !== prepared.length) {
    throw new GoldenMediaJobInputError("同一批媒体 Golden 候选的幂等键不得重复");
  }

  const db = getDb();
  return db.transaction((tx) => {
    const results: Array<EnqueueGoldenMediaEvalJobResult | null> = prepared.map((item) => {
      const existing = tx
        .select()
        .from(goldenMediaEvalJobs)
        .where(eq(goldenMediaEvalJobs.idempotencyKey, item.idempotencyKey))
        .limit(1)
        .all()[0];
      if (!existing) return null;
      if (!sameRequest(existing, item.input, item.requestHash)) {
        throw new GoldenMediaJobIdempotencyConflictError();
      }
      return { job: existing, duplicate: true };
    });
    const newCount = results.filter((item) => item === null).length;
    if (newCount === 0) return results as EnqueueGoldenMediaEvalJobResult[];

    const active = tx
      .select({ id: goldenMediaEvalJobs.id })
      .from(goldenMediaEvalJobs)
      .where(inArray(goldenMediaEvalJobs.status, ACTIVE_STATUSES))
      .limit(MAX_ACTIVE_GOLDEN_MEDIA_JOBS)
      .all().length;
    if (active + newCount > MAX_ACTIVE_GOLDEN_MEDIA_JOBS) {
      throw new GoldenMediaJobQueueLimitError();
    }

    const now = new Date();
    return prepared.map((item, index) => {
      if (results[index]) return results[index]!;
      const job = tx
        .insert(goldenMediaEvalJobs)
        .values({
          id: item.input.id || `eval_${randomUUID().replace(/-/g, "")}`,
          idempotencyKey: item.idempotencyKey,
          requestHash: item.requestHash,
          ...item.normalized,
          candidateRole: item.input.candidateRole,
          strategyRevision: item.input.strategyRevision,
          requestKind: item.input.requestKind,
          payloadVersion: 1,
          payload: item.input.payload,
          status: "pending",
          maxPollAttempts: item.maxPollAttempts,
          availableAt: now,
          createdAt: now,
          updatedAt: now,
        })
        .returning()
        .all()[0];
      if (!job) throw new Error("媒体 Golden 任务入队失败");
      return { job, duplicate: false };
    });
  });
}

export function enqueueGoldenMediaEvalJob(
  input: EnqueueGoldenMediaEvalJobInput,
): EnqueueGoldenMediaEvalJobResult {
  return enqueueGoldenMediaEvalJobs([input])[0];
}

export function getGoldenMediaEvalJob(jobId: string): GoldenMediaEvalJobRecord | null {
  return getDb()
    .select()
    .from(goldenMediaEvalJobs)
    .where(eq(goldenMediaEvalJobs.id, jobId))
    .limit(1)
    .all()[0] ?? null;
}

export function findGoldenMediaEvalJobByIdempotencyKey(idempotencyKey: string) {
  return existingByIdempotencyKey(normalizeGoldenMediaIdempotencyKey(idempotencyKey));
}

export function listGoldenMediaEvalJobs(limit = 100): GoldenMediaEvalJobRecord[] {
  return getDb()
    .select()
    .from(goldenMediaEvalJobs)
    .orderBy(sql`${goldenMediaEvalJobs.createdAt} DESC`)
    .limit(Math.min(200, Math.max(1, Math.floor(limit))))
    .all();
}

export function listGoldenTtsJobsForReconciliation(limit = 20): GoldenMediaEvalJobRecord[] {
  return getDb()
    .select()
    .from(goldenMediaEvalJobs)
    .where(and(
      eq(goldenMediaEvalJobs.status, "submission_uncertain"),
      eq(goldenMediaEvalJobs.requestKind, "tts-generation"),
      isNull(goldenMediaEvalJobs.remoteTaskId),
    ))
    .orderBy(asc(goldenMediaEvalJobs.updatedAt))
    .limit(Math.min(20, Math.max(1, Math.floor(limit))))
    .all();
}

function expireExhaustedPolls(now: Date): string[] {
  const db = getDb();
  return db.transaction((tx) => {
    const exhausted = tx
      .select()
      .from(goldenMediaEvalJobs)
      .where(and(
        eq(goldenMediaEvalJobs.status, "submitted"),
        lte(goldenMediaEvalJobs.availableAt, now),
        sql`${goldenMediaEvalJobs.pollAttempts} >= ${goldenMediaEvalJobs.maxPollAttempts}`,
      ))
      .all();
    for (const job of exhausted) {
      tx.update(goldenMediaEvalJobs)
        .set({
          status: "failed",
          errorCode: "POLL_TIMEOUT",
          errorMessage: "轮询次数已用完；remoteTaskId 已保留，请按供应商后台核对",
          finishedAt: now,
          updatedAt: now,
        })
        .where(and(eq(goldenMediaEvalJobs.id, job.id), eq(goldenMediaEvalJobs.status, "submitted")))
        .run();
    }
    return exhausted.map((job) => job.id);
  });
}

/** claim 会先把无 taskId 的任务推进 submitting，所以付费 POST 之前必然已有持久证据。 */
export function claimNextGoldenMediaEvalJob(
  workerId: string,
  now = new Date(),
): GoldenMediaEvalJobRecord | null {
  expireExhaustedPolls(now);
  const db = getDb();
  return db.transaction((tx) => {
    const leased = tx
      .select({ id: goldenMediaEvalJobs.id })
      .from(goldenMediaEvalJobs)
      .where(inArray(goldenMediaEvalJobs.status, LEASED_STATUSES))
      .limit(1)
      .all()[0];
    if (leased) return null;

    const candidate = tx
      .select()
      .from(goldenMediaEvalJobs)
      .where(and(
        inArray(goldenMediaEvalJobs.status, CLAIMABLE_STATUSES),
        lte(goldenMediaEvalJobs.availableAt, now),
      ))
      .orderBy(asc(goldenMediaEvalJobs.createdAt))
      .limit(1)
      .all()[0];
    if (!candidate) return null;

    const leaseToken = randomUUID();
    return tx
      .update(goldenMediaEvalJobs)
      .set({
        status: candidate.remoteTaskId ? "polling" : "submitting",
        leaseOwner: workerId,
        leaseToken,
        leaseExpiresAt: new Date(now.getTime() + GOLDEN_MEDIA_JOB_LEASE_MS),
        heartbeatAt: now,
        startedAt: candidate.startedAt ?? now,
        updatedAt: now,
        errorCode: null,
        errorMessage: null,
      })
      .where(and(
        eq(goldenMediaEvalJobs.id, candidate.id),
        eq(goldenMediaEvalJobs.status, candidate.status),
      ))
      .returning()
      .all()[0] ?? null;
  });
}

function validLeaseWhere(jobId: string, workerId: string, leaseToken: string, now: Date) {
  return and(
    eq(goldenMediaEvalJobs.id, jobId),
    inArray(goldenMediaEvalJobs.status, LEASED_STATUSES),
    eq(goldenMediaEvalJobs.leaseOwner, workerId),
    eq(goldenMediaEvalJobs.leaseToken, leaseToken),
    gt(goldenMediaEvalJobs.leaseExpiresAt, now),
  );
}

export function heartbeatGoldenMediaEvalJob(
  jobId: string,
  workerId: string,
  leaseToken: string,
  now = new Date(),
): boolean {
  const updated = getDb()
    .update(goldenMediaEvalJobs)
    .set({
      heartbeatAt: now,
      leaseExpiresAt: new Date(now.getTime() + GOLDEN_MEDIA_JOB_LEASE_MS),
      updatedAt: now,
    })
    .where(validLeaseWhere(jobId, workerId, leaseToken, now))
    .returning({ id: goldenMediaEvalJobs.id })
    .all();
  return updated.length === 1;
}

/** POST 返回后的第一个动作：以有效 lease 将 taskId checkpoint 到 SQLite。 */
export function checkpointGoldenMediaRemoteTask(
  jobId: string,
  workerId: string,
  leaseToken: string,
  remoteTaskId: string,
  now = new Date(),
): GoldenMediaEvalJobRecord {
  const normalizedTaskId = normalizeText(remoteTaskId, "remoteTaskId", 2_000);
  const updated = getDb()
    .update(goldenMediaEvalJobs)
    .set({
      remoteTaskId: normalizedTaskId,
      status: "polling",
      submittedAt: now,
      updatedAt: now,
    })
    .where(and(
      validLeaseWhere(jobId, workerId, leaseToken, now),
      eq(goldenMediaEvalJobs.status, "submitting"),
      isNull(goldenMediaEvalJobs.remoteTaskId),
    ))
    .returning()
    .all()[0];
  if (!updated) throw new GoldenMediaJobLeaseLostError();
  return updated;
}

function releasePollLease(
  jobId: string,
  workerId: string,
  leaseToken: string,
  now: Date,
  delayMs: number,
  countPollAttempt: boolean,
  error?: unknown,
): boolean {
  const message = error ? sanitizeGoldenMediaJobError(error) : null;
  const updated = getDb()
    .update(goldenMediaEvalJobs)
    .set({
      status: "submitted",
      pollAttempts: countPollAttempt
        ? sql`${goldenMediaEvalJobs.pollAttempts} + 1`
        : sql`${goldenMediaEvalJobs.pollAttempts}`,
      availableAt: new Date(now.getTime() + Math.max(0, delayMs)),
      leaseOwner: null,
      leaseToken: null,
      leaseExpiresAt: null,
      heartbeatAt: now,
      errorCode: error ? errorCode(error) : null,
      errorMessage: message,
      updatedAt: now,
    })
    .where(and(
      validLeaseWhere(jobId, workerId, leaseToken, now),
      eq(goldenMediaEvalJobs.status, "polling"),
      sql`${goldenMediaEvalJobs.remoteTaskId} IS NOT NULL`,
    ))
    .returning({ id: goldenMediaEvalJobs.id })
    .all();
  return updated.length === 1;
}

export function releaseGoldenMediaAfterSubmission(
  jobId: string,
  workerId: string,
  leaseToken: string,
  now = new Date(),
): boolean {
  return releasePollLease(
    jobId,
    workerId,
    leaseToken,
    now,
    GOLDEN_MEDIA_JOB_POLL_INTERVAL_MS,
    false,
  );
}

export function rescheduleGoldenMediaPoll(
  jobId: string,
  workerId: string,
  leaseToken: string,
  options: { now?: Date; delayMs?: number; error?: unknown } = {},
): boolean {
  return releasePollLease(
    jobId,
    workerId,
    leaseToken,
    options.now ?? new Date(),
    options.delayMs ?? GOLDEN_MEDIA_JOB_POLL_INTERVAL_MS,
    true,
    options.error,
  );
}

export function completeGoldenMediaEvalJob(
  jobId: string,
  workerId: string,
  leaseToken: string,
  result: Record<string, unknown>,
  artifactUrls: string[],
  now = new Date(),
): GoldenMediaEvalJobRecord {
  const safeResult = safeJsonResult(result);
  const safeArtifacts = artifactUrls.filter((item): item is string => typeof item === "string").slice(0, 4);
  const updated = getDb()
    .update(goldenMediaEvalJobs)
    .set({
      status: "succeeded",
      result: safeResult,
      artifactUrls: safeArtifacts,
      pollAttempts: sql`${goldenMediaEvalJobs.pollAttempts} + 1`,
      leaseOwner: null,
      leaseToken: null,
      leaseExpiresAt: null,
      heartbeatAt: now,
      errorCode: null,
      errorMessage: null,
      finishedAt: now,
      updatedAt: now,
    })
    .where(and(
      validLeaseWhere(jobId, workerId, leaseToken, now),
      eq(goldenMediaEvalJobs.status, "polling"),
      sql`${goldenMediaEvalJobs.remoteTaskId} IS NOT NULL`,
    ))
    .returning()
    .all()[0];
  if (!updated) throw new GoldenMediaJobLeaseLostError();
  return updated;
}

/**
 * TTS one-shot 无 remoteTaskId：只能由仍持有 submitting lease 的原 worker 在真实音频
 * 与 AgentEvalRecord 都落盘后终结。租约丢失时不得重放生成，恢复器会转 uncertain。
 */
export function completeGoldenTtsEvalJob(
  jobId: string,
  workerId: string,
  leaseToken: string,
  result: Record<string, unknown>,
  artifactUrls: string[],
  now = new Date(),
): GoldenMediaEvalJobRecord {
  const safeResult = safeJsonResult(result);
  const safeArtifacts = artifactUrls.filter((item): item is string => typeof item === "string").slice(0, 4);
  const updated = getDb()
    .update(goldenMediaEvalJobs)
    .set({
      status: "succeeded",
      result: safeResult,
      artifactUrls: safeArtifacts,
      leaseOwner: null,
      leaseToken: null,
      leaseExpiresAt: null,
      heartbeatAt: now,
      errorCode: null,
      errorMessage: null,
      finishedAt: now,
      updatedAt: now,
    })
    .where(and(
      validLeaseWhere(jobId, workerId, leaseToken, now),
      eq(goldenMediaEvalJobs.status, "submitting"),
      eq(goldenMediaEvalJobs.requestKind, "tts-generation"),
      isNull(goldenMediaEvalJobs.remoteTaskId),
    ))
    .returning()
    .all()[0];
  if (!updated) throw new GoldenMediaJobLeaseLostError();
  return updated;
}

/** 仅当 one-shot 音频与记录已被深度校验时，将崩溃窗口留下的 uncertain 收敛为成功。 */
export function completeReconciledGoldenTtsEvalJob(
  jobId: string,
  result: Record<string, unknown>,
  artifactUrls: string[],
  now = new Date(),
): GoldenMediaEvalJobRecord | null {
  const safeResult = safeJsonResult(result);
  const safeArtifacts = artifactUrls.filter((item): item is string => typeof item === "string").slice(0, 4);
  return getDb()
    .update(goldenMediaEvalJobs)
    .set({
      status: "succeeded",
      result: safeResult,
      artifactUrls: safeArtifacts,
      errorCode: null,
      errorMessage: null,
      finishedAt: now,
      updatedAt: now,
    })
    .where(and(
      eq(goldenMediaEvalJobs.id, jobId),
      eq(goldenMediaEvalJobs.status, "submission_uncertain"),
      eq(goldenMediaEvalJobs.requestKind, "tts-generation"),
      isNull(goldenMediaEvalJobs.remoteTaskId),
    ))
    .returning()
    .all()[0] ?? null;
}

export function failGoldenMediaEvalJob(
  jobId: string,
  workerId: string,
  leaseToken: string,
  error: unknown,
  now = new Date(),
): boolean {
  if (error instanceof GoldenMediaPreSubmitRetryableError || error instanceof GoldenMediaRateLimitedError) {
    const delayMs = error instanceof GoldenMediaRateLimitedError
      ? Math.min(24 * 60 * 60_000, Math.max(1_000, error.retryAfterSeconds * 1_000))
      : GOLDEN_MEDIA_JOB_POLL_INTERVAL_MS;
    const updated = getDb()
      .update(goldenMediaEvalJobs)
      .set({
        status: "pending",
        availableAt: new Date(now.getTime() + delayMs),
        leaseOwner: null,
        leaseToken: null,
        leaseExpiresAt: null,
        heartbeatAt: now,
        errorCode: error.code,
        errorMessage: sanitizeGoldenMediaJobError(error),
        updatedAt: now,
      })
      .where(and(
        validLeaseWhere(jobId, workerId, leaseToken, now),
        eq(goldenMediaEvalJobs.status, "submitting"),
        isNull(goldenMediaEvalJobs.remoteTaskId),
      ))
      .returning({ id: goldenMediaEvalJobs.id })
      .all();
    return updated.length === 1;
  }
  if (error instanceof GoldenMediaPollRetryableError || error instanceof GoldenMediaJobRetryableError) {
    return rescheduleGoldenMediaPoll(jobId, workerId, leaseToken, { now, error });
  }
  const uncertain = error instanceof GoldenMediaSubmissionUncertainError
    || errorCode(error) === "SUBMISSION_UNCERTAIN";
  const updated = getDb()
    .update(goldenMediaEvalJobs)
    .set({
      status: uncertain ? "submission_uncertain" : "failed",
      leaseOwner: null,
      leaseToken: null,
      leaseExpiresAt: null,
      heartbeatAt: now,
      errorCode: uncertain ? "SUBMISSION_UNCERTAIN" : errorCode(error),
      errorMessage: sanitizeGoldenMediaJobError(error),
      finishedAt: now,
      updatedAt: now,
    })
    .where(validLeaseWhere(jobId, workerId, leaseToken, now))
    .returning({ id: goldenMediaEvalJobs.id })
    .all();
  return updated.length === 1;
}

/**
 * 恢复规则是安全核心：
 * - submitting + 无 taskId：无法区分“POST 前崩溃”与“已受理后崩溃”，必须终止且禁止重提；
 * - submitting/polling + 有 taskId：释放旧 lease，下一个 worker 只继续 GET 轮询。
 */
export function recoverExpiredGoldenMediaEvalJobs(
  now = new Date(),
): RecoverGoldenMediaEvalJobsResult {
  const timedOut = expireExhaustedPolls(now);
  const db = getDb();
  return db.transaction((tx) => {
    const expired = tx
      .select()
      .from(goldenMediaEvalJobs)
      .where(and(
        inArray(goldenMediaEvalJobs.status, LEASED_STATUSES),
        or(isNull(goldenMediaEvalJobs.leaseExpiresAt), lte(goldenMediaEvalJobs.leaseExpiresAt, now)),
      ))
      .orderBy(asc(goldenMediaEvalJobs.createdAt))
      .all();
    const result: RecoverGoldenMediaEvalJobsResult = { resumed: [], uncertain: [], timedOut };

    for (const job of expired) {
      if (job.remoteTaskId) {
        const resumed = tx
          .update(goldenMediaEvalJobs)
          .set({
            status: "submitted",
            availableAt: now,
            leaseOwner: null,
            leaseToken: null,
            leaseExpiresAt: null,
            errorCode: "LEASE_EXPIRED_RESUME_POLL",
            errorMessage: "worker 中断，taskId 已持久化；将只恢复轮询，不会重新提交",
            updatedAt: now,
          })
          .where(and(eq(goldenMediaEvalJobs.id, job.id), eq(goldenMediaEvalJobs.status, job.status)))
          .returning({ id: goldenMediaEvalJobs.id })
          .all()[0];
        if (resumed) result.resumed.push(job.id);
        continue;
      }

      const uncertain = tx
        .update(goldenMediaEvalJobs)
        .set({
          status: "submission_uncertain",
          leaseOwner: null,
          leaseToken: null,
          leaseExpiresAt: null,
          errorCode: "SUBMISSION_UNCERTAIN",
          errorMessage: "worker 在提交阶段中断且未持久化 taskId；为避免重复计费已禁止自动重提",
          finishedAt: now,
          updatedAt: now,
        })
        .where(and(eq(goldenMediaEvalJobs.id, job.id), eq(goldenMediaEvalJobs.status, job.status)))
        .returning({ id: goldenMediaEvalJobs.id })
        .all()[0];
      if (uncertain) result.uncertain.push(job.id);
    }
    return result;
  });
}
