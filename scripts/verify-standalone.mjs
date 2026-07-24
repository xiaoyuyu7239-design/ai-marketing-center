#!/usr/bin/env node

import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

const root = resolve(process.cwd(), ".next", "standalone");
const forbidden = [
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
  ".env",
  ".env.local",
  ".env.production",
];

async function metadata(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

function isInsideRoot(candidate) {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

async function verifyTreeTypesAndLinks(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const stats = await lstat(path);
    if (stats.isSymbolicLink()) {
      let target;
      try {
        target = await realpath(path);
      } catch {
        throw new Error(`standalone 校验失败：存在断裂符号链接 ${relative(root, path)}`);
      }
      if (!isInsideRoot(target)) {
        throw new Error(`standalone 校验失败：符号链接越出发布根目录 ${relative(root, path)}`);
      }
      continue;
    }
    if (stats.isDirectory()) {
      await verifyTreeTypesAndLinks(path);
      continue;
    }
    if (!stats.isFile()) {
      throw new Error(`standalone 校验失败：包含非普通文件 ${relative(root, path)}`);
    }
  }
}

async function treeBytes(directory) {
  let total = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) total += await treeBytes(path);
    else if (entry.isFile()) total += (await lstat(path)).size;
  }
  return total;
}

async function findNestedEnvFiles(directory, matches = []) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.name === ".env" || entry.name.startsWith(".env.")) {
      matches.push(relative(root, path));
      continue;
    }
    if (entry.isDirectory()) await findNestedEnvFiles(path, matches);
  }
  return matches;
}

const rootMetadata = await metadata(root);
if (!rootMetadata?.isDirectory() || rootMetadata.isSymbolicLink() || await realpath(root) !== root) {
  throw new Error("standalone 校验失败：发布根必须是非符号链接普通目录");
}
if (!(await metadata(join(root, "server.js")))) {
  throw new Error("standalone 校验失败：缺少 .next/standalone/server.js");
}

const requiredMotionSafetyFiles = [
  "tools/matting/face-detect.mjs",
  "tools/matting/models/version-RFB-320.onnx",
  "tools/matting/node_modules/onnxruntime-node/package.json",
  "tools/matting/node_modules/sharp/package.json",
];
for (const relativePath of requiredMotionSafetyFiles) {
  const stats = await metadata(join(root, relativePath));
  if (!stats?.isFile() || stats.isSymbolicLink()) {
    throw new Error(`standalone 校验失败：缺少本地动态安全依赖 ${relativePath}`);
  }
}
const faceModel = await readFile(join(root, "tools/matting/models/version-RFB-320.onnx"));
const faceModelSha256 = createHash("sha256").update(faceModel).digest("hex");
if (faceModelSha256 !== "34cd7e60aeff28744c657de7a3dc64e872d506741de66987f3426f2b79f88017") {
  throw new Error("standalone 校验失败：本地人脸检测模型完整性校验不通过");
}
const forbiddenGpuRuntimeFiles = [
  "tools/matting/node_modules/onnxruntime-node/bin/napi-v3/linux/x64/libonnxruntime_providers_cuda.so",
  "tools/matting/node_modules/onnxruntime-node/bin/napi-v3/linux/x64/libonnxruntime_providers_tensorrt.so",
];
for (const relativePath of forbiddenGpuRuntimeFiles) {
  if (await metadata(join(root, relativePath))) {
    throw new Error(`standalone 校验失败：CPU 运行时夹带 GPU 库 ${relativePath}`);
  }
}

await verifyTreeTypesAndLinks(root);

const leaked = [];
for (const relative of forbidden) {
  if (await metadata(join(root, relative))) leaked.push(relative);
}
if (leaked.length) {
  throw new Error(`standalone 校验失败：发布包包含禁止内容 ${leaked.join("、")}`);
}
const nestedEnvFiles = await findNestedEnvFiles(root);
if (nestedEnvFiles.length) {
  throw new Error(`standalone 校验失败：发布包包含环境配置 ${nestedEnvFiles.join("、")}`);
}

const bytes = await treeBytes(root);
const configuredLimit = Number(process.env.HUIMAI_MAX_STANDALONE_BYTES);
const maxBytes = Number.isSafeInteger(configuredLimit) && configuredLimit > 0
  ? configuredLimit
  : 512 * 1024 * 1024;
if (bytes > maxBytes) {
  throw new Error(`standalone 校验失败：产物 ${bytes} bytes 超过 ${maxBytes} bytes 上限`);
}

process.stdout.write(`standalone 校验通过：${bytes} bytes，未包含业务数据、环境配置、仓库元数据或指定研发归档。\n`);
