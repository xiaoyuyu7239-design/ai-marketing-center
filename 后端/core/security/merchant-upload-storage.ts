import "server-only";

import { lstat, readdir } from "node:fs/promises";
import { join, normalize, sep } from "node:path";

import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";

import { getDb } from "@backend/db";
import { projects } from "@backend/db/schema";
import { getUploadsDir } from "@backend/shared/paths";

const DEFAULT_MERCHANT_UPLOAD_MAX_BYTES = 2 * 1024 * 1024 * 1024;
const SAFE_PATH_COMPONENT = /^[A-Za-z0-9_-]+$/;

type LockTail = Promise<void>;

const globalForMerchantUpload = globalThis as typeof globalThis & {
  __huimaiMerchantUploadReservations?: Map<string, number>;
  __huimaiMerchantUploadLocks?: Map<string, LockTail>;
};

const reservations = globalForMerchantUpload.__huimaiMerchantUploadReservations ?? new Map<string, number>();
const locks = globalForMerchantUpload.__huimaiMerchantUploadLocks ?? new Map<string, LockTail>();
globalForMerchantUpload.__huimaiMerchantUploadReservations = reservations;
globalForMerchantUpload.__huimaiMerchantUploadLocks = locks;

export class MerchantUploadQuotaExceededError extends Error {
  readonly code = "MERCHANT_UPLOAD_QUOTA_EXCEEDED";
  readonly status = 413;

  constructor(
    readonly usedBytes: number,
    readonly reservedBytes: number,
    readonly incomingBytes: number,
    readonly limitBytes: number,
  ) {
    super("商户上传空间已达上限，请删除不再使用的素材后重试");
    this.name = "MerchantUploadQuotaExceededError";
  }
}

export class MerchantUploadAccountingError extends Error {
  readonly code = "MERCHANT_UPLOAD_ACCOUNTING_FAILED";
  readonly status = 503;

  constructor() {
    super("暂时无法安全核算商户上传空间，请稍后重试");
    this.name = "MerchantUploadAccountingError";
  }
}

export interface MerchantUploadReservation {
  merchantId: string;
  bytes: number;
  usedBytesAtReservation: number;
  limitBytes: number;
  release(): Promise<void>;
}

export function merchantUploadLimitBytes(): number {
  const configured = Number(process.env.HUIMAI_MERCHANT_UPLOAD_MAX_BYTES);
  if (!Number.isSafeInteger(configured) || configured <= 0) return DEFAULT_MERCHANT_UPLOAD_MAX_BYTES;
  return configured;
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

async function directoryBytes(directory: string): Promise<number> {
  let entries;
  try {
    const rootMetadata = await lstat(directory);
    if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
      throw new MerchantUploadAccountingError();
    }
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return 0;
    throw error;
  }

  let total = 0;
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new MerchantUploadAccountingError();
    if (entry.isDirectory()) {
      total += await directoryBytes(path);
    } else if (entry.isFile()) {
      try {
        const metadata = await lstat(path);
        if (!metadata.isFile() || metadata.isSymbolicLink()) throw new MerchantUploadAccountingError();
        total += metadata.size;
      } catch (error) {
        // 上传清理与核算并发时，已经消失的文件不再占空间；其它异常一律失败关闭。
        if (!isMissing(error)) throw error;
      }
    } else {
      throw new MerchantUploadAccountingError();
    }
    if (!Number.isSafeInteger(total)) throw new MerchantUploadAccountingError();
  }
  return total;
}

function ownedDirectory(root: string, component: string): string {
  if (!SAFE_PATH_COMPONENT.test(component)) throw new MerchantUploadAccountingError();
  const directory = normalize(join(root, component));
  if (directory !== root && directory.startsWith(root + sep)) return directory;
  throw new MerchantUploadAccountingError();
}

/**
 * 只统计可由当前授权路由明确归属给商户的 uploads 内容：
 * - uploads/<该商户 DB 项目 id>/...
 * - uploads/products/<merchant id>/...
 *
 * 旧版 uploads/products/<product id> 与已经从 DB 删除的孤儿项目目录无法可靠归属，
 * 因而不计入任何商户额度；现有写路由不能再向这些路径写入，也不能借它们绕过归属校验。
 */
export async function merchantOwnedUploadBytes(merchantId: string): Promise<number> {
  if (!SAFE_PATH_COMPONENT.test(merchantId)) throw new MerchantUploadAccountingError();
  try {
    const root = normalize(getUploadsDir());
    const ownedProjects = getDb()
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.merchantId, merchantId))
      .all();
    let total = await directoryBytes(ownedDirectory(join(root, "products"), merchantId));
    for (const project of ownedProjects) {
      if (project.id === "products") throw new MerchantUploadAccountingError();
      total += await directoryBytes(ownedDirectory(root, project.id));
      if (!Number.isSafeInteger(total)) throw new MerchantUploadAccountingError();
    }
    return total;
  } catch (error) {
    if (error instanceof MerchantUploadAccountingError) throw error;
    throw new MerchantUploadAccountingError();
  }
}

async function withMerchantLock<T>(merchantId: string, action: () => Promise<T>): Promise<T> {
  const previous = locks.get(merchantId) ?? Promise.resolve();
  let releaseCurrent!: () => void;
  const current = new Promise<void>((resolve) => {
    releaseCurrent = resolve;
  });
  const tail = previous.then(() => current);
  locks.set(merchantId, tail);
  await previous;
  try {
    return await action();
  } finally {
    releaseCurrent();
    if (locks.get(merchantId) === tail) locks.delete(merchantId);
  }
}

/**
 * 在任何写盘之前原子预留本批字节。预留会一直保留到调用方 finally release，
 * 因而两个并发请求都会看到对方尚未落盘的体积，不会共同穿透累计空间上限。
 */
export async function reserveMerchantUploadBytes(
  merchantId: string,
  incomingBytes: number,
): Promise<MerchantUploadReservation> {
  if (!Number.isSafeInteger(incomingBytes) || incomingBytes <= 0) {
    throw new MerchantUploadAccountingError();
  }

  const snapshot = await withMerchantLock(merchantId, async () => {
    const usedBytes = await merchantOwnedUploadBytes(merchantId);
    const reservedBytes = reservations.get(merchantId) ?? 0;
    const limitBytes = merchantUploadLimitBytes();
    if (usedBytes + reservedBytes + incomingBytes > limitBytes) {
      throw new MerchantUploadQuotaExceededError(usedBytes, reservedBytes, incomingBytes, limitBytes);
    }
    reservations.set(merchantId, reservedBytes + incomingBytes);
    return { usedBytes, limitBytes };
  });

  let released = false;
  return {
    merchantId,
    bytes: incomingBytes,
    usedBytesAtReservation: snapshot.usedBytes,
    limitBytes: snapshot.limitBytes,
    async release() {
      if (released) return;
      released = true;
      await withMerchantLock(merchantId, async () => {
        const current = reservations.get(merchantId) ?? 0;
        const next = Math.max(0, current - incomingBytes);
        if (next === 0) reservations.delete(merchantId);
        else reservations.set(merchantId, next);
      });
    },
  };
}

export function merchantUploadStorageErrorResponse(error: unknown): NextResponse | null {
  if (error instanceof MerchantUploadQuotaExceededError) {
    return NextResponse.json(
      { error: error.message, code: error.code },
      { status: error.status, headers: { "Cache-Control": "no-store" } },
    );
  }
  if (error instanceof MerchantUploadAccountingError) {
    return NextResponse.json(
      { error: error.message, code: error.code },
      {
        status: error.status,
        headers: { "Cache-Control": "no-store", "Retry-After": "5" },
      },
    );
  }
  return null;
}

export function resetMerchantUploadReservationsForTests() {
  if (process.env.NODE_ENV !== "test") return;
  reservations.clear();
  locks.clear();
}
