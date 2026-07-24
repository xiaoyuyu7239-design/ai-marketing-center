import type { NextConfig } from "next";

const contentSecurityPolicy = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  `script-src 'self' 'unsafe-inline'${process.env.NODE_ENV === "production" ? "" : " 'unsafe-eval'"}`,
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "img-src 'self' data: blob: https:",
  "media-src 'self' blob: https:",
  `connect-src 'self' https:${process.env.NODE_ENV === "production" ? "" : " ws: wss:"}`,
  "worker-src 'self' blob:",
  process.env.NODE_ENV === "production" ? "upgrade-insecure-requests" : "",
].filter(Boolean).join("; ");

const runtimeTraceExcludes = [
  "./data/**/*",
  "./.git/**/*",
  "./.pnpm-store/**/*",
  "./.codex-node-env/**/*",
  "./.agents/**/*",
  "./.codex/**/*",
  "./版本存档/**/*",
  "./docs/**/*",
  "./视频背景/**/*",
  "./视频参考/**/*",
  "./产品文档/**/*",
  "./提示词文档/**/*",
  "./codex交流记忆库/**/*",
  "./ai营销的立项/**/*",
  "./项目/**/*",
  "./release/**/*",
  "./public/**/*",
  "./展示界面.MOV",
  "./.env",
  "./.env.*",
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // 远端 release 构建把完整 commit SHA 写成 Next BUILD_ID；生产预检会与运行时声明逐字核对。
  generateBuildId: async () => process.env.HUIMAI_CODE_VERSION?.trim() || null,
  // standalone 产物：next build 额外输出 .next/standalone（含最小 server.js + nft 追踪的依赖子集），
  // 供 Electron 主进程 fork 启动，无需在用户机 npm install。不影响 next dev。
  output: "standalone",
  // 所有运行时业务数据都由挂载卷/用户目录注入，绝不能被 NFT 误追踪进发布包。
  // instrumentation 不是 URL route，必须单独匹配；next-server 再做纵深防护。
  outputFileTracingExcludes: {
    "/*": runtimeTraceExcludes,
    instrumentation: runtimeTraceExcludes,
    "next-server": runtimeTraceExcludes,
  },
  // better-sqlite3 是原生模块，标记为外部（用 require 加载，不让打包器尝试打包它的 .node）
  serverExternalPackages: ["better-sqlite3"],
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          { key: "Content-Security-Policy", value: contentSecurityPolicy },
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          { key: "X-Permitted-Cross-Domain-Policies", value: "none" },
          ...(process.env.NODE_ENV === "production"
            ? [{ key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" }]
            : []),
        ],
      },
      {
        source: "/api/admin/:path*",
        headers: [
          { key: "Cache-Control", value: "private, no-store" },
          { key: "Vary", value: "Cookie" },
        ],
      },
    ];
  },
};

export default nextConfig;
