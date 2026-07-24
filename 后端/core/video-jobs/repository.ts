import "server-only";

import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gt, inArray, isNull, lte, or, sql } from "drizzle-orm";

import {
  createGenerationOperationInTransaction,
  hashGenerationRequest,
  type GenerationUsageTransaction,
} from "@backend/core/auth/usage";
import { getDb } from "@backend/db";
import {
  assets,
  generationOperationItems,
  generationUsage,
  motionAssetAssessments,
  motionVideoJobs,
  videoClips,
} from "@backend/db/schema";
import type { OwnedMotionEligibilityResult } from "@backend/core/motion/eligibility-service";
import {
  MotionVideoJobIdempotencyConflictError,
  MotionVideoJobInputError,
  MotionVideoJobLeaseLostError,
  MotionVideoJobQueueLimitError,
  MotionVideoPollRetryableError,
  MotionVideoRateLimitedError,
  MotionVideoRemoteTaskError,
  MotionVideoSourceChangedError,
  MotionVideoSubmissionUncertainError,
  boundedRetryAfterSeconds,
  motionVideoErrorDto,
} from "./errors";
import type {
  MotionAssetAssessmentDto,
  MotionVideoJobDto,
  MotionVideoJobPayloadV1,
  MotionVideoJobStatus,
} from "./types";

export const MOTION_VIDEO_JOB_LEASE_MS = 90_000;
export const MOTION_VIDEO_JOB_HEARTBEAT_MS = 30_000;
export const MOTION_VIDEO_JOB_POLL_INTERVAL_MS = 5_000;
export const MOTION_VIDEO_USAGE_DEADLINE_MS = 48 * 60 * 60_000;
export const MAX_ACTIVE_MOTION_JOBS_PER_MERCHANT = 18;
export const MAX_ACTIVE_MOTION_JOBS_GLOBAL = 100;

const ACTIVE_STATUSES = ["pending", "submitting", "submitted", "polling", "downloading", "saving"] as const;
const CLAIMABLE_STATUSES = ["pending", "submitted"] as const;
const LEASED_STATUSES = ["submitting", "polling", "downloading", "saving"] as const;
const TERMINAL_STATUSES = ["succeeded", "failed", "submission_uncertain"] as const;
const IDEMPOTENCY_RE = /^[A-Za-z0-9._:-]+$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const MAX_ERROR_LENGTH = 800;

export type MotionVideoJobRecord = typeof motionVideoJobs.$inferSelect;
export type MotionAssetAssessmentRecord = typeof motionAssetAssessments.$inferSelect;

export interface EnqueueMotionVideoJobInput {
  merchantId: string;
  projectId: string;
  operationKey: string;
  itemKey: string;
  shotId: number;
  sourceAssetId: string;
  payload: MotionVideoJobPayloadV1;
  maxPollAttempts?: number;
}

export interface EnqueueMotionVideoJobResult {
  job: MotionVideoJobRecord;
  duplicate: boolean;
}

export interface RecoverMotionVideoJobsResult {
  resumed: string[];
  uncertain: string[];
  timedOut: string[];
}

function normalizeKey(value: string, label: string, min = 1, max = 128): string {
  const normalized = value.trim();
  if (normalized.length < min || normalized.length > max || !IDEMPOTENCY_RE.test(normalized)) {
    throw new MotionVideoJobInputError(`${label} 必须为 ${min}-${max} 位字母、数字或 ._:-`);
  }
  return normalized;
}

export function normalizeMotionOperationKey(value: string): string {
  return normalizeKey(value, "operationId", 8);
}

function assertPayloadHasNoSecrets(value: unknown, path = "payload", seen = new WeakSet<object>()): void {
  if (!value || typeof value !== "object") return;
  if (seen.has(value)) throw new MotionVideoJobInputError("动态任务 payload 不得包含循环引用");
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertPayloadHasNoSecrets(item, `${path}[${index}]`, seen));
    seen.delete(value);
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const normalizedKey = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
    if (
      normalizedKey !== "secretref"
      && /^(?:apikey|authorization|accesstoken|refreshtoken|password|secret|token)$/.test(normalizedKey)
    ) {
      throw new MotionVideoJobInputError(`动态任务 payload 禁止持久化凭据字段：${path}.${key}`);
    }
    assertPayloadHasNoSecrets(child, `${path}.${key}`, seen);
  }
  seen.delete(value);
}

function assertPayload(payload: MotionVideoJobPayloadV1, input: EnqueueMotionVideoJobInput): void {
  assertPayloadHasNoSecrets(payload);
  if (
    payload.version !== 1
    || payload.shot?.shotId !== input.shotId
    || payload.source?.assetId !== input.sourceAssetId
    || payload.source?.decision?.policy !== "ai_video"
    || payload.source?.decision?.state !== "eligible"
    || !payload.source?.decision?.binding
    || payload.source.decision.binding.assetId !== input.sourceAssetId
    || payload.source.decision.binding.imageHash !== payload.source.imageHash
    || !SHA256_RE.test(payload.source.imageHash)
    || payload.source.faceAssessment?.status !== "clear"
    || payload.source.faceAssessment.checkedImageHash !== payload.source.imageHash
  ) {
    throw new MotionVideoJobInputError("动态任务缺少服务端已验证的 AI 视频资格绑定");
  }
}

function preparedInput(input: EnqueueMotionVideoJobInput) {
  const merchantId = normalizeKey(input.merchantId, "merchantId", 1);
  const projectId = normalizeKey(input.projectId, "projectId", 1);
  const operationKey = normalizeMotionOperationKey(input.operationKey);
  const itemKey = normalizeKey(input.itemKey, "itemKey", 1);
  const sourceAssetId = normalizeKey(input.sourceAssetId, "sourceAssetId", 1);
  if (!Number.isSafeInteger(input.shotId) || input.shotId < 0) {
    throw new MotionVideoJobInputError("shotId 不合法");
  }
  assertPayload(input.payload, input);
  const maxPollAttempts = input.maxPollAttempts ?? 240;
  if (!Number.isInteger(maxPollAttempts) || maxPollAttempts < 1 || maxPollAttempts > 720) {
    throw new MotionVideoJobInputError("maxPollAttempts 必须在 1-720 之间");
  }
  return {
    ...input,
    merchantId,
    projectId,
    operationKey,
    itemKey,
    sourceAssetId,
    requestHash: hashGenerationRequest(input.payload),
    maxPollAttempts,
  };
}

function sameRequest(existing: MotionVideoJobRecord, input: ReturnType<typeof preparedInput>): boolean {
  return existing.projectId === input.projectId
    && existing.itemKey === input.itemKey
    && existing.shotId === input.shotId
    && existing.sourceAssetId === input.sourceAssetId
    && existing.requestHash === input.requestHash;
}

function operationRequestHash(inputs: readonly ReturnType<typeof preparedInput>[]): string {
  return hashGenerationRequest({
    projectId: inputs[0]?.projectId,
    operationKey: inputs[0]?.operationKey,
    items: inputs
      .map((item) => ({ itemKey: item.itemKey, requestHash: item.requestHash }))
      .sort((left, right) => left.itemKey.localeCompare(right.itemKey)),
  });
}

/**
 * 一次点击的全部合格镜头在一个 SQLite 事务中预占 1 次额度并入队；本函数不调用模型。
 */
export function enqueueMotionVideoJobs(
  rawInputs: readonly EnqueueMotionVideoJobInput[],
): EnqueueMotionVideoJobResult[] {
  if (!rawInputs.length || rawInputs.length > 9) {
    throw new MotionVideoJobInputError("一次动态任务必须包含 1-9 个镜头");
  }
  const inputs = rawInputs.map(preparedInput);
  const first = inputs[0]!;
  if (inputs.some((item) => item.merchantId !== first.merchantId
    || item.projectId !== first.projectId
    || item.operationKey !== first.operationKey)) {
    throw new MotionVideoJobInputError("同批动态任务必须属于同一商家、项目和 operationId");
  }
  if (new Set(inputs.map((item) => item.itemKey)).size !== inputs.length
    || new Set(inputs.map((item) => item.shotId)).size !== inputs.length) {
    throw new MotionVideoJobInputError("同批动态任务的 itemKey/shotId 不得重复");
  }

  const db = getDb();
  return db.transaction((tx) => {
    const existing = tx.select().from(motionVideoJobs).where(and(
      eq(motionVideoJobs.merchantId, first.merchantId),
      eq(motionVideoJobs.operationKey, first.operationKey),
    )).all();
    if (existing.length) {
      if (existing.length !== inputs.length) throw new MotionVideoJobIdempotencyConflictError();
      const byItem = new Map(existing.map((job) => [job.itemKey, job]));
      const jobs = inputs.map((input) => byItem.get(input.itemKey));
      if (jobs.some((job, index) => !job || !sameRequest(job, inputs[index]!))) {
        throw new MotionVideoJobIdempotencyConflictError();
      }
      return jobs.map((job) => ({ job: job!, duplicate: true }));
    }

    const merchantActive = tx.select({ id: motionVideoJobs.id }).from(motionVideoJobs)
      .where(and(
        eq(motionVideoJobs.merchantId, first.merchantId),
        inArray(motionVideoJobs.status, ACTIVE_STATUSES),
      ))
      .limit(MAX_ACTIVE_MOTION_JOBS_PER_MERCHANT)
      .all().length;
    if (merchantActive + inputs.length > MAX_ACTIVE_MOTION_JOBS_PER_MERCHANT) {
      throw new MotionVideoJobQueueLimitError("merchant");
    }
    const globalActive = tx.select({ id: motionVideoJobs.id }).from(motionVideoJobs)
      .where(inArray(motionVideoJobs.status, ACTIVE_STATUSES))
      .limit(MAX_ACTIVE_MOTION_JOBS_GLOBAL)
      .all().length;
    if (globalActive + inputs.length > MAX_ACTIVE_MOTION_JOBS_GLOBAL) {
      throw new MotionVideoJobQueueLimitError("global");
    }

    const now = new Date();
    const operationType = inputs.length === 1 ? "video-single" : "video-batch";
    const reservation = createGenerationOperationInTransaction(tx, {
      merchantId: first.merchantId,
      projectId: first.projectId,
      operationKey: first.operationKey,
      operationType,
      agentId: "videoAgent",
      requestHash: operationRequestHash(inputs),
      items: inputs.map((item) => ({ itemKey: item.itemKey, agentId: "videoAgent" })),
    }, now);
    const generationItems = tx.select().from(generationOperationItems)
      .where(eq(generationOperationItems.usageId, reservation.usageId)).all();
    const generationByKey = new Map(generationItems.map((item) => [item.itemKey, item]));
    const reservationDeadline = new Date(now.getTime() + MOTION_VIDEO_USAGE_DEADLINE_MS);
    tx.update(generationOperationItems).set({
      leaseExpiresAt: reservationDeadline,
      updatedAt: now,
    }).where(eq(generationOperationItems.usageId, reservation.usageId)).run();
    // 队列已原子持有该 operation，不再是“只创建 manifest 未交给执行器”的短暂预占。
    // 提前转 running，避免通用 30 分钟 reservation 清理器在视频排队期误释放额度；
    // 真正的最终截止由上面的 48 小时 item lease 与 worker 心跳维护。
    tx.update(generationUsage).set({ status: "running", updatedAt: now })
      .where(eq(generationUsage.id, reservation.usageId)).run();

    return inputs.map((input) => {
      const generationItem = generationByKey.get(input.itemKey);
      if (!generationItem) throw new Error("动态任务额度子项不存在");
      const job = tx.insert(motionVideoJobs).values({
        merchantId: input.merchantId,
        projectId: input.projectId,
        generationUsageId: reservation.usageId,
        generationItemId: generationItem.id,
        operationKey: input.operationKey,
        itemKey: input.itemKey,
        requestHash: input.requestHash,
        shotId: input.shotId,
        sourceAssetId: input.sourceAssetId,
        payloadVersion: 1,
        payload: input.payload,
        status: "pending",
        maxPollAttempts: input.maxPollAttempts,
        availableAt: now,
        createdAt: now,
        updatedAt: now,
      }).returning().all()[0];
      if (!job) throw new Error("动态任务入队失败");
      return { job, duplicate: false };
    });
  });
}

export function getMotionVideoJob(
  merchantId: string,
  projectId: string,
  jobId: string,
): MotionVideoJobRecord | null {
  return getDb().select().from(motionVideoJobs).where(and(
    eq(motionVideoJobs.id, jobId),
    eq(motionVideoJobs.merchantId, merchantId),
    eq(motionVideoJobs.projectId, projectId),
  )).limit(1).all()[0] ?? null;
}

export function listMotionVideoJobs(
  merchantId: string,
  projectId: string,
  limit = 100,
): MotionVideoJobRecord[] {
  return getDb().select().from(motionVideoJobs).where(and(
    eq(motionVideoJobs.merchantId, merchantId),
    eq(motionVideoJobs.projectId, projectId),
  )).orderBy(
    desc(motionVideoJobs.createdAt),
    desc(sql<number>`${motionVideoJobs}._rowid_`),
  )
    .limit(Math.min(200, Math.max(1, Math.floor(limit)))).all();
}

function parsePayload(job: MotionVideoJobRecord): MotionVideoJobPayloadV1 {
  const payload = job.payload as Partial<MotionVideoJobPayloadV1> | null;
  if (!payload || payload.version !== 1 || !payload.source || !payload.endpoint) {
    throw new MotionVideoJobInputError("动态任务 payload 版本不受支持");
  }
  return payload as MotionVideoJobPayloadV1;
}

function iso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function stage(status: MotionVideoJobStatus): MotionVideoJobDto["stage"] {
  if (status === "pending") return "queued";
  if (status === "submitting" || status === "submitted") return "submitted";
  if (status === "polling") return "processing";
  if (status === "downloading") return "downloading";
  if (status === "saving") return "saving";
  if (status === "succeeded") return "completed";
  return "failed";
}

export function toMotionVideoJobDto(job: MotionVideoJobRecord): MotionVideoJobDto {
  const payload = parsePayload(job);
  const binding = payload.source.decision.binding!;
  const error = job.errorCode ? {
    code: job.errorCode,
    category: job.errorCategory || "unknown",
    message: job.errorMessage || "动态任务失败",
    retryable: Boolean(job.errorRetryable),
    ...(job.retryAfterSeconds != null ? { retryAfterSeconds: job.retryAfterSeconds } : {}),
    ...(job.errorRequestId ? { requestId: job.errorRequestId } : {}),
    ...(job.suggestedAction ? { suggestedAction: job.suggestedAction } : {}),
  } : null;
  return {
    id: job.id,
    projectId: job.projectId,
    operationId: job.operationKey,
    itemKey: job.itemKey,
    shotId: job.shotId,
    sourceAssetId: job.sourceAssetId,
    status: job.status,
    stage: stage(job.status),
    progress: job.progress,
    policy: payload.source.decision.policy,
    eligibilityState: payload.source.decision.state,
    eligibilityReason: payload.source.decision.reason,
    sourceImageHash: payload.source.imageHash,
    sourceModelRevision: binding.modelRevision,
    eligibilityRevision: binding.eligibilityRevision,
    faceStatus: payload.source.faceAssessment.status,
    faceDetectorRevision: payload.source.faceAssessment.modelRevision,
    provider: payload.endpoint.provider,
    model: payload.endpoint.model,
    taskIdCheckpointed: Boolean(job.remoteTaskId),
    outputUrl: job.status === "succeeded" ? job.outputFilePath : null,
    error,
    pollAttempts: job.pollAttempts,
    maxPollAttempts: job.maxPollAttempts,
    createdAt: job.createdAt.toISOString(),
    startedAt: iso(job.startedAt),
    submittedAt: iso(job.submittedAt),
    finishedAt: iso(job.finishedAt),
    updatedAt: job.updatedAt.toISOString(),
  };
}

function assessmentFace(result: OwnedMotionEligibilityResult) {
  const binding = result.decision.binding;
  const face = result.faceAssessment;
  return {
    faceStatus: face?.status ?? "not_applicable" as const,
    faceCheckedImageHash: face?.checkedImageHash ?? null,
    faceDetectorRevision: face?.modelRevision ?? binding?.modelRevision ?? "motion-policy-only-v1",
    faceSource: face?.source ?? "unavailable" as const,
    faceConfidencePermille: typeof face?.confidence === "number"
      ? Math.max(0, Math.min(1000, Math.round(face.confidence * 1000)))
      : null,
    faceCount: typeof face?.faceCount === "number" ? Math.max(0, Math.round(face.faceCount)) : null,
  };
}

export function upsertMotionAssetAssessment(input: {
  merchantId: string;
  projectId: string;
  assetId: string;
  shotId: number;
  result: OwnedMotionEligibilityResult;
}): MotionAssetAssessmentRecord {
  const { decision, inspection } = input.result;
  if (!inspection || !decision.binding || decision.binding.assetId !== input.assetId) {
    throw new MotionVideoJobInputError("只有已落库且完成内容检查的素材才能保存动态资格");
  }
  const now = new Date();
  const values = {
    merchantId: input.merchantId,
    projectId: input.projectId,
    assetId: input.assetId,
    shotId: input.shotId,
    imageRef: inspection.imageRef,
    imageHash: inspection.imageHash,
    mediaKind: inspection.mediaKind,
    width: inspection.width,
    height: inspection.height,
    policy: decision.policy,
    eligibilityState: decision.state,
    eligibilityReason: decision.reason,
    eligibilityRevision: decision.binding.eligibilityRevision,
    sourceModelRevision: decision.binding.modelRevision,
    ...assessmentFace(input.result),
    updatedAt: now,
  };
  return getDb().insert(motionAssetAssessments).values({ ...values, createdAt: now })
    .onConflictDoUpdate({ target: motionAssetAssessments.assetId, set: values })
    .returning().all()[0]!;
}

export function getMotionAssetAssessment(assetId: string): MotionAssetAssessmentRecord | null {
  return getDb().select().from(motionAssetAssessments)
    .where(eq(motionAssetAssessments.assetId, assetId)).limit(1).all()[0] ?? null;
}

export function listMotionAssetAssessments(
  merchantId: string,
  projectId: string,
): MotionAssetAssessmentRecord[] {
  return getDb().select().from(motionAssetAssessments).where(and(
    eq(motionAssetAssessments.merchantId, merchantId),
    eq(motionAssetAssessments.projectId, projectId),
  )).orderBy(asc(motionAssetAssessments.shotId)).all();
}

export function toMotionAssetAssessmentDto(row: MotionAssetAssessmentRecord): MotionAssetAssessmentDto {
  return {
    assetId: row.assetId,
    shotId: row.shotId,
    imageRef: row.imageRef,
    imageHash: row.imageHash,
    mediaKind: row.mediaKind,
    width: row.width,
    height: row.height,
    policy: row.policy,
    state: row.eligibilityState,
    reason: row.eligibilityReason as MotionAssetAssessmentDto["reason"],
    eligibilityRevision: row.eligibilityRevision,
    sourceModelRevision: row.sourceModelRevision,
    faceStatus: row.faceStatus,
    faceDetectorRevision: row.faceDetectorRevision,
    faceSource: row.faceSource,
    faceConfidence: row.faceConfidencePermille == null ? null : row.faceConfidencePermille / 1000,
    faceCount: row.faceCount,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function maxInFlight(): number {
  const raw = Number(process.env.HUIMAI_MOTION_JOB_MAX_IN_FLIGHT);
  return Number.isFinite(raw) ? Math.min(16, Math.max(1, Math.floor(raw))) : 4;
}

function updateGenerationItemDeadline(
  tx: GenerationUsageTransaction,
  job: MotionVideoJobRecord,
  now: Date,
) {
  if (!job.generationItemId) return;
  tx.update(generationOperationItems).set({
    leaseExpiresAt: new Date(now.getTime() + MOTION_VIDEO_USAGE_DEADLINE_MS),
    updatedAt: now,
  }).where(eq(generationOperationItems.id, job.generationItemId)).run();
}

function settleGenerationItem(
  tx: GenerationUsageTransaction,
  job: MotionVideoJobRecord,
  succeeded: boolean,
  failureCode: string,
  now: Date,
) {
  if (!job.generationItemId || !job.generationUsageId) return;
  tx.update(generationOperationItems).set({
    status: succeeded ? "succeeded" : "failed",
    result: succeeded ? { motionJobId: job.id, paidCapabilityUsed: true } : null,
    failureCode: succeeded ? null : failureCode.slice(0, 100),
    leaseToken: null,
    leaseExpiresAt: null,
    completedAt: now,
    updatedAt: now,
  }).where(and(
    eq(generationOperationItems.id, job.generationItemId),
    eq(generationOperationItems.usageId, job.generationUsageId),
    inArray(generationOperationItems.status, ["pending", "running"]),
  )).run();

  const rows = tx.select({ status: generationOperationItems.status })
    .from(generationOperationItems)
    .where(eq(generationOperationItems.usageId, job.generationUsageId)).all();
  const succeededItems = rows.filter((row) => row.status === "succeeded").length;
  const failedItems = rows.filter((row) => row.status === "failed").length;
  const completedItems = succeededItems + failedItems;
  const status = completedItems < rows.length
    ? "running"
    : succeededItems === 0 ? "failed" : failedItems > 0 ? "partial" : "succeeded";
  tx.update(generationUsage).set({
    success: status !== "failed",
    status,
    expectedItems: rows.length,
    completedItems,
    succeededItems,
    failedItems,
    updatedAt: now,
  }).where(eq(generationUsage.id, job.generationUsageId)).run();
}

function expireExhaustedPolls(now: Date): string[] {
  return getDb().transaction((tx) => {
    const exhausted = tx.select().from(motionVideoJobs).where(and(
      eq(motionVideoJobs.status, "submitted"),
      lte(motionVideoJobs.availableAt, now),
      sql`${motionVideoJobs.pollAttempts} >= ${motionVideoJobs.maxPollAttempts}`,
    )).all();
    const ids: string[] = [];
    for (const job of exhausted) {
      const updated = tx.update(motionVideoJobs).set({
        status: "failed",
        errorCode: "POLL_TIMEOUT",
        errorCategory: "timeout",
        errorRequestId: null,
        errorMessage: "模型任务轮询已超时；taskId 已保留，请联系工作人员核对供应商后台",
        errorRetryable: false,
        suggestedAction: "contact_support",
        finishedAt: now,
        updatedAt: now,
      }).where(and(eq(motionVideoJobs.id, job.id), eq(motionVideoJobs.status, "submitted")))
        .returning({ id: motionVideoJobs.id }).all()[0];
      if (!updated) continue;
      settleGenerationItem(tx, job, job.paidCapabilityUsed, "POLL_TIMEOUT", now);
      ids.push(job.id);
    }
    return ids;
  });
}

/** claim 原子写 submitting/polling；无 taskId 的付费 POST 在此之后才允许发生。 */
export function claimNextMotionVideoJob(workerId: string, now = new Date()): MotionVideoJobRecord | null {
  expireExhaustedPolls(now);
  return getDb().transaction((tx) => {
    const leased = tx.select({ id: motionVideoJobs.id }).from(motionVideoJobs)
      .where(inArray(motionVideoJobs.status, LEASED_STATUSES)).limit(maxInFlight()).all().length;
    if (leased >= maxInFlight()) return null;
    const candidate = tx.select().from(motionVideoJobs).where(and(
      inArray(motionVideoJobs.status, CLAIMABLE_STATUSES),
      lte(motionVideoJobs.availableAt, now),
    )).orderBy(
      asc(motionVideoJobs.createdAt),
      asc(sql<number>`${motionVideoJobs}._rowid_`),
    ).limit(1).all()[0];
    if (!candidate) return null;
    const leaseToken = randomUUID();
    const claimed = tx.update(motionVideoJobs).set({
      status: candidate.remoteTaskId ? "polling" : "submitting",
      leaseOwner: workerId,
      leaseToken,
      leaseExpiresAt: new Date(now.getTime() + MOTION_VIDEO_JOB_LEASE_MS),
      heartbeatAt: now,
      startedAt: candidate.startedAt ?? now,
      updatedAt: now,
      errorCode: null,
      errorCategory: null,
      errorRequestId: null,
      errorMessage: null,
      errorRetryable: null,
      retryAfterSeconds: null,
      suggestedAction: null,
    }).where(and(
      eq(motionVideoJobs.id, candidate.id),
      eq(motionVideoJobs.status, candidate.status),
    )).returning().all()[0] ?? null;
    if (!claimed) return null;
    if (claimed.generationItemId) {
      tx.update(generationOperationItems).set({
        status: "running",
        requestHash: claimed.requestHash,
        attempts: sql`CASE WHEN ${generationOperationItems.status} = 'pending' THEN ${generationOperationItems.attempts} + 1 ELSE ${generationOperationItems.attempts} END`,
        leaseExpiresAt: new Date(now.getTime() + MOTION_VIDEO_USAGE_DEADLINE_MS),
        startedAt: sql`COALESCE(${generationOperationItems.startedAt}, ${Math.floor(now.getTime() / 1000)})`,
        updatedAt: now,
      }).where(and(
        eq(generationOperationItems.id, claimed.generationItemId),
        inArray(generationOperationItems.status, ["pending", "running"]),
      )).run();
    }
    if (claimed.generationUsageId) {
      tx.update(generationUsage).set({ status: "running", updatedAt: now })
        .where(eq(generationUsage.id, claimed.generationUsageId)).run();
    }
    return claimed;
  });
}

function validLeaseWhere(jobId: string, workerId: string, leaseToken: string, now: Date) {
  return and(
    eq(motionVideoJobs.id, jobId),
    inArray(motionVideoJobs.status, LEASED_STATUSES),
    eq(motionVideoJobs.leaseOwner, workerId),
    eq(motionVideoJobs.leaseToken, leaseToken),
    gt(motionVideoJobs.leaseExpiresAt, now),
  );
}

export function heartbeatMotionVideoJob(
  jobId: string,
  workerId: string,
  leaseToken: string,
  now = new Date(),
): boolean {
  return getDb().transaction((tx) => {
    const job = tx.select().from(motionVideoJobs)
      .where(validLeaseWhere(jobId, workerId, leaseToken, now)).limit(1).all()[0];
    if (!job) return false;
    const updated = tx.update(motionVideoJobs).set({
      heartbeatAt: now,
      leaseExpiresAt: new Date(now.getTime() + MOTION_VIDEO_JOB_LEASE_MS),
      updatedAt: now,
    }).where(validLeaseWhere(jobId, workerId, leaseToken, now))
      .returning({ id: motionVideoJobs.id }).all();
    if (updated.length !== 1) return false;
    updateGenerationItemDeadline(tx, job, now);
    return true;
  });
}

export function checkpointMotionRemoteTask(
  jobId: string,
  workerId: string,
  leaseToken: string,
  remoteTaskId: string,
  now = new Date(),
): MotionVideoJobRecord {
  const normalized = remoteTaskId.trim();
  if (!normalized || normalized.length > 2_000) throw new MotionVideoJobInputError("remoteTaskId 不合法");
  const updated = getDb().update(motionVideoJobs).set({
    remoteTaskId: normalized,
    status: "polling",
    // taskId 是供应商已受理付费请求的持久证据；远端随后失败/超时也不能退还本次应用额度。
    paidCapabilityUsed: true,
    submittedAt: now,
    updatedAt: now,
  }).where(and(
    validLeaseWhere(jobId, workerId, leaseToken, now),
    eq(motionVideoJobs.status, "submitting"),
    isNull(motionVideoJobs.remoteTaskId),
  )).returning().all()[0];
  if (!updated) throw new MotionVideoJobLeaseLostError();
  return updated;
}

function releaseToSubmitted(
  jobId: string,
  workerId: string,
  leaseToken: string,
  now: Date,
  delayMs: number,
  countAttempt: boolean,
  progress: number | null,
  error?: unknown,
): boolean {
  const dto = error ? motionVideoErrorDto(error) : null;
  const updated = getDb().update(motionVideoJobs).set({
    status: "submitted",
    pollAttempts: countAttempt ? sql`${motionVideoJobs.pollAttempts} + 1` : sql`${motionVideoJobs.pollAttempts}`,
    progress,
    availableAt: new Date(now.getTime() + Math.max(0, delayMs)),
    leaseOwner: null,
    leaseToken: null,
    leaseExpiresAt: null,
    heartbeatAt: now,
    errorCode: dto?.code ?? null,
    errorCategory: dto?.category ?? null,
    errorRequestId: dto?.requestId ?? null,
    errorMessage: dto?.message.slice(0, MAX_ERROR_LENGTH) ?? null,
    errorRetryable: dto?.retryable ?? null,
    retryAfterSeconds: dto?.retryAfterSeconds ?? null,
    suggestedAction: dto?.suggestedAction ?? null,
    updatedAt: now,
  }).where(and(
    validLeaseWhere(jobId, workerId, leaseToken, now),
    inArray(motionVideoJobs.status, ["polling", "downloading", "saving"]),
    sql`${motionVideoJobs.remoteTaskId} IS NOT NULL`,
  )).returning({ id: motionVideoJobs.id }).all();
  return updated.length === 1;
}

export function releaseMotionAfterSubmission(
  jobId: string,
  workerId: string,
  leaseToken: string,
  now = new Date(),
): boolean {
  return releaseToSubmitted(jobId, workerId, leaseToken, now, MOTION_VIDEO_JOB_POLL_INTERVAL_MS, false, 0);
}

export function rescheduleMotionPoll(
  jobId: string,
  workerId: string,
  leaseToken: string,
  options: { now?: Date; delayMs?: number; progress?: number | null; error?: unknown } = {},
): boolean {
  return releaseToSubmitted(
    jobId,
    workerId,
    leaseToken,
    options.now ?? new Date(),
    options.delayMs ?? MOTION_VIDEO_JOB_POLL_INTERVAL_MS,
    true,
    options.progress ?? null,
    options.error,
  );
}

export function checkpointMotionDownloading(
  jobId: string,
  workerId: string,
  leaseToken: string,
  remoteUrl: string,
  now = new Date(),
): MotionVideoJobRecord {
  if (!/^https:\/\//i.test(remoteUrl) || remoteUrl.length > 8_000) {
    throw new MotionVideoJobInputError("供应商返回的视频 URL 不合法");
  }
  const updated = getDb().update(motionVideoJobs).set({
    status: "downloading",
    result: { remoteUrl },
    progress: 100,
    paidCapabilityUsed: true,
    updatedAt: now,
  }).where(and(
    validLeaseWhere(jobId, workerId, leaseToken, now),
    eq(motionVideoJobs.status, "polling"),
    sql`${motionVideoJobs.remoteTaskId} IS NOT NULL`,
  )).returning().all()[0];
  if (!updated) throw new MotionVideoJobLeaseLostError();
  return updated;
}

export function checkpointMotionSaving(
  jobId: string,
  workerId: string,
  leaseToken: string,
  outputFilePath: string,
  now = new Date(),
): MotionVideoJobRecord {
  if (!outputFilePath.startsWith("/api/files/")) throw new MotionVideoJobInputError("输出文件引用不合法");
  const updated = getDb().update(motionVideoJobs).set({
    status: "saving",
    outputFilePath,
    updatedAt: now,
  }).where(and(
    validLeaseWhere(jobId, workerId, leaseToken, now),
    eq(motionVideoJobs.status, "downloading"),
  )).returning().all()[0];
  if (!updated) throw new MotionVideoJobLeaseLostError();
  return updated;
}

export function completeMotionVideoJob(
  jobId: string,
  workerId: string,
  leaseToken: string,
  now = new Date(),
): MotionVideoJobRecord {
  return getDb().transaction((tx) => {
    const job = tx.select().from(motionVideoJobs)
      .where(validLeaseWhere(jobId, workerId, leaseToken, now)).limit(1).all()[0];
    if (!job || job.status !== "saving" || !job.sourceAssetId || !job.outputFilePath) {
      throw new MotionVideoJobLeaseLostError();
    }
    const payload = parsePayload(job);
    const sourceAsset = tx.select({ id: assets.id }).from(assets).where(and(
      eq(assets.id, job.sourceAssetId),
      eq(assets.projectId, job.projectId),
      eq(assets.shotId, job.shotId),
      eq(assets.filePath, payload.source.imageRef),
      eq(assets.status, "done"),
    )).limit(1).all()[0];
    if (!sourceAsset) {
      throw new MotionVideoSourceChangedError();
    }
    // 保留源分镜图与其资格/人脸审计；动态结果独立写 video_clips，compose 按最新 done clip 取用。
    const outputClip = tx.insert(videoClips).values({
      projectId: job.projectId,
      shotId: job.shotId,
      assetId: sourceAsset.id,
      filePath: job.outputFilePath,
      duration: Math.round(payload.options.duration * 1000),
      provider: payload.endpoint.provider,
      model: payload.endpoint.model,
      transitionType: payload.lastFrame ? "ai_start_end" : "ai_reference",
      status: "done",
      createdAt: now,
    }).returning({ id: videoClips.id }).all()[0];
    if (!outputClip) throw new Error("动态视频片段落库失败");
    const completed = tx.update(motionVideoJobs).set({
      status: "succeeded",
      result: { videoUrl: job.outputFilePath },
      outputClipId: outputClip.id,
      progress: 100,
      leaseOwner: null,
      leaseToken: null,
      leaseExpiresAt: null,
      heartbeatAt: now,
      errorCode: null,
      errorCategory: null,
      errorRequestId: null,
      errorMessage: null,
      errorRetryable: null,
      retryAfterSeconds: null,
      suggestedAction: null,
      finishedAt: now,
      updatedAt: now,
    }).where(and(
      validLeaseWhere(jobId, workerId, leaseToken, now),
      eq(motionVideoJobs.status, "saving"),
    )).returning().all()[0];
    if (!completed) throw new MotionVideoJobLeaseLostError();
    settleGenerationItem(tx, job, true, "", now);
    return completed;
  });
}

function rescheduleRateLimitedSubmit(
  jobId: string,
  workerId: string,
  leaseToken: string,
  error: MotionVideoRateLimitedError,
  now: Date,
): boolean {
  const retryAfterSeconds = boundedRetryAfterSeconds(error.retryAfterSeconds, 60);
  return getDb().update(motionVideoJobs).set({
    status: "pending",
    availableAt: new Date(now.getTime() + retryAfterSeconds * 1000),
    leaseOwner: null,
    leaseToken: null,
    leaseExpiresAt: null,
    heartbeatAt: now,
    errorCode: error.code,
    errorCategory: error.category,
    errorRequestId: error.requestId ?? null,
    errorMessage: error.message,
    errorRetryable: true,
    retryAfterSeconds,
    suggestedAction: error.suggestedAction,
    updatedAt: now,
  }).where(and(
    validLeaseWhere(jobId, workerId, leaseToken, now),
    eq(motionVideoJobs.status, "submitting"),
    isNull(motionVideoJobs.remoteTaskId),
  )).returning({ id: motionVideoJobs.id }).all().length === 1;
}

function isTerminalCheckpointedError(error: unknown): boolean {
  return error instanceof MotionVideoRemoteTaskError
    || error instanceof MotionVideoSourceChangedError
    || error instanceof MotionVideoJobInputError;
}

export function failClaimedMotionVideoJob(
  jobId: string,
  workerId: string,
  leaseToken: string,
  error: unknown,
  now = new Date(),
): boolean {
  if (error instanceof MotionVideoRateLimitedError) {
    return rescheduleRateLimitedSubmit(jobId, workerId, leaseToken, error, now);
  }
  if (error instanceof MotionVideoPollRetryableError) {
    return rescheduleMotionPoll(jobId, workerId, leaseToken, {
      now,
      delayMs: boundedRetryAfterSeconds(error.retryAfterSeconds, 5) * 1000,
      error,
    });
  }
  // taskId 已落库后，未知的心跳/磁盘/下载/DB 瞬时错误不是远程任务失败证据。
  // 保留 taskId 重新排队，下一个 worker 仍只会 GET/下载/保存，绝不重发付费 POST。
  // 只有供应商明确终态失败、素材已更换或 payload 不可恢复才允许终态化。
  if (!isTerminalCheckpointedError(error)) {
    const checkpointed = getDb().select({ remoteTaskId: motionVideoJobs.remoteTaskId })
      .from(motionVideoJobs)
      .where(validLeaseWhere(jobId, workerId, leaseToken, now))
      .limit(1).all()[0];
    if (checkpointed?.remoteTaskId) {
      const safe = motionVideoErrorDto(error);
      return rescheduleMotionPoll(jobId, workerId, leaseToken, {
        now,
        delayMs: 10_000,
        error: new MotionVideoPollRetryableError(
          10,
          safe.category,
          "已保留 taskId；本地后处理暂时失败，后台会继续恢复",
          safe.requestId,
        ),
      });
    }
  }
  const dto = motionVideoErrorDto(error);
  const uncertain = error instanceof MotionVideoSubmissionUncertainError || dto.code === "SUBMISSION_UNCERTAIN";
  return getDb().transaction((tx) => {
    const job = tx.select().from(motionVideoJobs)
      .where(validLeaseWhere(jobId, workerId, leaseToken, now)).limit(1).all()[0];
    if (!job) return false;
    const updated = tx.update(motionVideoJobs).set({
      status: uncertain ? "submission_uncertain" : "failed",
      leaseOwner: null,
      leaseToken: null,
      leaseExpiresAt: null,
      heartbeatAt: now,
      errorCode: uncertain ? "SUBMISSION_UNCERTAIN" : dto.code,
      errorCategory: dto.category,
      errorRequestId: dto.requestId ?? null,
      errorMessage: dto.message.slice(0, MAX_ERROR_LENGTH),
      errorRetryable: false,
      retryAfterSeconds: null,
      suggestedAction: dto.suggestedAction ?? null,
      finishedAt: now,
      updatedAt: now,
    }).where(validLeaseWhere(jobId, workerId, leaseToken, now))
      .returning({ id: motionVideoJobs.id }).all()[0];
    if (!updated) return false;
    settleGenerationItem(tx, job, job.paidCapabilityUsed, dto.code, now);
    return true;
  });
}

/** 有 taskId 的中断只恢复 GET；无 taskId 的 submitting 中断永久 uncertain。 */
export function recoverExpiredMotionVideoJobs(now = new Date()): RecoverMotionVideoJobsResult {
  const timedOut = expireExhaustedPolls(now);
  return getDb().transaction((tx) => {
    const expired = tx.select().from(motionVideoJobs).where(and(
      inArray(motionVideoJobs.status, LEASED_STATUSES),
      or(isNull(motionVideoJobs.leaseExpiresAt), lte(motionVideoJobs.leaseExpiresAt, now)),
    )).orderBy(
      asc(motionVideoJobs.createdAt),
      asc(sql<number>`${motionVideoJobs}._rowid_`),
    ).all();
    const result: RecoverMotionVideoJobsResult = { resumed: [], uncertain: [], timedOut };
    for (const job of expired) {
      if (job.remoteTaskId) {
        const updated = tx.update(motionVideoJobs).set({
          status: "submitted",
          availableAt: now,
          leaseOwner: null,
          leaseToken: null,
          leaseExpiresAt: null,
          errorCode: "LEASE_EXPIRED_RESUME_POLL",
          errorCategory: "unknown",
          errorRequestId: null,
          errorMessage: "worker 中断，taskId 已持久化；只恢复查询/下载，不会重新提交",
          errorRetryable: true,
          suggestedAction: "wait_and_retry",
          updatedAt: now,
        }).where(and(eq(motionVideoJobs.id, job.id), eq(motionVideoJobs.status, job.status)))
          .returning({ id: motionVideoJobs.id }).all()[0];
        if (updated) result.resumed.push(job.id);
        continue;
      }
      const updated = tx.update(motionVideoJobs).set({
        status: "submission_uncertain",
        leaseOwner: null,
        leaseToken: null,
        leaseExpiresAt: null,
        errorCode: "SUBMISSION_UNCERTAIN",
        errorCategory: "unknown",
        errorRequestId: null,
        errorMessage: "worker 在提交阶段中断且没有 taskId；为避免重复计费已禁止自动重提",
        errorRetryable: false,
        suggestedAction: "contact_support",
        finishedAt: now,
        updatedAt: now,
      }).where(and(eq(motionVideoJobs.id, job.id), eq(motionVideoJobs.status, job.status)))
        .returning({ id: motionVideoJobs.id }).all()[0];
      if (!updated) continue;
      settleGenerationItem(tx, job, false, "SUBMISSION_UNCERTAIN", now);
      result.uncertain.push(job.id);
    }
    return result;
  });
}

export function terminalMotionJobStatuses(): readonly MotionVideoJobStatus[] {
  return TERMINAL_STATUSES;
}
