#!/usr/bin/env node

import { lstat, readdir, realpath, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

const projectRoot = resolve(process.cwd());
const standalone = resolve(projectRoot, ".next", "standalone");
const expectedRelative = relative(projectRoot, standalone).replaceAll("\\", "/");
if (expectedRelative !== ".next/standalone") {
  throw new Error("拒绝清理非预期 standalone 路径");
}

const rootStat = await lstat(standalone);
if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
  throw new Error("standalone 必须是普通目录");
}
const resolvedRoot = await realpath(standalone);
if (resolvedRoot !== standalone) throw new Error("standalone 真实路径异常");

const forbiddenExact = new Set([
  "data",
  ".git",
  ".pnpm-store",
  ".codex-node-env",
  ".agents",
  ".codex",
  "版本存档",
  "docs",
  "视频背景",
  "视频参考",
  "产品文档",
  "提示词文档",
  "codex交流记忆库",
  "ai营销的立项",
  "项目",
  "release",
  "展示界面.MOV",
]);

const removed = [];
for (const entry of await readdir(standalone, { withFileTypes: true })) {
  if (!forbiddenExact.has(entry.name) && entry.name !== ".env" && !entry.name.startsWith(".env.")) continue;
  // 只允许删除已验证根目录下的一层固定名称；即使目标是 symlink，rm 也只移除该目录项。
  await rm(join(standalone, entry.name), { recursive: true, force: true, maxRetries: 2 });
  removed.push(entry.name);
}

function isInsideRoot(candidate) {
  const rel = relative(standalone, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

async function removeBrokenLinks(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const stats = await lstat(path);
    if (stats.isSymbolicLink()) {
      try {
        const target = await realpath(path);
        if (!isInsideRoot(target)) {
          throw new Error(`standalone 符号链接越出发布根目录：${relative(standalone, path)}`);
        }
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
        await rm(path, { force: true });
        removed.push(relative(standalone, path).replaceAll("\\", "/"));
      }
      continue;
    }
    if (stats.isDirectory()) await removeBrokenLinks(path);
  }
}

await removeBrokenLinks(standalone);

process.stdout.write(removed.length
  ? `standalone 已移除误追踪内容：${removed.join("、")}。\n`
  : "standalone 无需清理误追踪内容。\n");
