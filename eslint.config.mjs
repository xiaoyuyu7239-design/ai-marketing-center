import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Electron 主进程与构建脚本是 Node CommonJS/ESM 入口，不走 Next 应用的 lint 规则
    "electron/**",
    "scripts/**",
    "release/**",
  ]),
]);

export default eslintConfig;
