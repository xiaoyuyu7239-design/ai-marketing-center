import path from "path";
import { defineConfig } from "vitest/config";

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
    environment: "node",
    include: ["src/lib/__tests__/**/*.integration.test.ts"],
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
});
