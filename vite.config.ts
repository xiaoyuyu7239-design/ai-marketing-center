import { resolve } from "path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
      "@frontend": resolve(__dirname, "前端"),
      "@backend": resolve(__dirname, "后端"),
      "@server": resolve(__dirname, "服务器"),
    },
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
  },
  build: {
    outDir: "dist-vite",
  },
  test: {
    exclude: ["node_modules/**", ".pnpm-store/**", "版本存档/**", "e2e/**", ".next/**", "dist-vite/**"],
  },
});
