// electron-builder afterPack 钩子：把 Next standalone（含完整 node_modules）整体拷进 App 资源目录。
// 原因：electron-builder 的 extraResources 文件收集器会主动丢弃 node_modules 目录，
// 导致打包后 standalone/node_modules 为空（找不到 next / better-sqlite3 原生模块，启动即崩）。
// standalone 已由 bundle-standalone.mjs 解引用为无软链实体，这里直接整目录拷贝即可绕过该过滤。
const path = require("path");
const fs = require("fs");
const { execSync } = require("child_process");

exports.default = async function afterPack(context) {
  const { appOutDir, packager, electronPlatformName } = context;
  const productName = packager.appInfo.productFilename;

  const resourcesDir =
    electronPlatformName === "darwin"
      ? path.join(appOutDir, `${productName}.app`, "Contents", "Resources")
      : path.join(appOutDir, "resources");

  const src = path.join(process.cwd(), ".next", "standalone");
  const dest = path.join(resourcesDir, "standalone");

  if (!fs.existsSync(src)) {
    throw new Error(`[afterPack] 未找到 ${src}，请确认已 next build + bundle:standalone`);
  }

  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  // 用 cp -R 保留 pnpm 相对软链结构（完整），避免解引用丢失 @swc/helpers 等 peer 依赖。
  // mac/linux：cp -R；Windows 打包(CI matrix)走 robocopy /e（保留 junction）。
  if (process.platform === "win32") {
    execSync(`robocopy "${src}" "${dest}" /e /nfl /ndl /njh /njs >NUL || ver>NUL`, { shell: "cmd.exe" });
  } else {
    execSync(`cp -R "${src}/." "${dest}/"`);
  }

  const ok = fs.existsSync(path.join(dest, "node_modules", "next", "package.json"));
  console.log(`[afterPack] standalone 已拷入 ${dest}（next 模块就位:${ok}）`);
  if (!ok) throw new Error("[afterPack] 拷贝后未见 node_modules/next，打包中止");
};
