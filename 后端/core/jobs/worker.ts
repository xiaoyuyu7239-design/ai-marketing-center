import "server-only";

import { hostname } from "node:os";
import { runComposeJob, type ComposeJobResult } from "./compose-handler";
import {
  claimNextJob,
  completeComposeJob,
  failClaimedJob,
  heartbeatJob,
  JOB_HEARTBEAT_MS,
  recoverExpiredJobs,
  sanitizeJobError,
  type JobRecord,
} from "./repository";

const DEFAULT_POLL_INTERVAL_MS = 1_000;

export interface JobWorkerDependencies {
  recover(now?: Date): { requeued: string[]; failed: string[] };
  claim(workerId: string, now?: Date): JobRecord | null;
  heartbeat(jobId: string, workerId: string, leaseToken: string, now?: Date): boolean;
  process(job: JobRecord, workerId: string, leaseToken: string): Promise<ComposeJobResult>;
  complete(
    jobId: string,
    workerId: string,
    leaseToken: string,
    result: ComposeJobResult,
    now?: Date,
  ): void;
  fail(jobId: string, workerId: string, leaseToken: string, error: unknown, now?: Date): boolean;
}

const DEFAULT_DEPENDENCIES: JobWorkerDependencies = {
  recover: recoverExpiredJobs,
  claim: claimNextJob,
  heartbeat: heartbeatJob,
  process: runComposeJob,
  complete: completeComposeJob,
  fail: failClaimedJob,
};

function pollIntervalMs(): number {
  const configured = Number(process.env.HUIMAI_JOB_POLL_INTERVAL_MS);
  if (!Number.isFinite(configured)) return DEFAULT_POLL_INTERVAL_MS;
  return Math.min(10_000, Math.max(100, Math.floor(configured)));
}

export class PersistentJobWorker {
  readonly workerId: string;
  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly dependencies: JobWorkerDependencies = DEFAULT_DEPENDENCIES,
    workerId = `${hostname()}:${process.pid}:${crypto.randomUUID()}`,
  ) {
    this.workerId = workerId;
  }

  /** 执行一次恢复 + claim + 处理；返回是否实际 claim 到任务，便于状态机单测。 */
  async runOnce(): Promise<boolean> {
    const recovered = this.dependencies.recover();
    if (recovered.requeued.length || recovered.failed.length) {
      console.warn(
        `[jobs] lease 恢复完成：requeued=${recovered.requeued.length}, failed=${recovered.failed.length}`,
      );
    }

    const job = this.dependencies.claim(this.workerId);
    if (!job) return false;
    const leaseToken = job.leaseToken;
    if (!leaseToken) {
      console.error(`[jobs] claim ${job.id} 未返回 leaseToken`);
      return true;
    }

    let leaseLost = false;
    const heartbeat = setInterval(() => {
      try {
        if (!this.dependencies.heartbeat(job.id, this.workerId, leaseToken)) leaseLost = true;
      } catch (error) {
        console.error(`[jobs] heartbeat ${job.id} 失败: ${sanitizeJobError(error)}`);
      }
    }, JOB_HEARTBEAT_MS);
    heartbeat.unref?.();

    try {
      const result = await this.dependencies.process(job, this.workerId, leaseToken);
      if (leaseLost) throw new Error("任务执行期间租约已失效，结果不会覆盖新 worker");
      this.dependencies.complete(job.id, this.workerId, leaseToken, result);
      console.info(`[jobs] ${job.type} ${job.id} succeeded`);
    } catch (error) {
      const persisted = this.dependencies.fail(job.id, this.workerId, leaseToken, error);
      if (persisted) {
        console.error(`[jobs] ${job.type} ${job.id} failed: ${sanitizeJobError(error)}`);
      }
      else console.warn(`[jobs] ${job.type} ${job.id} 已失去租约，忽略旧 worker 的失败回写`);
    } finally {
      clearInterval(heartbeat);
    }
    return true;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const loop = async () => {
      if (!this.running) return;
      try {
        const handled = await this.runOnce();
        this.schedule(loop, handled ? 0 : pollIntervalMs());
      } catch (error) {
        console.error(`[jobs] worker loop error: ${sanitizeJobError(error)}`);
        this.schedule(loop, pollIntervalMs());
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
  var __huimaiPersistentJobWorker: PersistentJobWorker | undefined;
}

/** Next instrumentation/HMR 多次 register 也只启动一个 worker。 */
export function startPersistentJobWorker(): PersistentJobWorker {
  if (globalThis.__huimaiPersistentJobWorker) return globalThis.__huimaiPersistentJobWorker;
  const worker = new PersistentJobWorker();
  globalThis.__huimaiPersistentJobWorker = worker;
  worker.start();
  console.info(`[jobs] persistent worker started: ${worker.workerId}`);
  return worker;
}
