import "server-only";

import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { getDb } from "@backend/db";
import { jobs } from "@backend/db/schema";
import { checkReadiness, type ReadinessResult } from "@backend/core/ops/health";
import { getAgentStrategy } from "@server/admin/agents";
import type { AgentRunRecord } from "@server/admin/agents/types";

const DAY_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_BACKUP_MAX_AGE_MS = 7 * 60 * 60 * 1_000;
const DEFAULT_PENDING_AGE_MS = 10 * 60 * 1_000;

export type OpsSeverity = "critical" | "warning" | "info";

export interface OpsAlert {
  id: string;
  severity: OpsSeverity;
  title: string;
  detail: string;
  action: string;
}

export interface OpsJobSample {
  status: "pending" | "running" | "succeeded" | "failed" | "cancelled";
  createdAt: Date | null;
  leaseExpiresAt: Date | null;
  errorCode: string | null;
}

export interface OpsBackupState {
  configured: boolean;
  available: boolean;
  latestCompletedAt: string | null;
  ageMs: number | null;
}

export interface OpsSnapshot {
  generatedAt: string;
  status: "healthy" | "warning" | "critical";
  readiness: Record<keyof ReadinessResult["checks"], boolean>;
  queue: {
    pending: number;
    running: number;
    failed24h: number;
    cancelled24h: number;
    oldestPendingAgeMs: number | null;
    expiredLeases: number;
  };
  providers: {
    attempts24h: number;
    failures24h: number;
    failureRate24h: number;
    rateLimited24h: number;
    billingFailures24h: number;
    provider5xx24h: number;
    fallbacks24h: number;
  };
  costs: {
    successfulAttempts24h: number;
    pricedAttempts24h: number;
    /** 没有成功样本时为 null，不能把“无样本”显示成 100%。 */
    coverageRate24h: number | null;
    knownCostUsd24h: number;
  };
  backup: OpsBackupState;
  alerts: OpsAlert[];
}

function numberEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function alert(
  alerts: OpsAlert[],
  id: string,
  severity: OpsSeverity,
  title: string,
  detail: string,
  action: string,
) {
  alerts.push({ id, severity, title, detail, action });
}

export function summarizeOps(input: {
  now: Date;
  readiness: ReadinessResult;
  jobs: readonly OpsJobSample[];
  runs: readonly AgentRunRecord[];
  backup: OpsBackupState;
  thresholds?: {
    pendingCount?: number;
    pendingAgeMs?: number;
    failureRate?: number;
    rateLimitCount?: number;
    backupAgeMs?: number;
    knownCostUsd?: number | null;
  };
}): OpsSnapshot {
  const nowMs = input.now.getTime();
  const since = nowMs - DAY_MS;
  const thresholds = {
    pendingCount: input.thresholds?.pendingCount ?? 5,
    pendingAgeMs: input.thresholds?.pendingAgeMs ?? DEFAULT_PENDING_AGE_MS,
    failureRate: input.thresholds?.failureRate ?? 0.2,
    rateLimitCount: input.thresholds?.rateLimitCount ?? 3,
    backupAgeMs: input.thresholds?.backupAgeMs ?? DEFAULT_BACKUP_MAX_AGE_MS,
    knownCostUsd: input.thresholds?.knownCostUsd ?? null,
  };
  const recentJobs = input.jobs.filter((job) => (job.createdAt?.getTime() ?? 0) >= since);
  const pendingJobs = input.jobs.filter((job) => job.status === "pending");
  const oldestPendingAgeMs = pendingJobs.length
    ? Math.max(...pendingJobs.map((job) => Math.max(0, nowMs - (job.createdAt?.getTime() ?? nowMs))))
    : null;
  const expiredLeases = input.jobs.filter(
    (job) => job.status === "running" && job.leaseExpiresAt && job.leaseExpiresAt.getTime() < nowMs,
  ).length;
  const queue = {
    pending: pendingJobs.length,
    running: input.jobs.filter((job) => job.status === "running").length,
    failed24h: recentJobs.filter((job) => job.status === "failed").length,
    cancelled24h: recentJobs.filter((job) => job.status === "cancelled").length,
    oldestPendingAgeMs,
    expiredLeases,
  };

  const recentRuns = input.runs.filter((run) => Date.parse(run.createdAt) >= since);
  const failedRuns = recentRuns.filter((run) => !run.success);
  const successfulRuns = recentRuns.filter((run) => run.success);
  const pricedRuns = successfulRuns.filter((run) => run.costUsd !== null);
  const providers = {
    attempts24h: recentRuns.length,
    failures24h: failedRuns.length,
    failureRate24h: recentRuns.length ? failedRuns.length / recentRuns.length : 0,
    rateLimited24h: failedRuns.filter((run) => run.errorCategory === "rate_limit").length,
    billingFailures24h: failedRuns.filter((run) => run.errorCategory === "billing").length,
    provider5xx24h: failedRuns.filter((run) => run.errorCategory === "provider_5xx").length,
    fallbacks24h: recentRuns.filter((run) => run.endpointRole === "fallback").length,
  };
  const knownCostUsd24h = pricedRuns.reduce((sum, run) => sum + (run.costUsd ?? 0), 0);
  const costs = {
    successfulAttempts24h: successfulRuns.length,
    pricedAttempts24h: pricedRuns.length,
    coverageRate24h: successfulRuns.length ? pricedRuns.length / successfulRuns.length : null,
    knownCostUsd24h,
  };
  const readiness = Object.fromEntries(
    Object.entries(input.readiness.checks).map(([key, value]) => [key, value.ok]),
  ) as OpsSnapshot["readiness"];

  const alerts: OpsAlert[] = [];
  const failedChecks = Object.entries(readiness).filter(([, ok]) => !ok).map(([key]) => key);
  if (failedChecks.length) {
    alert(alerts, "readiness", "critical", "实例未就绪", `${failedChecks.join("、")} 检查失败`, "先摘流，检查数据库、数据卷、磁盘和 FFmpeg");
  }
  if (queue.expiredLeases > 0) {
    alert(alerts, "expired-leases", "critical", "存在过期运行租约", `${queue.expiredLeases} 个任务仍显示 running`, "确认 worker 存活并执行恢复演练，禁止手工改任务状态");
  }
  if (queue.pending >= thresholds.pendingCount || (oldestPendingAgeMs ?? 0) >= thresholds.pendingAgeMs) {
    alert(alerts, "queue-backlog", "warning", "合成队列积压", `${queue.pending} 个待执行，最老等待 ${Math.round((oldestPendingAgeMs ?? 0) / 60_000)} 分钟`, "检查 worker、FFmpeg 和供应商延迟，暂停新增邀请任务");
  }
  if (queue.failed24h > 0) {
    alert(alerts, "job-failures", queue.failed24h >= 3 ? "critical" : "warning", "持久任务失败", `近 24 小时 ${queue.failed24h} 个终态失败`, "查看任务错误码与对应项目，确认是否可安全重试");
  }
  if (providers.billingFailures24h > 0) {
    alert(alerts, "billing", "critical", "模型供应商欠费或额度不足", `近 24 小时 ${providers.billingFailures24h} 次`, "立即检查余额与预算上限；备用供应商可用前暂停生成");
  }
  if (providers.rateLimited24h >= thresholds.rateLimitCount) {
    alert(alerts, "rate-limit", "warning", "供应商 429 增多", `近 24 小时 ${providers.rateLimited24h} 次`, "降低并发并核对供应商限额，观察 fallback 是否健康");
  }
  if (providers.failureRate24h > thresholds.failureRate && providers.attempts24h >= 5) {
    alert(alerts, "provider-failure-rate", "warning", "模型调用失败率偏高", `近 24 小时 ${(providers.failureRate24h * 100).toFixed(1)}%`, "按错误分类排查主模型并执行备用切换演练");
  }
  if (costs.coverageRate24h !== null && costs.coverageRate24h < 1) {
    alert(alerts, "cost-coverage", "warning", "真实成本遥测不完整", `仅 ${(costs.coverageRate24h * 100).toFixed(1)}% 的成功 attempt 有真实成本`, "补齐供应商 usage/账单回传；成本未知时禁止声称模型已通过性价比门禁");
  }
  if (thresholds.knownCostUsd !== null && knownCostUsd24h > thresholds.knownCostUsd) {
    alert(alerts, "daily-cost", "critical", "24 小时已知模型成本超阈值", `$${knownCostUsd24h.toFixed(4)} > $${thresholds.knownCostUsd.toFixed(4)}`, "暂停高成本入口并核对异常请求与供应商账单");
  }
  if (!input.backup.configured) {
    alert(alerts, "backup-config", "critical", "未配置独立备份目录", "BACKUP_DIR 为空", "配置独立挂载并立即执行一次完整备份");
  } else if (!input.backup.available || input.backup.ageMs === null) {
    alert(alerts, "backup-missing", "critical", "没有可验证的已完成备份", "未发现含 manifest.json 的正式备份目录", "冻结新任务，执行备份并检查退出码与清单");
  } else if (input.backup.ageMs > thresholds.backupAgeMs) {
    alert(alerts, "backup-stale", "warning", "最近备份已超过 RPO", `最近完成于 ${input.backup.latestCompletedAt}`, "立即补备份并检查 6 小时调度器/通知链路");
  }
  if (alerts.length === 0) {
    alert(alerts, "healthy", "info", "当前没有触发值守阈值", "仍需按发布 SOP 做端到端人工冒烟", "继续观察失败率、队列、磁盘、备份和真实成本");
  }
  const status = alerts.some((item) => item.severity === "critical")
    ? "critical"
    : alerts.some((item) => item.severity === "warning")
      ? "warning"
      : "healthy";
  return {
    generatedAt: input.now.toISOString(),
    status,
    readiness,
    queue,
    providers,
    costs,
    backup: input.backup,
    alerts,
  };
}

async function backupState(now: Date): Promise<OpsBackupState> {
  const backupDir = process.env.BACKUP_DIR?.trim();
  if (!backupDir) return { configured: false, available: false, latestCompletedAt: null, ageMs: null };
  try {
    const evidenceFile = process.env.HUIMAI_BACKUP_EVIDENCE_FILE?.trim();
    const evidenceSha256 = process.env.HUIMAI_BACKUP_EVIDENCE_SHA256?.trim().toLowerCase();
    const receiptFile = process.env.HUIMAI_BACKUP_OFFSITE_RECEIPT_FILE?.trim();
    const receiptSha256 = process.env.HUIMAI_BACKUP_OFFSITE_RECEIPT_SHA256?.trim().toLowerCase();
    if (!evidenceFile || !/^[0-9a-f]{64}$/.test(evidenceSha256 || "")
      || !receiptFile || !/^[0-9a-f]{64}$/.test(receiptSha256 || "")) {
      throw new Error("备份验证证据或异机回执未配置");
    }
    const safeRead = async (path: string, expectedHash: string) => {
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || info.size <= 0 || info.size > 5 * 1024 * 1024) {
        throw new Error("备份证据文件类型不安全");
      }
      const content = await readFile(path);
      if (createHash("sha256").update(content).digest("hex") !== expectedHash) {
        throw new Error("备份证据 SHA-256 不匹配");
      }
      return JSON.parse(content.toString("utf8")) as Record<string, unknown>;
    };
    const evidence = await safeRead(evidenceFile, evidenceSha256!);
    await safeRead(receiptFile, receiptSha256!);
    const backupName = typeof evidence.backupName === "string" ? evidence.backupName : "";
    const manifestSha256 = typeof evidence.manifestSha256 === "string" ? evidence.manifestSha256 : "";
    const completedAt = typeof evidence.backupCreatedAt === "string" ? evidence.backupCreatedAt : "";
    const completedMs = Date.parse(completedAt);
    if (evidence.schemaVersion !== 1 || evidence.writesFrozen !== true
      || !/^backup-[a-zA-Z0-9-]{10,200}$/.test(backupName)
      || !/^[0-9a-f]{64}$/.test(manifestSha256)
      || !Number.isFinite(completedMs) || new Date(completedMs).toISOString() !== completedAt) {
      throw new Error("备份验证证据格式无效");
    }
    const manifestContent = await readFile(join(backupDir, backupName, "manifest.json"));
    if (createHash("sha256").update(manifestContent).digest("hex") !== manifestSha256) {
      throw new Error("正式备份 manifest 与验证证据不一致");
    }
    return {
      configured: true,
      available: true,
      latestCompletedAt: completedAt,
      ageMs: Math.max(0, now.getTime() - completedMs),
    };
  } catch {
    return { configured: true, available: false, latestCompletedAt: null, ageMs: null };
  }
}

export async function getOpsSnapshot(now = new Date()): Promise<OpsSnapshot> {
  const db = getDb();
  const [readiness, state, backup] = await Promise.all([
    checkReadiness(),
    getAgentStrategy(),
    backupState(now),
  ]);
  const jobRows = db.select({
    status: jobs.status,
    createdAt: jobs.createdAt,
    leaseExpiresAt: jobs.leaseExpiresAt,
    errorCode: jobs.errorCode,
  }).from(jobs).all();
  return summarizeOps({
    now,
    readiness,
    jobs: jobRows,
    runs: state.runs,
    backup,
    thresholds: {
      pendingCount: numberEnv("HUIMAI_ALERT_PENDING_JOBS", 5),
      pendingAgeMs: numberEnv("HUIMAI_ALERT_PENDING_AGE_MS", DEFAULT_PENDING_AGE_MS),
      failureRate: numberEnv("HUIMAI_ALERT_MODEL_FAILURE_RATE", 0.2),
      rateLimitCount: numberEnv("HUIMAI_ALERT_RATE_LIMIT_COUNT", 3),
      backupAgeMs: numberEnv("HUIMAI_ALERT_BACKUP_AGE_MS", DEFAULT_BACKUP_MAX_AGE_MS),
      knownCostUsd: process.env.HUIMAI_ALERT_DAILY_COST_USD
        ? numberEnv("HUIMAI_ALERT_DAILY_COST_USD", Number.MAX_SAFE_INTEGER)
        : null,
    },
  });
}
