import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@frontend": path.resolve(__dirname, "./前端"),
      "@backend": path.resolve(__dirname, "./后端"),
      "@server": path.resolve(__dirname, "./服务器"),
      "server-only": path.resolve(__dirname, "./src/lib/test-server-only.ts"),
    },
  },
  test: {
    environment: "jsdom",
    // 排除依赖、构建产物(.next/standalone 会把 e2e 拷进去)、Playwright e2e 目录
    exclude: ["**/node_modules/**", "**/.pnpm-store/**", "**/.next/**", "**/dist/**", "**/e2e/**", "**/版本存档/**", "**/*.integration.test.ts"],
  },
});
