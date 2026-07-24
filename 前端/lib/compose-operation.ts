"use client";

const STORAGE_PREFIX = "huimai:compose-operation:v1";
export const COMPOSE_OPERATION_TTL_MS = 24 * 60 * 60 * 1_000;

export interface ComposeOperationStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface ComposeOperation {
  projectId: string;
  scope: string;
  payloadFingerprint: string;
  idempotencyKey: string;
  createdAt: number;
  expiresAt: number;
  persisted: boolean;
}

interface StoredComposeOperation {
  version: 1;
  projectId: string;
  scope: string;
  payloadFingerprint: string;
  idempotencyKey: string;
  createdAt: number;
  expiresAt: number;
}

interface ComposeOperationOptions {
  storage?: ComposeOperationStorage | null;
  now?: number;
  ttlMs?: number;
  idFactory?: () => string;
}

function canonicalJson(value: unknown, stack = new Set<object>()): string | undefined {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : "null";
  if (typeof value === "bigint") throw new TypeError("compose payload 不能包含 bigint");
  if (typeof value !== "object") return undefined;

  if (stack.has(value)) throw new TypeError("compose payload 不能循环引用");
  stack.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((item) => canonicalJson(item, stack) ?? "null").join(",")}]`;
    }
    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .flatMap((key) => {
        const encoded = canonicalJson((value as Record<string, unknown>)[key], stack);
        return encoded === undefined ? [] : [`${JSON.stringify(key)}:${encoded}`];
      });
    return `{${entries.join(",")}}`;
  } finally {
    stack.delete(value);
  }
}

/**
 * localStorage 只保存稳定指纹，不保存脚本、CTA 等业务正文。
 * 双 32-bit 散列用于本地复用；服务端仍会用完整冻结 payload 的 SHA-256 做最终冲突校验。
 */
export function composePayloadFingerprint(payload: unknown): string {
  const canonical = canonicalJson(payload);
  if (canonical === undefined) throw new TypeError("compose payload 必须是可序列化值");
  let left = 0x811c9dc5;
  let right = 0x9e3779b9;
  for (let index = 0; index < canonical.length; index += 1) {
    const code = canonical.charCodeAt(index);
    left = Math.imul(left ^ code, 0x01000193) >>> 0;
    right = Math.imul(right ^ code, 0x85ebca6b) >>> 0;
    right = ((right << 13) | (right >>> 19)) >>> 0;
  }
  return `v1-${canonical.length.toString(36)}-${left.toString(16).padStart(8, "0")}${right
    .toString(16)
    .padStart(8, "0")}`;
}

function operationStorageKey(projectId: string, scope: string): string {
  return `${STORAGE_PREFIX}:${encodeURIComponent(projectId)}:${encodeURIComponent(scope)}`;
}

function browserStorage(): ComposeOperationStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function parseStoredOperation(raw: string | null): StoredComposeOperation | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<StoredComposeOperation>;
    if (
      value.version !== 1 ||
      typeof value.projectId !== "string" ||
      typeof value.scope !== "string" ||
      typeof value.payloadFingerprint !== "string" ||
      typeof value.idempotencyKey !== "string" ||
      typeof value.createdAt !== "number" ||
      !Number.isFinite(value.createdAt) ||
      typeof value.expiresAt !== "number" ||
      !Number.isFinite(value.expiresAt)
    ) {
      return null;
    }
    return value as StoredComposeOperation;
  } catch {
    return null;
  }
}

function toOperation(value: StoredComposeOperation, persisted: boolean): ComposeOperation {
  return { ...value, persisted };
}

/**
 * 同 project + scope + payload 在终态前复用同一 key。fetch 抛错、202 响应丢失或轮询超时都不要清理它。
 */
export function acquireComposeOperation(
  projectId: string,
  scope: string,
  payload: unknown,
  options: ComposeOperationOptions = {},
): ComposeOperation {
  const normalizedProjectId = projectId.trim();
  const normalizedScope = scope.trim();
  if (!normalizedProjectId || !normalizedScope) throw new TypeError("compose operation 缺少 projectId 或 scope");

  const now = options.now ?? Date.now();
  const ttlMs = options.ttlMs ?? COMPOSE_OPERATION_TTL_MS;
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new TypeError("compose operation TTL 必须大于 0");
  const payloadFingerprint = composePayloadFingerprint(payload);
  const key = operationStorageKey(normalizedProjectId, normalizedScope);
  const storage = options.storage === undefined ? browserStorage() : options.storage;

  if (storage) {
    try {
      const existing = parseStoredOperation(storage.getItem(key));
      if (
        existing &&
        existing.projectId === normalizedProjectId &&
        existing.scope === normalizedScope &&
        existing.payloadFingerprint === payloadFingerprint &&
        existing.expiresAt > now
      ) {
        return toOperation(existing, true);
      }
      if (existing || storage.getItem(key) !== null) storage.removeItem(key);
    } catch {
      // Safari 隐私模式或存储配额异常时退回本次内存 key，不能因此阻断合成。
    }
  }

  const stored: StoredComposeOperation = {
    version: 1,
    projectId: normalizedProjectId,
    scope: normalizedScope,
    payloadFingerprint,
    idempotencyKey: (options.idFactory ?? (() => crypto.randomUUID()))(),
    createdAt: now,
    expiresAt: now + ttlMs,
  };
  if (storage) {
    try {
      storage.setItem(key, JSON.stringify(stored));
      return toOperation(stored, true);
    } catch {
      // 同上：仍返回有效 key，但刷新后无法恢复。
    }
  }
  return toOperation(stored, false);
}

/** 仅清理仍与该请求匹配的记录，避免旧请求终态误删后来变更 payload 创建的新操作。 */
export function clearComposeOperation(
  operation: ComposeOperation,
  storageOverride?: ComposeOperationStorage | null,
): boolean {
  const storage = storageOverride === undefined ? browserStorage() : storageOverride;
  if (!storage) return false;
  const key = operationStorageKey(operation.projectId, operation.scope);
  try {
    const current = parseStoredOperation(storage.getItem(key));
    if (
      !current ||
      current.idempotencyKey !== operation.idempotencyKey ||
      current.payloadFingerprint !== operation.payloadFingerprint
    ) {
      return false;
    }
    storage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}
