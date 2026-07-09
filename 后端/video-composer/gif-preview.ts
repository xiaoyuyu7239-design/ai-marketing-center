import { dirname } from "path";
import { mkdir } from "fs/promises";
import { ffmpegBin } from "@backend/shared/ffmpeg-path";

export function buildGifVf(width: number, fps: number): string {
  return `fps=${fps},scale=${width}:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=128[p];[s1][p]paletteuse=dither=bayer`;
}

export async function generateGifPreview(opts: {
  videoPath: string;
  outPath: string;
  startSec?: number;
  durationSec?: number;
  width?: number;
  fps?: number;
}): Promise<void> {
  const { execFile } = await import("child_process");
  const { promisify } = await import("util");
  const run = promisify(execFile);
  const start = Math.max(0, opts.startSec ?? 0);
  const duration = Math.min(10, Math.max(1, opts.durationSec ?? 4));
  const width = Math.min(720, Math.max(120, opts.width ?? 360));
  const fps = Math.min(20, Math.max(5, opts.fps ?? 12));
  await mkdir(dirname(opts.outPath), { recursive: true });
  await run(ffmpegBin(), [
    "-y",
    "-ss",
    String(start),
    "-t",
    String(duration),
    "-i",
    opts.videoPath,
    "-vf",
    buildGifVf(width, fps),
    "-loop",
    "0",
    opts.outPath,
  ]);
}
