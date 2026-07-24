#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(process.cwd());
const toolRoot = join(root, "tools", "matting");
const required = [
  join(toolRoot, "node_modules", "sharp", "package.json"),
  join(toolRoot, "node_modules", "onnxruntime-node", "package.json"),
  join(toolRoot, "node_modules", "@imgly", "background-removal-node", "package.json"),
];
const forbiddenGpuRuntime = [
  join(toolRoot, "node_modules", "onnxruntime-node", "bin", "napi-v3", "linux", "x64", "libonnxruntime_providers_cuda.so"),
  join(toolRoot, "node_modules", "onnxruntime-node", "bin", "napi-v3", "linux", "x64", "libonnxruntime_providers_tensorrt.so"),
];
const refresh = process.argv.includes("--refresh");

if (!refresh && required.every(existsSync) && !forbiddenGpuRuntime.some(existsSync)) {
  process.stdout.write("本地图像/人脸安全 CPU 运行时已就绪。\n");
  process.exit(0);
}

if (!existsSync(join(toolRoot, "package-lock.json"))) {
  throw new Error("缺少 tools/matting/package-lock.json，无法确定性安装本地安全运行时");
}

process.stdout.write("安装本地图像/人脸安全运行时…\n");
execFileSync("npm", ["ci", "--prefix", toolRoot, "--omit=dev"], {
  cwd: root,
  // onnxruntime-node 1.17.x 会在 Linux x64 默认下载约 500MB CUDA/TensorRT 库。
  // 生产环境是 CPU 实例，必须显式关闭，避免无用 GPU 二进制进入 standalone/Docker 镜像。
  env: {
    ...process.env,
    npm_config_onnxruntime_node_install_cuda: "skip",
  },
  stdio: "inherit",
});

if (!required.every(existsSync)) {
  throw new Error("本地图像/人脸安全运行时安装不完整");
}
if (forbiddenGpuRuntime.some(existsSync)) {
  throw new Error("本地图像/人脸安全运行时夹带 GPU 库，拒绝继续构建");
}
