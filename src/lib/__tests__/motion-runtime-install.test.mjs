import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const repositoryRoot = resolve(process.cwd());
const ensureScript = join(repositoryRoot, "scripts", "ensure-motion-runtime.mjs");

describe("motion runtime installer", () => {
  let root;

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("在 Linux 构建路径中明确禁止安装 ONNX CUDA 运行时", () => {
    root = mkdtempSync(join(tmpdir(), "huimai-motion-runtime-"));
    const toolRoot = join(root, "tools", "matting");
    const binRoot = join(root, "bin");
    const evidencePath = join(root, "npm-env.txt");
    mkdirSync(toolRoot, { recursive: true });
    mkdirSync(binRoot, { recursive: true });
    writeFileSync(join(toolRoot, "package-lock.json"), "{}\n");

    const fakeNpm = join(binRoot, "npm");
    writeFileSync(
      fakeNpm,
      `#!/bin/sh\nset -eu\nprintf '%s' \"$npm_config_onnxruntime_node_install_cuda\" > \"$HUIMAI_TEST_EVIDENCE\"\nmkdir -p \"$HUIMAI_TEST_ROOT/tools/matting/node_modules/sharp\"\nmkdir -p \"$HUIMAI_TEST_ROOT/tools/matting/node_modules/onnxruntime-node\"\nmkdir -p \"$HUIMAI_TEST_ROOT/tools/matting/node_modules/@imgly/background-removal-node\"\nprintf '{}\\n' > \"$HUIMAI_TEST_ROOT/tools/matting/node_modules/sharp/package.json\"\nprintf '{}\\n' > \"$HUIMAI_TEST_ROOT/tools/matting/node_modules/onnxruntime-node/package.json\"\nprintf '{}\\n' > \"$HUIMAI_TEST_ROOT/tools/matting/node_modules/@imgly/background-removal-node/package.json\"\n`,
    );
    chmodSync(fakeNpm, 0o755);

    const result = spawnSync(process.execPath, [ensureScript, "--refresh"], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${binRoot}${delimiter}${process.env.PATH ?? ""}`,
        HUIMAI_TEST_EVIDENCE: evidencePath,
        HUIMAI_TEST_ROOT: root,
      },
    });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(readFileSync(evidencePath, "utf8")).toBe("skip");
  });
});
