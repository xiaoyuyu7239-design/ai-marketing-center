import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  realpath,
  rename,
  utimes,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  assertExactBackupFileSet,
  assertSqliteIntegrityIsolated,
  sha256File,
  verifyBackupDirectory,
} from "./backup-integrity.mjs";

function usage() {
  return [
    "用法：node scripts/restore-data.mjs --backup <备份目录> --destination <全新数据目录>",
    "",
    "恢复工具只会写入不存在的新目录，不提供覆盖开关。",
    "示例：pnpm ops:restore --backup /secure-backups/backup-... --destination /data-restored",
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
    if (current !== "--backup" && current !== "--destination") {
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

async function resolveNewDestination(value) {
  const requested = resolve(value);
  let existingAncestor = dirname(requested);
  const missingParents = [];

  while (!(await lstat(existingAncestor).catch(() => null))) {
    const parent = dirname(existingAncestor);
    if (parent === existingAncestor) throw new Error(`无法解析恢复目标父目录：${requested}`);
    missingParents.push(basename(existingAncestor));
    existingAncestor = parent;
  }

  const canonicalAncestor = await realpath(existingAncestor);
  const ancestorInfo = await lstat(canonicalAncestor);
  if (!ancestorInfo.isDirectory()) {
    throw new Error(`恢复目标的父路径不是目录：${existingAncestor}`);
  }
  return join(canonicalAncestor, ...missingParents.reverse(), basename(requested));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }
  if (!args.backup || !args.destination) throw new Error(`缺少必要参数。\n\n${usage()}`);

  const backupDir = await realpath(resolve(args.backup)).catch(() => {
    throw new Error(`备份目录不存在：${resolve(args.backup)}`);
  });
  if (backupDir.endsWith(".part")) throw new Error("拒绝恢复未完成的 *.part 备份目录");

  const requestedDestination = resolve(args.destination);
  if (await lstat(requestedDestination).catch(() => null)) {
    throw new Error(`目标目录已经存在，拒绝覆盖：${requestedDestination}`);
  }
  const destinationDir = await resolveNewDestination(requestedDestination);
  if (await lstat(destinationDir).catch(() => null)) {
    throw new Error(`目标目录已经存在，拒绝覆盖：${destinationDir}`);
  }
  if (isInside(destinationDir, backupDir) || isInside(backupDir, destinationDir)) {
    throw new Error("恢复目标与备份目录不能互相包含");
  }

  const verified = await verifyBackupDirectory(backupDir);
  const verifiedFiles = verified.verifiedFiles;
  const seenPaths = new Set(verifiedFiles.map(({ relativePath }) => relativePath.split(sep).join("/")));

  await mkdir(dirname(destinationDir), { recursive: true });
  const stagingDir = `${destinationDir}.part-${Date.now()}-${process.pid}`;
  await mkdir(stagingDir, { recursive: false, mode: 0o700 });
  await Promise.all([
    mkdir(join(stagingDir, "uploads"), { recursive: true, mode: 0o700 }),
    mkdir(join(stagingDir, "output"), { recursive: true, mode: 0o700 }),
  ]);

  for (const { entry, relativePath, sourcePath } of verifiedFiles) {
    const targetPath = join(stagingDir, relativePath);
    if (!isInside(targetPath, stagingDir)) throw new Error(`恢复路径越界：${entry.path}`);
    await mkdir(dirname(targetPath), { recursive: true });
    await copyFile(sourcePath, targetPath);
    if (Number.isInteger(entry.mode)) await chmod(targetPath, entry.mode & 0o777);
    if (Number.isFinite(entry.mtimeMs)) {
      const modifiedAt = new Date(entry.mtimeMs);
      await utimes(targetPath, modifiedAt, modifiedAt);
    }
    const copiedInfo = await lstat(targetPath);
    if (copiedInfo.size !== entry.size || await sha256File(targetPath) !== entry.sha256) {
      throw new Error(`恢复暂存文件校验失败：${entry.path}`);
    }
  }
  await assertSqliteIntegrityIsolated(join(stagingDir, "sqlite.db"));
  await assertExactBackupFileSet(stagingDir, seenPaths);

  await rename(stagingDir, destinationDir);
  console.log(`恢复并校验完成：${destinationDir}`);
  console.log(`下一步请使用 APP_DATA_DIR=${destinationDir} 启动独立实例做人工验收，确认后再切换流量。`);
}

main().catch((error) => {
  console.error(`恢复失败：${error instanceof Error ? error.message : String(error)}`);
  console.error("工具不会覆盖现有目录；若留下 *.part-* 目录，请人工核查后处理。");
  process.exitCode = 1;
});
