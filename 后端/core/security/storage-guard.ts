import "server-only";

import { statfs } from "fs/promises";
import { getDataDir } from "@backend/shared/paths";

const DEFAULT_MIN_FREE_BYTES = 1024 * 1024 * 1024; // 至少保留 1GiB，避免 SQLite/FFmpeg 被写满

export async function ensureStorageCapacity(incomingBytes: number) {
  const minFree = Number(process.env.HUIMAI_MIN_FREE_BYTES || DEFAULT_MIN_FREE_BYTES);
  const stats = await statfs(getDataDir());
  const freeBytes = Number(stats.bavail) * Number(stats.bsize);
  if (!Number.isFinite(freeBytes) || freeBytes - incomingBytes < minFree) {
    throw new Error("服务器存储空间不足，已暂停上传，请联系绘卖团队");
  }
}
