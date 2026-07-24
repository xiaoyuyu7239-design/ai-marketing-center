import { describe, it, expect } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAigcMetadataArgs } from "@backend/core/publish/compliance-metadata";
import { ffmpegBin, ffprobeBin } from "@backend/shared/ffmpeg-path";

const hasFfmpeg = spawnSync(ffmpegBin(), ["-version"], { stdio: "ignore" }).status === 0;
const hasFfprobe = spawnSync(ffprobeBin(), ["-version"], { stdio: "ignore" }).status === 0;

function metadataCliArgs(metadata: string): string[] {
  return [...metadata.matchAll(/-metadata ([^= ]+)="([^"]*)"/g)].flatMap((match) => [
    "-metadata",
    `${match[1]}=${match[2]}`,
  ]);
}

describe("buildAigcMetadataArgs（GB 45438-2025 隐式标识）", () => {
  it("含三要素：生成合成标签 + 服务提供者 + 内容制作编号", () => {
    const s = buildAigcMetadataArgs({ contentId: "proj-123" });
    expect(s).toContain("AIGC=1");
    expect(s).toContain("AI生成合成");
    expect(s).toContain("绘卖AI"); // 默认服务提供者
    expect(s).toContain("proj-123"); // 内容制作编号
    expect(s).toContain("-metadata comment=");
    expect(s).toContain("-metadata copyright=");
    expect(s).toContain("-metadata description=");
  });

  it("确定性：同输入同输出", () => {
    expect(buildAigcMetadataArgs({ contentId: "x" })).toBe(buildAigcMetadataArgs({ contentId: "x" }));
  });

  it("自定义服务提供者生效", () => {
    expect(buildAigcMetadataArgs({ contentId: "x", serviceProvider: "我的品牌" })).toContain("我的品牌");
  });

  it("净化 shell 注入字符（双引号/$/反斜杠/反引号/换行被剥离）", () => {
    const s = buildAigcMetadataArgs({ contentId: 'a"b$c`d\\e\nf', serviceProvider: 'p$q' });
    expect(s).toContain("abcdef"); // 危险字符剔除后剩余
    expect(s).not.toContain("$");
    expect(s).not.toContain("`");
    expect(s).not.toContain("\\");
  });

  it("空 / 缺省 contentId 兜底为 unknown", () => {
    expect(buildAigcMetadataArgs({ contentId: "" })).toContain("unknown");
  });

  it.skipIf(!hasFfmpeg || !hasFfprobe)(
    "ffprobe 能从真实 MP4 回读 compositionId 与生产服务提供者，同一 retry 稳定",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "huimai-aigc-metadata-"));
      const compositionId = "composition-ffprobe-001";
      const provider = "绘卖内测运营主体";
      const readTags = (name: string) => {
        const output = join(dir, `${name}.mp4`);
        const metadata = buildAigcMetadataArgs({ contentId: compositionId, serviceProvider: provider });
        execFileSync(
          ffmpegBin(),
          [
            "-y",
            "-f",
            "lavfi",
            "-i",
            "color=c=black:s=16x16:d=0.1",
            "-an",
            "-c:v",
            "mpeg4",
            ...metadataCliArgs(metadata),
            output,
          ],
          { stdio: "pipe" },
        );
        const probed = execFileSync(
          ffprobeBin(),
          [
            "-v",
            "error",
            "-show_entries",
            "format_tags=comment,copyright,description",
            "-of",
            "json",
            output,
          ],
          { encoding: "utf8" },
        );
        return (JSON.parse(probed) as { format?: { tags?: Record<string, string> } }).format?.tags;
      };

      try {
        const first = readTags("first");
        const retry = readTags("retry");
        expect(first?.comment).toContain(`服务提供者=${provider}`);
        expect(first?.comment).toContain(`内容制作编号=${compositionId}`);
        expect(retry?.comment).toBe(first?.comment);
        expect(retry?.copyright).toBe(first?.copyright);
        expect(retry?.description).toBe(first?.description);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    15_000,
  );
});
