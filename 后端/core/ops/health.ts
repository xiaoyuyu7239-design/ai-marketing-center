import "server-only";

import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { access, open, statfs, unlink } from "node:fs/promises";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { ffmpegHealthError, ffprobeBin } from "@backend/shared/ffmpeg-path";
import { getDataDir } from "@backend/shared/paths";

const DEFAULT_MIN_FREE_DISK_BYTES = 2 * 1024 * 1024 * 1024;

type HealthCheck = {
  ok: boolean;
  error?: string;
};

export type ReadinessResult = {
  ok: boolean;
  checks: {
    database: HealthCheck;
    dataDirectory: HealthCheck;
    disk: HealthCheck;
    ffmpeg: HealthCheck;
    ffprobe: HealthCheck;
  };
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function runCheck(check: () => void | Promise<void>): Promise<HealthCheck> {
  try {
    await check();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

function minimumFreeDiskBytes(): number {
  const configured = process.env.CLIPFORGE_MIN_FREE_DISK_BYTES;
  if (!configured) return DEFAULT_MIN_FREE_DISK_BYTES;
  const value = Number(configured);
  return Number.isSafeInteger(value) && value >= 0 ? value : DEFAULT_MIN_FREE_DISK_BYTES;
}

async function checkDatabase(): Promise<void> {
  // 动态导入让迁移/打开数据库错误能被 readiness 捕获并返回 503，而不是泄漏为路由加载错误。
  const { getDb } = await import("@backend/db");
  getDb().run(sql`SELECT 1`);
}

async function checkDataDirectory(): Promise<void> {
  const dataDir = getDataDir();
  await access(dataDir, constants.R_OK | constants.W_OK);

  const probePath = join(dataDir, `.health-${process.pid}-${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(probePath, "wx", 0o600);
    await handle.writeFile("ready");
    await handle.sync();
  } finally {
    if (handle) {
      await handle.close().catch(() => undefined);
      await unlink(probePath).catch(() => undefined);
    }
  }
}

async function checkDisk(): Promise<void> {
  const stats = await statfs(getDataDir());
  const availableBytes = Number(stats.bavail) * Number(stats.bsize);
  const minimumBytes = minimumFreeDiskBytes();
  if (!Number.isFinite(availableBytes) || availableBytes < minimumBytes) {
    throw new Error(`可用磁盘空间低于阈值（${availableBytes} < ${minimumBytes} bytes）`);
  }
}

function checkFfmpeg(): void {
  const error = ffmpegHealthError();
  if (error) throw new Error(error);
}

function checkFfprobe(): void {
  const binary = ffprobeBin();
  const result = spawnSync(binary, ["-version"], {
    stdio: "ignore",
    timeout: 5_000,
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      result.error?.message ||
        `FFprobe 无法启动（退出码 ${result.status ?? "unknown"}${result.signal ? ` / ${result.signal}` : ""}）`,
    );
  }
}

/**
 * 运行接收流量前必须满足的本机依赖检查。
 * checks 中的 error 仅供服务端日志/诊断使用，不得直接返回给未认证请求。
 */
export async function checkReadiness(): Promise<ReadinessResult> {
  // 数据库初始化会创建数据目录，因此先检查数据库，再验证真实写入与剩余空间。
  const database = await runCheck(checkDatabase);
  const dataDirectory = await runCheck(checkDataDirectory);
  const disk = await runCheck(checkDisk);
  const ffmpeg = await runCheck(checkFfmpeg);
  const ffprobe = await runCheck(checkFfprobe);
  const checks = { database, dataDirectory, disk, ffmpeg, ffprobe };

  return {
    ok: Object.values(checks).every((check) => check.ok),
    checks,
  };
}
