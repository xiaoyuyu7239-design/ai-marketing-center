/**
 * 统一的运行时路径解析 —— 让数据目录可被环境变量注入，支撑 Electron 打包
 *
 * 关键背景：Next standalone 产物的 server.js 启动时会 process.chdir(__dirname)，
 * 打包进 Electron 后 process.cwd() 指向只读的 resources 目录，往那里写 sqlite/uploads/output 会崩。
 * 因此 Electron 主进程会注入 APP_DATA_DIR=app.getPath('userData')/data（可写）。
 * 开发态（next dev）不注入，回退到项目根 data/，行为与原来完全一致。
 */

import { join } from "path";

/** 可写数据根目录（sqlite.db / uploads / output 都在这下面） */
export function getDataDir(): string {
  return process.env.APP_DATA_DIR || join(process.cwd(), "data");
}

/** 迁移 SQL 目录（只读资源）。Electron 打包时指向 resources 内的 drizzle */
export function getMigrationsDir(): string {
  return process.env.APP_MIGRATIONS_DIR || join(process.cwd(), "drizzle");
}

/** 上传素材根目录 data/uploads */
export function getUploadsDir(): string {
  return join(getDataDir(), "uploads");
}

/** 合成输出根目录 data/output */
export function getOutputDir(): string {
  return join(getDataDir(), "output");
}
