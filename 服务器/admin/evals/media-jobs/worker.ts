import "server-only";

import { hostname } from "node:os";

import {
  checkpointGoldenMediaRemoteTask,
  claimNextGoldenMediaEvalJob,
  completeGoldenMediaEvalJob,
  completeGoldenTtsEvalJob,
  failGoldenMediaEvalJob,
  GoldenMediaJobRetryableError,
  GOLDEN_MEDIA_JOB_HEARTBEAT_MS,
  heartbeatGoldenMediaEvalJob,
  recoverExpiredGoldenMediaEvalJobs,
  releaseGoldenMediaAfterSubmission,
  rescheduleGoldenMediaPoll,
  sanitizeGoldenMediaJobError,
  type GoldenMediaEvalJobRecord,
  type RecoverGoldenMediaEvalJobsResult,
} from "./repository";
import {
  executePersistedGoldenTtsEvalJob,
  pollPersistedGoldenMediaEvalJob,
  reconcilePersistedGoldenTtsEvalJob,
  submitPersistedGoldenMediaEvalJob,
} from "./processor";
import { GoldenMediaSubmissionUncertainError } from "./provider-adapter";

const DEFAULT_WORKER_IDLE_MS = 1_000;

export type GoldenMediaJobPollOutcome =
  | { state: "pending"; delayMs?: number }
  | {
      state: "completed";
      result: Record<string, unknown>;
      artifactUrls: string[];
    };

export interface GoldenMediaEvalWorkerDependencies {
  recover(now?: Date): RecoverGoldenMediaEvalJobsResult;
  reconcileTts(): Promise<boolean>;
  claim(workerId: string, now?: Date): GoldenMediaEvalJobRecord | null;
  heartbeat(jobId: string, workerId: string, leaseToken: string, now?: Date): boolean;
  submit(job: GoldenMediaEvalJobRecord): Promise<string>;
  executeTts(job: GoldenMediaEvalJobRecord): Promise<GoldenMediaJobPollOutcome>;
  checkpoint(
    jobId: string,
    workerId: string,
    leaseToken: string,
    remoteTaskId: string,
    now?: Date,
  ): GoldenMediaEvalJobRecord;
  releaseAfterSubmission(jobId: string, workerId: string, leaseToken: string, now?: Date): boolean;
  poll(job: GoldenMediaEvalJobRecord): Promise<GoldenMediaJobPollOutcome>;
  reschedule(
    jobId: string,
    workerId: string,
    leaseToken: string,
    options?: { now?: Date; delayMs?: number; error?: unknown },
  ): boolean;
  complete(
    jobId: string,
    workerId: string,
    leaseToken: string,
    result: Record<string, unknown>,
    artifactUrls: string[],
    now?: Date,
  ): GoldenMediaEvalJobRecord;
  completeTts(
    jobId: string,
    workerId: string,
    leaseToken: string,
    result: Record<string, unknown>,
    artifactUrls: string[],
    now?: Date,
  ): GoldenMediaEvalJobRecord;
  fail(jobId: string, workerId: string, leaseToken: string, error: unknown, now?: Date): boolean;
}

const DEFAULT_DEPENDENCIES: GoldenMediaEvalWorkerDependencies = {
  recover: recoverExpiredGoldenMediaEvalJobs,
  reconcileTts: reconcilePersistedGoldenTtsEvalJob,
  claim: claimNextGoldenMediaEvalJob,
  heartbeat: heartbeatGoldenMediaEvalJob,
  submit: submitPersistedGoldenMediaEvalJob,
  executeTts: executePersistedGoldenTtsEvalJob,
  checkpoint: checkpointGoldenMediaRemoteTask,
  releaseAfterSubmission: releaseGoldenMediaAfterSubmission,
  poll: pollPersistedGoldenMediaEvalJob,
  reschedule: rescheduleGoldenMediaPoll,
  complete: completeGoldenMediaEvalJob,
  completeTts: completeGoldenTtsEvalJob,
  fail: failGoldenMediaEvalJob,
};

function idleMs() {
  const configured = Number(process.env.HUIMAI_GOLDEN_MEDIA_JOB_POLL_INTERVAL_MS);
  if (!Number.isFinite(configured)) return DEFAULT_WORKER_IDLE_MS;
  return Math.min(10_000, Math.max(100, Math.floor(configured)));
}

export class GoldenMediaEvalJobWorker {
  readonly workerId: string;
  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly dependencies: GoldenMediaEvalWorkerDependencies = DEFAULT_DEPENDENCIES,
    workerId = `${hostname()}:${process.pid}:golden-media:${crypto.randomUUID()}`,
  ) {
    this.workerId = workerId;
  }

  async runOnce(): Promise<boolean> {
    const recovered = this.dependencies.recover();
    if (recovered.resumed.length || recovered.uncertain.length || recovered.timedOut.length) {
      console.warn(
        `[golden-media-jobs] 恢复完成：resumed=${recovered.resumed.length}, uncertain=${recovered.uncertain.length}, timedOut=${recovered.timedOut.length}`,
      );
    }
    if (await this.dependencies.reconcileTts()) {
      console.info("[golden-media-jobs] 已将崩溃窗口中完成落盘的 TTS one-shot 收敛为 succeeded");
      return true;
    }

    const job = this.dependencies.claim(this.workerId);
    if (!job) return false;
    const leaseToken = job.leaseToken;
    if (!leaseToken) {
      console.error(`[golden-media-jobs] claim ${job.id} 未返回 leaseToken`);
      return true;
    }

    let leaseLost = false;
    const heartbeat = setInterval(() => {
      try {
        if (!this.dependencies.heartbeat(job.id, this.workerId, leaseToken)) leaseLost = true;
      } catch (error) {
        console.error(`[golden-media-jobs] heartbeat ${job.id} 失败：${sanitizeGoldenMediaJobError(error)}`);
      }
    }, GOLDEN_MEDIA_JOB_HEARTBEAT_MS);
    heartbeat.unref?.();

    try {
      if (!job.remoteTaskId) {
        if (job.requestKind === "tts-generation") {
          // TTS 无 taskId：job 已先持久为 submitting，之后只执行一次付费 one-shot。
          const outcome = await this.dependencies.executeTts(job);
          if (outcome.state !== "completed") throw new Error("TTS one-shot 未返回终态产物");
          if (leaseLost) throw new Error("TTS one-shot 期间租约已失效，禁止旧 worker 回写");
          try {
            this.dependencies.completeTts(
              job.id,
              this.workerId,
              leaseToken,
              outcome.result,
              outcome.artifactUrls,
            );
          } catch {
            throw new GoldenMediaSubmissionUncertainError("tts-local-finalize");
          }
          console.info(`[golden-media-jobs] ${job.id} TTS one-shot succeeded`);
          return true;
        }
        // job 已在 claim 事务中持久为 submitting，这里才允许发唯一一次付费 POST。
        const remoteTaskId = await this.dependencies.submit(job);
        this.dependencies.checkpoint(job.id, this.workerId, leaseToken, remoteTaskId);
        if (!this.dependencies.releaseAfterSubmission(job.id, this.workerId, leaseToken)) {
          throw new GoldenMediaJobRetryableError("已持久化 taskId，但释放轮询租约失败；将由恢复器继续");
        }
        console.info(`[golden-media-jobs] ${job.id} submitted，taskId 已持久化`);
        return true;
      }

      const outcome = await this.dependencies.poll(job);
      if (leaseLost) throw new Error("轮询期间租约已失效，旧 worker 不会覆盖新状态");
      if (outcome.state === "pending") {
        if (!this.dependencies.reschedule(job.id, this.workerId, leaseToken, { delayMs: outcome.delayMs })) {
          throw new Error("轮询任务重新排队失败");
        }
        return true;
      }

      try {
        this.dependencies.complete(
          job.id,
          this.workerId,
          leaseToken,
          outcome.result,
          outcome.artifactUrls,
        );
      } catch {
        // 评测记录/产物可能已落盘；不能因 job 终态 checkpoint 短暂失败就标记永久失败。
        throw new GoldenMediaJobRetryableError("Golden 产物已生成，job 终态回写待恢复");
      }
      console.info(`[golden-media-jobs] ${job.id} succeeded`);
    } catch (error) {
      const persisted = this.dependencies.fail(job.id, this.workerId, leaseToken, error);
      if (persisted) {
        console.error(`[golden-media-jobs] ${job.id} 处理失败：${sanitizeGoldenMediaJobError(error)}`);
      } else {
        console.warn(`[golden-media-jobs] ${job.id} 已失去租约，忽略旧 worker 回写`);
      }
    } finally {
      clearInterval(heartbeat);
    }
    return true;
  }

  start() {
    if (this.running) return;
    this.running = true;
    const loop = async () => {
      if (!this.running) return;
      try {
        const handled = await this.runOnce();
        this.schedule(loop, handled ? 0 : idleMs());
      } catch (error) {
        console.error(`[golden-media-jobs] worker loop error：${sanitizeGoldenMediaJobError(error)}`);
        this.schedule(loop, idleMs());
      }
    };
    void loop();
  }

  stop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(callback: () => Promise<void>, delayMs: number) {
    if (!this.running) return;
    this.timer = setTimeout(() => void callback(), delayMs);
    this.timer.unref?.();
  }
}

declare global {
  var __huimaiGoldenMediaEvalJobWorker: GoldenMediaEvalJobWorker | undefined;
}

export function startGoldenMediaEvalJobWorker() {
  if (globalThis.__huimaiGoldenMediaEvalJobWorker) return globalThis.__huimaiGoldenMediaEvalJobWorker;
  const worker = new GoldenMediaEvalJobWorker();
  globalThis.__huimaiGoldenMediaEvalJobWorker = worker;
  worker.start();
  console.info(`[golden-media-jobs] persistent worker started: ${worker.workerId}`);
  return worker;
}
