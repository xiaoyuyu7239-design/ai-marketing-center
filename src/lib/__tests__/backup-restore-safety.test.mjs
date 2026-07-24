import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "../../..");
const BACKUP_SCRIPT = join(ROOT, "scripts/backup-data.mjs");
const RESTORE_SCRIPT = join(ROOT, "scripts/restore-data.mjs");
const VERIFY_SCRIPT = join(ROOT, "scripts/verify-backup.mjs");

function run(script, args) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 30_000,
  });
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function fileSnapshot(root, current = root, result = {}) {
  for (const name of readdirSync(current).sort()) {
    const absolute = join(current, name);
    const info = lstatSync(absolute);
    const key = relative(root, absolute).split(sep).join("/");
    if (info.isDirectory()) fileSnapshot(root, absolute, result);
    else result[key] = { size: info.size, sha256: sha256(absolute) };
  }
  return result;
}

describe("backup/restore immutable evidence safety", () => {
  it("does not leave WAL sidecars, never opens the formal backup DB, and rejects unlisted files", () => {
    const workspace = mkdtempSync(join(tmpdir(), "huimai-backup-safety-"));
    const source = join(workspace, "source");
    const backupRoot = join(workspace, "backups");
    try {
      mkdirSync(join(source, "uploads"), { recursive: true });
      mkdirSync(join(source, "output"), { recursive: true });
      writeFileSync(join(source, "uploads", "sample.txt"), "immutable-media\n");
      const db = new Database(join(source, "sqlite.db"));
      db.pragma("journal_mode = WAL");
      db.pragma("foreign_keys = ON");
      db.exec("CREATE TABLE parent(id INTEGER PRIMARY KEY); CREATE TABLE child(parent_id INTEGER REFERENCES parent(id)); INSERT INTO parent VALUES (1); INSERT INTO child VALUES (1);");
      db.close();

      const backup = run(BACKUP_SCRIPT, ["--source", source, "--destination", backupRoot]);
      expect(backup.status, `${backup.stdout}\n${backup.stderr}`).toBe(0);
      const backupPath = /备份完成：(.+)/.exec(backup.stdout)?.[1]?.trim();
      expect(backupPath).toBeTruthy();
      const beforeRestore = fileSnapshot(backupPath);
      expect(Object.keys(beforeRestore)).toContain("manifest.json");
      expect(Object.keys(beforeRestore).some((path) => /(?:-wal|-shm)$/.test(path))).toBe(false);

      const manifestPath = join(backupPath, "manifest.json");
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      const manifestSha256 = sha256(manifestPath);
      const receiptPath = join(workspace, "offsite-receipt.json");
      writeFileSync(receiptPath, `${JSON.stringify({
        schemaVersion: 1,
        provider: "test-object-storage",
        objectKey: "immutable/test-backup",
        versionId: "version-test-1",
        manifestSha256,
        syncedAt: new Date().toISOString(),
      }, null, 2)}\n`);
      const freezeStart = new Date(Date.parse(manifest.createdAt) - 1_000).toISOString();
      const freezeEnd = new Date().toISOString();
      const evidencePath = join(workspace, "backup-verification.json");
      const verified = run(VERIFY_SCRIPT, [
        "--backup", backupPath,
        "--evidence", evidencePath,
        "--receipt", receiptPath,
        "--freeze-start", freezeStart,
        "--freeze-end", freezeEnd,
        "--max-age-ms", "60000",
      ]);
      expect(verified.status, `${verified.stdout}\n${verified.stderr}`).toBe(0);
      expect(JSON.parse(readFileSync(evidencePath, "utf8"))).toMatchObject({
        writesFrozen: true,
        manifestSha256,
        offsiteReceiptFile: "offsite-receipt.json",
      });

      const restoredPath = join(workspace, "restored");
      const restored = run(RESTORE_SCRIPT, ["--backup", backupPath, "--destination", restoredPath]);
      expect(restored.status, `${restored.stdout}\n${restored.stderr}`).toBe(0);
      expect(fileSnapshot(backupPath)).toEqual(beforeRestore);
      expect(Object.keys(fileSnapshot(restoredPath)).some((path) => /(?:-wal|-shm)$/.test(path))).toBe(false);

      writeFileSync(join(backupPath, "sqlite.db-shm"), "rogue-sidecar");
      const rejectedPath = join(workspace, "must-not-exist");
      const rejected = run(RESTORE_SCRIPT, ["--backup", backupPath, "--destination", rejectedPath]);
      expect(rejected.status).toBe(1);
      expect(`${rejected.stdout}\n${rejected.stderr}`).toMatch(/manifest 不一致|清单未包含/);
      expect(existsSync(rejectedPath)).toBe(false);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
