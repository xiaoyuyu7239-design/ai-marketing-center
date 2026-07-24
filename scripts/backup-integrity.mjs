import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, lstat, mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

const BACKUP_FORMAT_VERSION = 1;
const ALLOWED_TOP_LEVEL = new Set(["sqlite.db", "uploads", "output"]);
const SHA256 = /^[0-9a-f]{64}$/;

/**
 * SQLite 的 readonly 连接在 WAL 模式下仍可能创建或更新 -wal/-shm。
 * 完整性检查因此只能打开一次性副本，绝不能直接打开正式备份目录中的数据库。
 */
export async function assertSqliteIntegrityIsolated(dbPath, workspaceParent = tmpdir()) {
  const workspace = await mkdtemp(join(workspaceParent, "huimai-sqlite-verify-"));
  const candidate = join(workspace, "sqlite.db");
  let db;
  try {
    await copyFile(dbPath, candidate);
    db = new Database(candidate, { readonly: true, fileMustExist: true });
    db.pragma("query_only = ON");
    const result = db.pragma("integrity_check", { simple: true });
    if (result !== "ok") {
      throw new Error(`SQLite integrity_check 未通过：${String(result)}`);
    }
    const foreignKeyViolations = db.pragma("foreign_key_check");
    if (foreignKeyViolations.length > 0) {
      throw new Error(`SQLite foreign_key_check 发现 ${foreignKeyViolations.length} 个问题`);
    }
  } finally {
    db?.close();
    await rm(workspace, { recursive: true, force: true });
  }
}

function exactKeys(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function parseManifestPath(value) {
  if (typeof value !== "string" || !value || value.includes("\0") || value.includes("\\")) {
    throw new Error("备份清单含非法路径");
  }
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error(`备份清单路径不是规范相对路径：${value}`);
  }
  if (!ALLOWED_TOP_LEVEL.has(segments[0])) {
    throw new Error(`备份清单包含未知顶层目录：${value}`);
  }
  return segments.join(sep);
}

export async function sha256File(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

async function verifyManifestFile(root, entry) {
  if (!exactKeys(entry, ["path", "size", "mode", "mtimeMs", "sha256"])) {
    throw new Error("备份清单文件条目字段不完整");
  }
  const relativePath = parseManifestPath(entry.path);
  const filePath = join(root, relativePath);
  const info = await lstat(filePath).catch(() => null);
  if (!info?.isFile() || info.isSymbolicLink()) {
    throw new Error(`备份文件缺失或类型不安全：${entry.path}`);
  }
  if (!Number.isSafeInteger(entry.size) || entry.size < 0 || info.size !== entry.size) {
    throw new Error(`备份文件大小不匹配：${entry.path}`);
  }
  if (!Number.isInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o777) {
    throw new Error(`备份文件 mode 无效：${entry.path}`);
  }
  if (!Number.isSafeInteger(entry.mtimeMs) || entry.mtimeMs < 0) {
    throw new Error(`备份文件 mtimeMs 无效：${entry.path}`);
  }
  if (!SHA256.test(entry.sha256) || await sha256File(filePath) !== entry.sha256) {
    throw new Error(`备份文件校验和不匹配：${entry.path}`);
  }
  return { entry, relativePath, sourcePath: filePath };
}

async function collectRegularFiles(root, current = root) {
  const entries = [];
  for (const name of (await readdir(current)).sort()) {
    const absolute = join(current, name);
    const info = await lstat(absolute);
    if (info.isSymbolicLink()) {
      throw new Error(`备份目录含符号链接，拒绝继续：${absolute}`);
    }
    if (info.isDirectory()) {
      entries.push(...await collectRegularFiles(root, absolute));
      continue;
    }
    if (!info.isFile()) {
      throw new Error(`备份目录含非普通文件，拒绝继续：${absolute}`);
    }
    entries.push(absolute.slice(root.length + 1).split(sep).join("/"));
  }
  return entries;
}

/** 正式备份/恢复暂存目录只能包含 manifest 明确列出的文件。 */
export async function assertExactBackupFileSet(root, expectedPaths) {
  const expected = [...new Set(expectedPaths)].sort();
  const actual = await collectRegularFiles(root);
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  const unexpected = actual.filter((path) => !expectedSet.has(path));
  const missing = expected.filter((path) => !actualSet.has(path));
  if (unexpected.length || missing.length) {
    const details = [
      unexpected.length ? `清单未包含的文件：${unexpected.join("、")}` : "",
      missing.length ? `清单所列文件缺失：${missing.join("、")}` : "",
    ].filter(Boolean).join("；");
    throw new Error(`备份文件集合与 manifest 不一致：${details}`);
  }
}

/**
 * 严格验证一份正式备份，不在备份目录内创建任何 SQLite sidecar 或临时文件。
 */
export async function verifyBackupDirectory(root, options = {}) {
  const backupDir = await realpath(root);
  const manifestPath = join(backupDir, "manifest.json");
  const manifestInfo = await lstat(manifestPath).catch(() => null);
  if (!manifestInfo?.isFile() || manifestInfo.isSymbolicLink() || manifestInfo.size <= 0 || manifestInfo.size > 5 * 1024 * 1024) {
    throw new Error("备份清单缺失、过大或类型不安全");
  }
  const manifestContent = await readFile(manifestPath);
  const manifest = JSON.parse(manifestContent.toString("utf8"));
  if (!exactKeys(manifest, [
    "format",
    "formatVersion",
    "createdAt",
    "databaseIntegrity",
    "files",
    "totals",
  ]) || manifest.format !== "huimai-data-backup"
    || manifest.formatVersion !== BACKUP_FORMAT_VERSION
    || manifest.databaseIntegrity !== "ok"
    || !Array.isArray(manifest.files)
    || !exactKeys(manifest.totals, ["fileCount", "bytes"])) {
    throw new Error("备份清单格式或版本不受支持");
  }
  const createdAtMs = Date.parse(manifest.createdAt);
  const nowMs = options.nowMs ?? Date.now();
  if (!Number.isFinite(createdAtMs) || new Date(createdAtMs).toISOString() !== manifest.createdAt) {
    throw new Error("备份 createdAt 不是标准 ISO 时间");
  }
  if (createdAtMs > nowMs + 5 * 60_000) throw new Error("备份 createdAt 来自未来");
  if (options.maxAgeMs !== undefined
    && (!Number.isSafeInteger(options.maxAgeMs) || options.maxAgeMs <= 0 || nowMs - createdAtMs > options.maxAgeMs)) {
    throw new Error(`备份超过允许新鲜度 ${String(options.maxAgeMs)}ms`);
  }

  const verifiedFiles = [];
  const seenPaths = new Set();
  for (const entry of manifest.files) {
    const verified = await verifyManifestFile(backupDir, entry);
    const normalized = verified.relativePath.split(sep).join("/");
    if (seenPaths.has(normalized)) throw new Error(`备份清单包含重复路径：${entry.path}`);
    seenPaths.add(normalized);
    verifiedFiles.push(verified);
  }
  if (!seenPaths.has("sqlite.db")) throw new Error("备份清单缺少 sqlite.db");
  const totalBytes = manifest.files.reduce((sum, entry) => sum + entry.size, 0);
  if (manifest.totals.fileCount !== manifest.files.length || manifest.totals.bytes !== totalBytes) {
    throw new Error("备份 totals 与文件条目不一致");
  }
  await assertExactBackupFileSet(backupDir, ["manifest.json", ...seenPaths]);
  await assertSqliteIntegrityIsolated(join(backupDir, "sqlite.db"), options.integrityTempDir);
  return {
    backupDir,
    manifest,
    manifestSha256: createHash("sha256").update(manifestContent).digest("hex"),
    verifiedFiles,
  };
}
