import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // standalone 产物：next build 额外输出 .next/standalone（含最小 server.js + nft 追踪的依赖子集），
  // 供 Electron 主进程 fork 启动，无需在用户机 npm install。不影响 next dev。
  output: "standalone",
  // better-sqlite3 是原生模块，标记为外部（用 require 加载，不让打包器尝试打包它的 .node）
  serverExternalPackages: ["better-sqlite3"],
};

export default nextConfig;
