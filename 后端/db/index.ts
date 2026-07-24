import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import * as schema from "./schema";
import { getDataDir, getMigrationsDir } from "@backend/shared/paths";

// 数据库文件路径：可写数据目录（Electron 打包时由主进程注入 APP_DATA_DIR=userData/data）
const DB_DIR = getDataDir();
const DB_PATH = path.join(DB_DIR, "sqlite.db");
// 迁移文件目录（drizzle-kit generate 产出，随仓库提交；打包时指向 resources/drizzle）
const MIGRATIONS_DIR = getMigrationsDir();

// 确保 data 目录存在
if (!fs.existsSync(DB_DIR)) {
  fs.mkdirSync(DB_DIR, { recursive: true });
}

// 创建 better-sqlite3 连接实例
const sqlite = new Database(DB_PATH);

// 开启 WAL 模式，提升并发读写性能
// 跳过 next build 阶段：journal_mode=WAL 会改写库文件头、需短暂排他锁，
// 构建时多 worker 并发导入本模块会同时抢锁触发 "database is locked"。
// WAL 是库文件的持久属性，运行时（next start / Electron）设置一次即可。
if (process.env.NEXT_PHASE !== "phase-production-build") {
  sqlite.pragma("journal_mode = WAL");
}
// 开启外键约束（每连接级 pragma，不写库文件、无锁竞争，构建期保留无碍）
sqlite.pragma("foreign_keys = ON");
// 多进程/多入口同时读写时最多等待 5 秒，避免一遇到短暂锁就报 SQLITE_BUSY。
sqlite.pragma("busy_timeout = 5000");

// 创建 drizzle ORM 实例，绑定 schema 以支持关系查询
export const db = drizzle(sqlite, { schema });

/**
 * 只清理持久任务系统上线前遗留、且没有任何 job 作为恢复依据的旧 composition。
 * 有 job 的 pending/composing 必须由 90 秒租约状态机恢复，不能再按创建时间误杀。
 */
export function sweepStaleOrphanCompositions(
  staleCutoff = Math.floor(Date.now() / 1000) - 15 * 60,
): number {
  return sqlite
    .prepare(
      `UPDATE compositions
       SET status = 'failed'
       WHERE status IN ('composing', 'pending')
         AND created_at < ?
         AND NOT EXISTS (
           SELECT 1 FROM jobs WHERE jobs.composition_id = compositions.id
         )`,
    )
    .run(staleCutoff).changes;
}

/**
 * 旧版实验功能曾把第三方视频 fallback 凭据整体塞进通用 settings JSON。
 * 现在 Agent 控制面只从服务端 secretRef/环境变量取凭据，该键无任何运行用途，
 * 启动时必须幂等清除。secure_delete + WAL truncate 避免删除后明文仍留在空闲页/WAL。
 * 注意：这只是本地清理；曾经暴露的供应商密钥仍必须在供应商后台轮换。
 */
export function scrubDeprecatedSensitiveSettings(): number {
  sqlite.pragma("secure_delete = ON");
  const changes = sqlite
    .prepare("DELETE FROM settings WHERE key = ?")
    .run("video_face_fallback").changes;
  if (process.env.NEXT_PHASE !== "phase-production-build") {
    // 即使本次 DELETE 为 0，也可能是上次进程在删除后、截断 WAL 前崩溃；
    // 因而每次启动都完成 checkpoint，并把 busy 视为清理失败而非假成功。
    const checkpoint = sqlite.pragma("wal_checkpoint(TRUNCATE)") as Array<{
      busy?: number;
      log?: number;
      checkpointed?: number;
    }>;
    if (checkpoint[0]?.busy !== 0) {
      throw new Error("废弃敏感设置已删除，但 SQLite WAL 暂时无法安全截断");
    }
  }
  return changes;
}

// 开箱即用：启动时自动应用迁移，确保全新克隆/空库也能建好所有表
// （修复 issue #2「no such table: projects」——data/ 被 gitignore，开箱无表）
// 跳过 next build 阶段：构建时多 worker 并发导入本模块会同时 migrate 同一空库，
// 触发竞态（"duplicate column" 等）。迁移只需在运行时（next start / Electron）执行一次。
if (process.env.NEXT_PHASE !== "phase-production-build") {
  try {
    if (!fs.existsSync(MIGRATIONS_DIR)) {
      throw new Error(`数据库迁移目录不存在：${MIGRATIONS_DIR}`);
    }
    migrate(db, { migrationsFolder: MIGRATIONS_DIR });
  } catch (err) {
    console.error("数据库迁移失败:", err);
    // 迁移失败后继续服务会让新旧 schema 混用，最终把一个可恢复的发布故障变成数据损坏。
    // 生产启动必须 fail-fast；由编排平台保留旧实例或回滚，而不是带病接收请求。
    throw err;
  }

  try {
    const swept = sweepStaleOrphanCompositions();
    if (swept > 0) {
      console.warn(`已清理 ${swept} 条无持久 job 的历史合成记录：composing/pending → failed`);
    }
  } catch (err) {
    console.warn("清理卡住的合成记录失败（不影响启动）:", err);
  }

  try {
    const scrubbed = scrubDeprecatedSensitiveSettings();
    if (scrubbed > 0) {
      console.warn("已清除旧版通用设置中的废弃敏感凭据；请确认供应商侧密钥已轮换");
    }
  } catch (err) {
    // 该项是凭据清理，失败时不得带病继续服务。
    console.error("废弃敏感设置清理失败:", err);
    throw err;
  }

  // 兜底种入默认套餐：merchants.plan_id 的列默认值是 "trial"，套餐/定价方案未最终拍板前
  // 先给一个够用的免费额度，避免新商家注册时因为引用的套餐不存在而写入失败。
  // "unlimited" 供单用户模式（桌面版/CLI，用户自己付模型钱）使用，不对外售卖。
  try {
    const seedPlan = sqlite.prepare("INSERT OR IGNORE INTO plans (id, name, monthly_generation_quota) VALUES (?, ?, ?)");
    seedPlan.run("trial", "试用版", 20);
    seedPlan.run("unlimited", "本机不限量", 1_000_000_000);
  } catch (err) {
    console.warn("默认套餐种入失败（不影响启动）:", err);
  }
}

// 兼容函数式调用
export function getDb() {
  return db;
}
