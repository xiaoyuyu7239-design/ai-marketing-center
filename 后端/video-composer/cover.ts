import { dirname } from "path";
import { mkdir } from "fs/promises";
import { ffmpegBin, ffprobeBin } from "@backend/shared/ffmpeg-path";
import { buildDrawtext, resolveChineseFontFile, wrapCaption } from "./composer";

export interface CoverVfOpts {
  title: string;
  width: number;
  fontFile?: string;
  position?: "center" | "lower" | "upper";
}

export function buildCoverVf(opts: CoverVfOpts): string {
  const fontSize = Math.round(opts.width * 0.09);
  const lines = wrapCaption(opts.title, fontSize, opts.width).split("\n");
  const lineH = Math.round(fontSize * 1.5);
  const blockH = lines.length * lineH;
  const base =
    opts.position === "lower"
      ? `h*0.78-${Math.round(blockH / 2)}`
      : opts.position === "upper"
        ? `h*0.2-${Math.round(blockH / 2)}`
        : `(h-${blockH})/2`;

  return lines
    .map((line, index) =>
      buildDrawtext({
        fontFile: opts.fontFile,
        text: line || " ",
        fontSize,
        fontColor: "white",
        borderW: Math.max(2, Math.round(opts.width * 0.006)),
        box: { color: "black@0.5", borderW: Math.round(opts.width * 0.015) },
        x: "(w-text_w)/2",
        y: `${base}+${index * lineH}`,
      })
    )
    .join(",");
}

async function probeWidth(videoPath: string): Promise<number> {
  const { execFile } = await import("child_process");
  const { promisify } = await import("util");
  const run = promisify(execFile);
  try {
    const { stdout } = await run(ffprobeBin(), [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=width",
      "-of",
      "default=nw=1:nk=1",
      videoPath,
    ]);
    const width = parseInt(String(stdout).trim(), 10);
    return Number.isFinite(width) && width > 0 ? width : 1080;
  } catch {
    return 1080;
  }
}

export async function generateCover(opts: {
  videoPath: string;
  title: string;
  outPath: string;
  frameAtSec?: number;
  position?: CoverVfOpts["position"];
}): Promise<void> {
  const { execFile } = await import("child_process");
  const { promisify } = await import("util");
  const run = promisify(execFile);
  const width = await probeWidth(opts.videoPath);
  const frameAt = Math.max(0, opts.frameAtSec ?? 1);
  const vf = buildCoverVf({
    title: opts.title,
    width,
    fontFile: resolveChineseFontFile(),
    position: opts.position,
  });
  await mkdir(dirname(opts.outPath), { recursive: true });
  await run(ffmpegBin(), ["-y", "-ss", String(frameAt), "-i", opts.videoPath, "-frames:v", "1", "-vf", vf, opts.outPath]);
}
