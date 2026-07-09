import { dirname } from "path";
import { mkdir } from "fs/promises";
import { ffmpegBin, ffprobeBin } from "@backend/shared/ffmpeg-path";
import { buildDrawtext } from "./composer";

export interface EndCardVfOpts {
  width: number;
  totalDuration: number;
  qrRatio?: number;
  seconds?: number;
  ctaText?: string;
  fontFile?: string;
}

export function buildEndCardFilter(opts: EndCardVfOpts): string {
  const qrW = Math.round(opts.width * (opts.qrRatio ?? 0.34));
  const show = Math.max(1, Math.min(opts.seconds ?? 3, opts.totalDuration || 3));
  const start = Math.max(0, (opts.totalDuration || show) - show).toFixed(2);
  const enable = `enable='gte(t,${start})'`;
  const overlay = `[1:v]scale=${qrW}:${qrW}[qr];[0:v][qr]overlay=x=(main_w-overlay_w)/2:y=(main_h-overlay_h)/2:${enable}`;

  if (!opts.ctaText) return `${overlay}[vout]`;

  const fontSize = Math.round(opts.width * 0.05);
  const cta = buildDrawtext({
    fontFile: opts.fontFile,
    text: opts.ctaText,
    fontSize,
    fontColor: "white",
    borderW: Math.max(2, Math.round(opts.width * 0.005)),
    box: { color: "black@0.5", borderW: Math.round(opts.width * 0.02) },
    x: "(w-text_w)/2",
    y: `(h-${qrW})/2-${Math.round(fontSize * 2)}`,
    enable,
  });

  return `${overlay}[ov];[ov]${cta}[vout]`;
}

async function probeVideo(videoPath: string): Promise<{ width: number; duration: number }> {
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
      "stream=width:format=duration",
      "-of",
      "default=nw=1:nk=1",
      videoPath,
    ]);
    const nums = String(stdout).trim().split(/\s+/).map((value) => parseFloat(value));
    const width = Number.isFinite(nums[0]) && nums[0] > 0 ? Math.round(nums[0]) : 1080;
    const duration = Number.isFinite(nums[1]) && nums[1] > 0 ? nums[1] : 0;
    return { width, duration };
  } catch {
    return { width: 1080, duration: 0 };
  }
}

export async function generateEndCard(opts: {
  videoPath: string;
  qrPath: string;
  outPath: string;
  ctaText?: string;
  qrRatio?: number;
  seconds?: number;
  fontFile?: string;
}): Promise<void> {
  const { execFile } = await import("child_process");
  const { promisify } = await import("util");
  const run = promisify(execFile);
  const { width, duration } = await probeVideo(opts.videoPath);
  const vf = buildEndCardFilter({
    width,
    totalDuration: duration,
    qrRatio: opts.qrRatio,
    seconds: opts.seconds,
    ctaText: opts.ctaText,
    fontFile: opts.fontFile,
  });
  await mkdir(dirname(opts.outPath), { recursive: true });
  await run(ffmpegBin(), [
    "-y",
    "-i",
    opts.videoPath,
    "-i",
    opts.qrPath,
    "-filter_complex",
    vf,
    "-map",
    "[vout]",
    "-map",
    "0:a?",
    "-map_metadata",
    "0",
    "-c:v",
    "libx264",
    "-preset",
    "medium",
    "-crf",
    "20",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    "-c:a",
    "copy",
    opts.outPath,
  ]);
}
