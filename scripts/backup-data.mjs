import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readdir,
  realpath,
  rename,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  assertExactBackupFileSet,
  assertSqliteIntegrityIsolated,
} from "./backup-integrity.mjs";

const BACKUP_FORMAT_VERSION = 1;
const MEDIA_DIRECTORIES = ["uploads", "output"];

function usage() {
  return [
    "用法：node scripts/backup-data.mjs --destination <备份根目录> [--source <数据目录>]",
    "",
    "环境变量：",
    "  APP_DATA_DIR  默认源数据目录（未设置时为 <cwd>/data）",
    "  BACKUP_DIR    默认备份根目录",
    "",
    "示例：",
    "  APP_DATA_DIR=/data BACKUP_DIR=/secure-backups pnpm ops:backup",
  ].join("\n");
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const current = argv[i];
    if (current === "--help" || current === "-h") {
      args.help = true;
      continue;
    }
    if (current !== "--source" && current !== "--destination") {
      throw new Error(`未知参数：${current}`);
    }
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${current} 缺少路径参数`);
    }
    args[current.slice(2)] = value;
    i += 1;
  }
  return args;
}

function isInside(candidate, parent) {
  const rel = relative(parent, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

async function resolvePotentialPath(value) {
  let existingAncestor = resolve(value);
  const missingSegments = [];
  while (!(await lstat(existingAncestor).catch(() => null))) {
    const parent = dirname(existingAncestor);
    if (parent === existingAncestor) throw new Error(`无法解析路径：${resolve(value)}`);
    missingSegments.push(basename(existingAncestor));
    existingAncestor = parent;
  }
  return join(await realpath(existingAncestor), ...missingSegments.reverse());
}

function safeTimestamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

function toManifestPath(value) {
  const manifestPath = value.split(sep).join("/");
  if (
    manifestPath.includes("\\") ||
    manifestPath.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error(`文件名无法安全写入跨平台备份清单：${value}`);
  }
  return manifestPath;
}

async function sha256(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

async function fileEntry(filePath, manifestPath) {
  const info = await stat(filePath);
  return {
    path: toManifestPath(manifestPath),
    size: info.size,
    mode: info.mode & 0o777,
    mtimeMs: Math.trunc(info.mtimeMs),
    sha256: await sha256(filePath),
  };
}

async function copyTree(source, destination, manifestPrefix, entries) {
  const info = await lstat(source);
  if (info.isSymbolicLink()) {
    throw new Error(`为防止备份越界，拒绝符号链接：${source}`);
  }
  if (info.isDirectory()) {
    await mkdir(destination, { recursive: true, mode: info.mode & 0o777 });
    const childrenBefore = (await readdir(source)).sort();
    for (const child of childrenBefore) {
      await copyTree(
        join(source, child),
        join(destination, child),
        join(manifestPrefix, child),
        entries,
      );
    }
    const directoryAfter = await lstat(source).catch(() => null);
    const childrenAfter = directoryAfter?.isDirectory() ? (await readdir(source)).sort() : [];
    if (
      !directoryAfter?.isDirectory() ||
      directoryAfter.isSymbolicLink() ||
      childrenBefore.length !== childrenAfter.length ||
      childrenBefore.some((child, index) => child !== childrenAfter[index])
    ) {
      throw new Error(`媒体目录在备份期间发生变化，请暂停上传/合成后重试：${source}`);
    }
    return;
  }
  if (!info.isFile()) {
    throw new Error(`只允许备份普通文件或目录：${source}`);
  }

  await mkdir(dirname(destination), { recursive: true });
  await copyFile(source, destination);
  const infoAfter = await lstat(source).catch(() => null);
  if (
    !infoAfter?.isFile() ||
    infoAfter.isSymbolicLink() ||
    infoAfter.dev !== info.dev ||
    infoAfter.ino !== info.ino ||
    infoAfter.size !== info.size ||
    infoAfter.mtimeMs !== info.mtimeMs ||
    infoAfter.ctimeMs !== info.ctimeMs
  ) {
    throw new Error(`媒体文件在备份期间发生变化，请暂停上传/合成后重试：${source}`);
  }
  await chmod(destination, info.mode & 0o777);
  await utimes(destination, info.atime, info.mtime);
  entries.push(await fileEntry(destination, manifestPrefix));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }

  const sourceInput = args.source || process.env.APP_DATA_DIR || join(process.cwd(), "data");
  const destinationInput = args.destination || process.env.BACKUP_DIR;
  if (!destinationInput) throw new Error(`缺少备份根目录。\n\n${usage()}`);

  const sourceDir = await realpath(resolve(sourceInput)).catch(() => {
    throw new Error(`源数据目录不存在：${resolve(sourceInput)}`);
  });
  const sourceDbPath = join(sourceDir, "sqlite.db");
  const sourceDbInfo = await lstat(sourceDbPath).catch(() => null);
  if (!sourceDbInfo?.isFile() || sourceDbInfo.isSymbolicLink()) {
    throw new Error(`未找到普通 SQLite 数据库文件：${sourceDbPath}`);
  }
  for (const directory of MEDIA_DIRECTORIES) {
    const mediaPath = join(sourceDir, directory);
    const info = await lstat(mediaPath).catch(() => null);
    if (!info?.isDirectory() || info.isSymbolicLink()) {
      throw new Error(`正式备份要求 ${directory}/ 是存在且非符号链接的目录：${mediaPath}`);
    }
  }

  const requestedBackupRoot = await resolvePotentialPath(destinationInput);
  if (isInside(requestedBackupRoot, sourceDir) || isInside(sourceDir, requestedBackupRoot)) {
    throw new Error("备份目录与数据目录不能互相包含；请使用独立磁盘或独立目录");
  }
  await mkdir(requestedBackupRoot, { recursive: true, mode: 0o700 });
  const backupRoot = await realpath(requestedBackupRoot);
  if (isInside(backupRoot, sourceDir) || isInside(sourceDir, backupRoot)) {
    throw new Error("备份目录与数据目录不能互相包含；请使用独立磁盘或独立目录");
  }

  const backupName = `backup-${safeTimestamp()}-${process.pid}`;
  const finalDir = join(backupRoot, backupName);
  const stagingDir = `${finalDir}.part`;
  await mkdir(stagingDir, { recursive: false, mode: 0o700 });

  const files = [];
  const dbPartPath = join(stagingDir, "sqlite.db.part");
  const dbFinalPath = join(stagingDir, "sqlite.db");
  const sourceDb = new Database(sourceDbPath, { readonly: true, fileMustExist: true });
  try {
    sourceDb.pragma("busy_timeout = 5000");
    await sourceDb.backup(dbPartPath);
  } finally {
    sourceDb.close();
  }
  await assertSqliteIntegrityIsolated(dbPartPath);
  await rename(dbPartPath, dbFinalPath);
  files.push(await fileEntry(dbFinalPath, "sqlite.db"));

  for (const directory of MEDIA_DIRECTORIES) {
    const source = join(sourceDir, directory);
    await copyTree(source, join(stagingDir, directory), directory, files);
  }

  files.sort((a, b) => a.path.localeCompare(b.path));
  const manifest = {
    format: "huimai-data-backup",
    formatVersion: BACKUP_FORMAT_VERSION,
    createdAt: new Date().toISOString(),
    databaseIntegrity: "ok",
    files,
    totals: {
      fileCount: files.length,
      bytes: files.reduce((sum, item) => sum + item.size, 0),
    },
  };
  const manifestPart = join(stagingDir, "manifest.json.part");
  const manifestFinal = join(stagingDir, "manifest.json");
  await writeFile(manifestPart, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  await rename(manifestPart, manifestFinal);
  await assertExactBackupFileSet(stagingDir, [
    ...files.map((entry) => entry.path),
    "manifest.json",
  ]);

  await rename(stagingDir, finalDir);
  console.log(`备份完成：${finalDir}`);
  console.log(`文件：${manifest.totals.fileCount}，字节：${manifest.totals.bytes}`);
}

main().catch((error) => {
  console.error(`备份失败：${error instanceof Error ? error.message : String(error)}`);
  console.error("若已创建 *.part 目录，请保留用于排查；恢复工具不会接受该目录。");
  process.exitCode = 1;
});
