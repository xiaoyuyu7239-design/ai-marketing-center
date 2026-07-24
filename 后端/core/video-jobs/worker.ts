import "server-only";

import { hostname } from "node:os";

import {
  checkpointMotionDownloading,
  checkpointMotionRemoteTask,
  checkpointMotionSaving,
  claimNextMotionVideoJob,
  completeMotionVideoJob,
  failClaimedMotionVideoJob,
  heartbeatMotionVideoJob,
  MOTION_VIDEO_JOB_HEARTBEAT_MS,
  recoverExpiredMotionVideoJobs,
  releaseMotionAfterSubmission,
  rescheduleMotionPoll,
  type MotionVideoJobRecord,
  type RecoverMotionVideoJobsResult,
} from "./repository";
import {
  persistMotionVideoOutput,
  pollPersistedMotionVideoJob,
  submitPersistedMotionVideoJob,
} from "./processor";
import type { MotionVideoPollOutcome } from "./provider-adapter";
import {
  MotionVideoPollRetryableError,
  MotionVideoSubmissionUncertainError,
  motionVideoErrorDto,
} from "./errors";

const DEFAULT_IDLE_MS = 1_000;

export interface MotionVideoJobWorkerDependencies {
  recover(now?: Date): RecoverMotionVideoJobsResult;
  claim(workerId: string, now?: Date): MotionVideoJobRecord | null;
  heartbeat(jobId: string, workerId: string, leaseToken: string, now?: Date): boolean;
  submit(job: MotionVideoJobRecord): Promise<string>;
  checkpointTask(jobId: string, workerId: string, leaseToken: string, taskId: string): MotionVideoJobRecord;
  releaseAfterSubmission(jobId: string, workerId: string, leaseToken: string): boolean;
  poll(job: MotionVideoJobRecord): Promise<MotionVideoPollOutcome>;
  reschedule(
    jobId: string,
    workerId: string,
    leaseToken: string,
    options?: { delayMs?: number; progress?: number | null; error?: unknown },
  ): boolean;
  checkpointDownloading(
    jobId: string,
    workerId: string,
    leaseToken: string,
    remoteUrl: string,
  ): MotionVideoJobRecord;
  persist(job: MotionVideoJobRecord, remoteUrl: string): Promise<string>;
  checkpointSaving(
    jobId: string,
    workerId: string,
    leaseToken: string,
    outputFilePath: string,
  ): MotionVideoJobRecord;
  complete(jobId: string, workerId: string, leaseToken: string): MotionVideoJobRecord;
  fail(jobId: string, workerId: string, leaseToken: string, error: unknown): boolean;
}

const DEFAULT_DEPENDENCIES: MotionVideoJobWorkerDependencies = {
  recover: recoverExpiredMotionVideoJobs,
  claim: claimNextMotionVideoJob,
  heartbeat: heartbeatMotionVideoJob,
  submit: submitPersistedMotionVideoJob,
  checkpointTask: checkpointMotionRemoteTask,
  releaseAfterSubmission: releaseMotionAfterSubmission,
  poll: pollPersistedMotionVideoJob,
  reschedule: rescheduleMotionPoll,
  checkpointDownloading: checkpointMotionDownloading,
  persist: persistMotionVideoOutput,
  checkpointSaving: checkpointMotionSaving,
  complete: completeMotionVideoJob,
  fail: failClaimedMotionVideoJob,
};

function idleMs(): number {
  const configured = Number(process.env.HUIMAI_MOTION_JOB_IDLE_MS);
  return Number.isFinite(configured) ? Math.min(10_000, Math.max(100, Math.floor(configured))) : DEFAULT_IDLE_MS;
}

function workerConcurrency(): number {
  const configured = Number(process.env.HUIMAI_MOTION_JOB_MAX_IN_FLIGHT);
  return Number.isFinite(configured) ? Math.min(16, Math.max(1, Math.floor(configured))) : 4;
}

export class MotionVideoJobWorker {
  readonly workerId: string;
  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly dependencies: MotionVideoJobWorkerDependencies = DEFAULT_DEPENDENCIES,
    workerId = `${hostname()}:${process.pid}:motion-video:${crypto.randomUUID()}`,
  ) {
    this.workerId = workerId;
  }

  async runOnce(): Promise<boolean> {
    const job = this.dependencies.claim(this.workerId);
    if (!job) return false;
    const leaseToken = job.leaseToken;
    if (!leaseToken) {
      console.error(`[motion-video-jobs] claim ${job.id} 没有 leaseToken`);
      return true;
    }

    let leaseLost = false;
    const heartbeat = setInterval(() => {
      try {
        if (!this.dependencies.heartbeat(job.id, this.workerId, leaseToken)) leaseLost = true;
      } catch {
        leaseLost = true;
      }
    }, MOTION_VIDEO_JOB_HEARTBEAT_MS);
    heartbeat.unref?.();

    try {
      if (!job.remoteTaskId) {
        // claim 已先把状态持久为 submitting；这里才允许唯一一次付费 POST。
        const taskId = await this.dependencies.submit(job);
        // 即使一次 heartbeat 瞬时失败，也先尝试带原 lease 原子 checkpoint；成功就保住 taskId，
        // 失败才进入 uncertain，避免把可恢复的远端任务丢掉。
        try {
          this.dependencies.checkpointTask(job.id, this.workerId, leaseToken, taskId);
        } catch {
          throw new MotionVideoSubmissionUncertainError();
        }
        if (!this.dependencies.releaseAfterSubmission(job.id, this.workerId, leaseToken)) {
          throw new MotionVideoPollRetryableError(5, "unknown", "taskId 已 checkpoint；等待恢复器继续 GET");
        }
        return true;
      }

      const outcome = await this.dependencies.poll(job);
      if (leaseLost) throw new Error("轮询期间任务租约已失效");
      if (outcome.state === "pending") {
        const delayMs = (outcome.retryAfterSeconds ?? 5) * 1_000;
        if (!this.dependencies.reschedule(job.id, this.workerId, leaseToken, {
          delayMs,
          progress: outcome.progress,
        })) throw new Error("轮询任务重新排队失败");
        return true;
      }

      const downloading = this.dependencies.checkpointDownloading(
        job.id,
        this.workerId,
        leaseToken,
        outcome.remoteUrl,
      );
      const outputFilePath = await this.dependencies.persist(downloading, outcome.remoteUrl);
      if (leaseLost) throw new Error("下载期间任务租约已失效");
      this.dependencies.checkpointSaving(job.id, this.workerId, leaseToken, outputFilePath);
      this.dependencies.complete(job.id, this.workerId, leaseToken);
      console.info(`[motion-video-jobs] ${job.id} succeeded`);
    } catch (error) {
      const persisted = this.dependencies.fail(job.id, this.workerId, leaseToken, error);
      const safe = motionVideoErrorDto(error);
      if (persisted) console.error(`[motion-video-jobs] ${job.id} ${safe.code}: ${safe.message}`);
      else console.warn(`[motion-video-jobs] ${job.id} 已失去租约，忽略旧 worker 回写`);
    } finally {
      clearInterval(heartbeat);
    }
    return true;
  }

  private async runBatch(): Promise<boolean> {
    const recovered = this.dependencies.recover();
    if (recovered.resumed.length || recovered.uncertain.length || recovered.timedOut.length) {
      console.warn(
        `[motion-video-jobs] 恢复：resumed=${recovered.resumed.length}, uncertain=${recovered.uncertain.length}, timedOut=${recovered.timedOut.length}`,
      );
    }
    const handled = await Promise.all(
      Array.from({ length: workerConcurrency() }, () => this.runOnce()),
    );
    return handled.some(Boolean);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const loop = async () => {
      if (!this.running) return;
      try {
        const handled = await this.runBatch();
        this.schedule(loop, handled ? 0 : idleMs());
      } catch (error) {
        const safe = motionVideoErrorDto(error);
        console.error(`[motion-video-jobs] worker loop ${safe.code}: ${safe.message}`);
        this.schedule(loop, idleMs());
      }
    };
    void loop();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(callback: () => Promise<void>, delayMs: number): void {
    if (!this.running) return;
    this.timer = setTimeout(() => void callback(), delayMs);
    this.timer.unref?.();
  }
}

declare global {
  var __huimaiMotionVideoJobWorker: MotionVideoJobWorker | undefined;
}

export function startMotionVideoJobWorker(): MotionVideoJobWorker {
  if (globalThis.__huimaiMotionVideoJobWorker) return globalThis.__huimaiMotionVideoJobWorker;
  const worker = new MotionVideoJobWorker();
  globalThis.__huimaiMotionVideoJobWorker = worker;
  worker.start();
  console.info(`[motion-video-jobs] persistent worker started: ${worker.workerId}`);
  return worker;
}
