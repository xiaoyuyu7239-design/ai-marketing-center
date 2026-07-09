// 构建后补齐 standalone 自包含资源（next build 的 standalone 默认不含 static/public），
// 拷贝迁移 SQL，并把 standalone 里的 better-sqlite3 副本换成 Electron ABI 的预编译二进制。
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { execSync } from "child_process";
import { createRequire } from "module";
import { join } from "path";

const require = createRequire(import.meta.url);
const root = process.cwd();
const standalone = join(root, ".next", "standalone");

if (!existsSync(standalone)) {
  console.error("✗ 未找到 .next/standalone，请先 next build（需 next.config 开启 output:'standalone'）");
  process.exit(1);
}

const copies = [
  [join(root, ".next", "static"), join(standalone, ".next", "static")],
  [join(root, "public"), join(standalone, "public")],
  [join(root, "drizzle"), join(standalone, "drizzle")],
];

for (const [from, to] of copies) {
  if (!existsSync(from)) {
    console.warn(`⚠ 跳过(源不存在): ${from}`);
    continue;
  }
  mkdirSync(to, { recursive: true });
  cpSync(from, to, { recursive: true });
  console.log(`✓ ${from} → ${to}`);
}

// 注：standalone/node_modules 保持 pnpm 原始软链结构（afterPack 用 cp -R 保链整体拷贝，完整不丢依赖）。

// === 把 standalone 的 better-sqlite3 副本换成 Electron 运行时的 ABI 预编译 ===
// 主 node_modules 那份保持系统 Node ABI（next build 的 collect page data 要用它）；
// 打包后 App 用 Electron 内置 Node fork server.js，需匹配 Electron 的 ABI（如 Electron 42=146），
// 否则任何 DB 路由都会因 NODE_MODULE_VERSION 不匹配而 500。直接取官方 electron-vXXX 预编译，不编译源码。
// 注：cp/tar 等命令面向 mac/linux 构建机；Windows 打包(CI matrix)时再按平台分支。
await rebuildBetterSqlite3ForElectron();

async function rebuildBetterSqlite3ForElectron() {
  const pnpmDir = join(standalone, "node_modules", ".pnpm");
  const bsEntry = existsSync(pnpmDir) ? readdirSync(pnpmDir).find((d) => d.startsWith("better-sqlite3@")) : null;
  if (!bsEntry) {
    console.warn("⚠ standalone 未找到 better-sqlite3，跳过 Electron ABI 重建");
    return;
  }
  const bsDir = join(pnpmDir, bsEntry, "node_modules", "better-sqlite3");
  const bsVer = JSON.parse(readFileSync(join(bsDir, "package.json"), "utf8")).version;

  // 问 Electron 自己的 module ABI（最可靠，不依赖 node-abi 版本映射）
  const electronPath = require("electron"); // 返回 Electron 可执行文件绝对路径
  const abi = execSync(`"${electronPath}" -e "process.stdout.write(String(process.versions.modules))"`, {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  })
    .toString()
    .trim();

  const plat = process.platform; // darwin / win32 / linux
  const arch = process.arch; // arm64 / x64 / ia32
  const asset = `better-sqlite3-v${bsVer}-electron-v${abi}-${plat}-${arch}.tar.gz`;
  const url = `https://github.com/WiseLibs/better-sqlite3/releases/download/v${bsVer}/${asset}`;
  console.log(`重建 standalone better-sqlite3 → Electron ABI ${abi}：${asset}`);

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`下载 Electron 预编译失败 ${res.status}：${url}（确认 better-sqlite3 ${bsVer} 该 release 有 electron-v${abi}-${plat}-${arch} 资产）`);
  }
  const tmp = join(root, ".next", "bs-electron.tar.gz");
  writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
  execSync(`tar -xzf "${tmp}" -C "${bsDir}"`);

  const node = join(bsDir, "build", "Release", "better_sqlite3.node");
  if (!existsSync(node)) throw new Error("解包后未见 better_sqlite3.node，Electron ABI 重建失败");
  console.log("✓ standalone better-sqlite3 已切到 Electron ABI（打包 App 的 DB 路由可用）");
}

console.log("standalone 资源补齐完成");
