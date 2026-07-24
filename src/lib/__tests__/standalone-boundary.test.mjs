import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const repositoryRoot = resolve(process.cwd());
const sanitizeScript = join(repositoryRoot, "scripts", "sanitize-standalone.mjs");
const verifyScript = join(repositoryRoot, "scripts", "verify-standalone.mjs");

function run(script, cwd) {
  return spawnSync(process.execPath, [script], { cwd, encoding: "utf8" });
}

describe("standalone filesystem boundary", () => {
  let root;
  let standalone;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "huimai-standalone-boundary-"));
    standalone = join(root, ".next", "standalone");
    mkdirSync(join(standalone, "nested"), { recursive: true });
    writeFileSync(join(standalone, "server.js"), "// fixture\n");
    const matting = join(standalone, "tools", "matting");
    mkdirSync(join(matting, "models"), { recursive: true });
    mkdirSync(join(matting, "node_modules", "onnxruntime-node"), { recursive: true });
    mkdirSync(join(matting, "node_modules", "sharp"), { recursive: true });
    writeFileSync(join(matting, "face-detect.mjs"), "// fixture\n");
    writeFileSync(join(matting, "node_modules", "onnxruntime-node", "package.json"), "{}\n");
    writeFileSync(join(matting, "node_modules", "sharp", "package.json"), "{}\n");
    copyFileSync(
      join(repositoryRoot, "tools", "matting", "models", "version-RFB-320.onnx"),
      join(matting, "models", "version-RFB-320.onnx"),
    );
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("清理断裂链接后通过严格校验", () => {
    const broken = join(standalone, "nested", "broken-link");
    symlinkSync(join(dirname(broken), "missing-target"), broken);

    const sanitized = run(sanitizeScript, root);
    const verified = run(verifyScript, root);

    expect(sanitized.status).toBe(0);
    expect(sanitized.stdout).toContain("nested/broken-link");
    expect(existsSync(broken)).toBe(false);
    expect(verified.status).toBe(0);
  });

  it("清理和校验都拒绝越出发布根的链接", () => {
    const outside = join(root, "outside-secret.txt");
    const link = join(standalone, "nested", "outside-link");
    writeFileSync(outside, "secret\n");
    symlinkSync(outside, link);

    const sanitized = run(sanitizeScript, root);
    const verified = run(verifyScript, root);

    expect(sanitized.status).not.toBe(0);
    expect(`${sanitized.stdout}${sanitized.stderr}`).toContain("越出发布根目录");
    expect(verified.status).not.toBe(0);
    expect(`${verified.stdout}${verified.stderr}`).toContain("越出发布根目录");
    expect(existsSync(link)).toBe(true);
  });

  it("拒绝缺失或被替换的本地人脸检测模型", () => {
    writeFileSync(
      join(standalone, "tools", "matting", "models", "version-RFB-320.onnx"),
      "tampered model\n",
    );
    const verified = run(verifyScript, root);
    expect(verified.status).not.toBe(0);
    expect(`${verified.stdout}${verified.stderr}`).toContain("人脸检测模型完整性");
  });

  it("拒绝把 Linux CUDA 人脸运行时打进 CPU 发布包", () => {
    const gpuLibrary = join(
      standalone,
      "tools",
      "matting",
      "node_modules",
      "onnxruntime-node",
      "bin",
      "napi-v3",
      "linux",
      "x64",
      "libonnxruntime_providers_cuda.so",
    );
    mkdirSync(dirname(gpuLibrary), { recursive: true });
    writeFileSync(gpuLibrary, "fixture\n");

    const verified = run(verifyScript, root);

    expect(verified.status).not.toBe(0);
    expect(`${verified.stdout}${verified.stderr}`).toContain("CPU 运行时夹带 GPU 库");
  });
});
