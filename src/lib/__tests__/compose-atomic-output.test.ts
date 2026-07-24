import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

const mocks = vi.hoisted(() => ({
  exec: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return { ...original, exec: mocks.exec };
});

vi.mock("child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("child_process")>();
  return { ...original, exec: mocks.exec };
});

import { composeVideo, type ComposeConfig } from "@backend/video-composer/composer";

function config(compositionId: string): ComposeConfig {
  return {
    projectId: "project-atomic",
    compositionId,
    clips: [
      {
        type: "image",
        filePath: "/tmp/input.png",
        duration: 1,
        transition: "direct_concat",
        motion: "static",
      },
    ],
    output: { resolution: "720p", aspectRatio: "9:16", videoPreset: "veryfast", crf: 24 },
  };
}

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "huimai-atomic-output-"));
  process.env.APP_DATA_DIR = dataDir;
  mocks.exec.mockReset();
});

afterEach(() => {
  delete process.env.APP_DATA_DIR;
  rmSync(dataDir, { recursive: true, force: true });
});

describe("composeVideo 确定性与原子输出", () => {
  it("FFmpeg 只写 .part.mp4，fsync 后原子更名为 final_<compositionId>.mp4", async () => {
    mocks.exec.mockImplementation(
      (command: string, _options: unknown, callback: (error: Error | null, value?: unknown) => void) => {
        const partPath = [...command.matchAll(/"([^"]+\.part\.mp4)"/g)].at(-1)?.[1];
        if (!partPath) return callback(new Error("missing part output"));
        writeFileSync(partPath, Buffer.from("complete-video"));
        callback(null, { stdout: "", stderr: "" });
      },
    );

    const output = await composeVideo(config("composition-atomic-001"));
    expect(basename(output)).toBe("final_composition-atomic-001.mp4");
    expect(existsSync(output)).toBe(true);
    expect(existsSync(output.replace(/\.mp4$/, ".part.mp4"))).toBe(false);
    expect(mocks.exec).toHaveBeenCalledTimes(1);

    // 模拟“文件 rename 成功、DB 终态提交前进程崩溃”：重启后直接复用确定性 final。
    const afterRestart = await composeVideo(config("composition-atomic-001"));
    expect(afterRestart).toBe(output);
    expect(mocks.exec).toHaveBeenCalledTimes(1);
  });

  it("FFmpeg 失败会删除半成品，绝不把 .part 暴露为可下载 final", async () => {
    mocks.exec.mockImplementation(
      (command: string, _options: unknown, callback: (error: Error | null) => void) => {
        const partPath = [...command.matchAll(/"([^"]+\.part\.mp4)"/g)].at(-1)?.[1];
        if (partPath) writeFileSync(partPath, Buffer.from("partial-video"));
        callback(new Error("simulated ffmpeg crash"));
      },
    );

    await expect(composeVideo(config("composition-atomic-failed"))).rejects.toThrow(
      "simulated ffmpeg crash",
    );
    const outputDir = join(dataDir, "output", "project-atomic");
    expect(existsSync(join(outputDir, "final_composition-atomic-failed.part.mp4"))).toBe(false);
    expect(existsSync(join(outputDir, "final_composition-atomic-failed.mp4"))).toBe(false);
  });
});
