#!/usr/bin/env node

import { createHash } from "node:crypto";
import { link, lstat, mkdir, readFile, realpath, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { verifyBackupDirectory } from "./backup-integrity.mjs";

const SHA256 = /^[0-9a-f]{64}$/;

function parseArgs(argv) {
  const args = {};
  const allowed = new Set([
    "--backup",
    "--evidence",
    "--receipt",
    "--freeze-start",
    "--freeze-end",
    "--max-age-ms",
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === "--help" || key === "-h") return { help: true };
    if (!allowed.has(key)) throw new Error(`未知参数：${key}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${key} 缺少参数`);
    args[key.slice(2)] = value;
    index += 1;
  }
  return args;
}

function usage() {
  return [
    "用法：node scripts/verify-backup.mjs --backup <正式备份目录> --evidence <输出JSON> --receipt <异机回执JSON> --freeze-start <ISO> --freeze-end <ISO>",
    "异机回执必须包含 schemaVersion/provider/objectKey/versionId/manifestSha256/syncedAt。",
  ].join("\n");
}

function exactKeys(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isoMs(value, label) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new Error(`${label} 必须是标准 ISO 时间`);
  }
  return parsed;
}

async function safeReceipt(path) {
  if (!isAbsolute(path)) throw new Error("异机回执必须使用绝对路径");
  const canonical = await realpath(path);
  const info = await lstat(canonical);
  if (!info.isFile() || info.isSymbolicLink() || info.size <= 0 || info.size > 64 * 1024) {
    throw new Error("异机回执必须是 1 byte 至 64 KiB 的普通文件");
  }
  const content = await readFile(canonical);
  const receipt = JSON.parse(content.toString("utf8"));
  if (!exactKeys(receipt, ["schemaVersion", "provider", "objectKey", "versionId", "manifestSha256", "syncedAt"])
    || receipt.schemaVersion !== 1
    || [receipt.provider, receipt.objectKey, receipt.versionId].some((value) =>
      typeof value !== "string" || !value.trim() || /replace-with|example\./i.test(value))
    || !SHA256.test(receipt.manifestSha256)) {
    throw new Error("异机回执格式无效或仍含占位值");
  }
  isoMs(receipt.syncedAt, "异机回执 syncedAt");
  return {
    canonical,
    content,
    receipt,
    sha256: createHash("sha256").update(content).digest("hex"),
  };
}

async function writeExclusiveAtomic(destination, serialized) {
  if (!isAbsolute(destination)) throw new Error("备份证据输出必须使用绝对路径");
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  const part = `${destination}.part-${process.pid}-${Date.now()}`;
  await writeFile(part, serialized, { flag: "wx", mode: 0o600 });
  try {
    await link(part, destination);
  } finally {
    await unlink(part).catch(() => undefined);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (!args.backup || !args.evidence || !args.receipt || !args["freeze-start"] || !args["freeze-end"]) {
    throw new Error(`缺少必要参数。\n${usage()}`);
  }
  const maxAgeMs = Number(args["max-age-ms"] || process.env.HUIMAI_ALERT_BACKUP_AGE_MS || 7 * 60 * 60_000);
  if (!Number.isSafeInteger(maxAgeMs) || maxAgeMs <= 0) throw new Error("max-age-ms 必须为正安全整数");
  const verified = await verifyBackupDirectory(resolve(args.backup), { maxAgeMs });
  const receipt = await safeReceipt(args.receipt);
  if (receipt.receipt.manifestSha256 !== verified.manifestSha256) {
    throw new Error("异机回执 manifestSha256 与本地正式备份不一致");
  }
  const freezeStartedAt = args["freeze-start"];
  const freezeEndedAt = args["freeze-end"];
  const freezeStartMs = isoMs(freezeStartedAt, "freeze-start");
  const freezeEndMs = isoMs(freezeEndedAt, "freeze-end");
  const backupCreatedMs = isoMs(verified.manifest.createdAt, "备份 createdAt");
  const syncedAtMs = isoMs(receipt.receipt.syncedAt, "异机回执 syncedAt");
  if (freezeStartMs > backupCreatedMs || backupCreatedMs > freezeEndMs || freezeEndMs - freezeStartMs > 2 * 60 * 60_000) {
    throw new Error("冻结窗口必须覆盖备份 createdAt，且持续时间不能超过 2 小时");
  }
  if (syncedAtMs < backupCreatedMs || syncedAtMs > Date.now() + 5 * 60_000) {
    throw new Error("异机同步时间必须晚于备份且不能来自未来");
  }
  const evidence = {
    schemaVersion: 1,
    backupName: basename(verified.backupDir),
    manifestSha256: verified.manifestSha256,
    backupCreatedAt: verified.manifest.createdAt,
    verifiedAt: new Date().toISOString(),
    writesFrozen: true,
    freezeStartedAt,
    freezeEndedAt,
    offsiteReceiptFile: basename(receipt.canonical),
    offsiteReceiptSha256: receipt.sha256,
  };
  const serialized = `${JSON.stringify(evidence, null, 2)}\n`;
  const destination = resolve(args.evidence);
  await writeExclusiveAtomic(destination, serialized);
  const evidenceSha256 = createHash("sha256").update(serialized).digest("hex");
  process.stdout.write(`备份及异机回执验证通过；证据 ${destination}\nSHA256=${evidenceSha256}\n`);
}

main().catch((error) => {
  process.stderr.write(`备份证据验证失败：${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
