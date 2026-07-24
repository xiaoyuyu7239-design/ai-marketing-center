import "server-only";

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { extname, normalize, sep } from "node:path";
import { promisify } from "node:util";
import { resolveOwnedUploadRef } from "@backend/core/auth/media-access";
import { ffprobeBin } from "@backend/shared/ffmpeg-path";
import { getUploadsDir } from "@backend/shared/paths";
import {
  inferMotionMediaKind,
  type MotionAssetType,
  type MotionMediaKind,
  type MotionSource,
} from "./eligibility";

const run = promisify(execFile);

interface ProbeJson {
  streams?: Array<{ width?: number; height?: number; codec_type?: string }>;
  format?: { duration?: string; format_name?: string };
}

export interface MotionSourceInspection {
  imageRef: string;
  /** 仅供服务端检测器使用，不得原样返回给浏览器。 */
  localPath: string;
  imageHash: string;
  mediaKind: MotionMediaKind;
  width: number | null;
  height: number | null;
  mimeType: string | undefined;
  sizeBytes: number;
}

function mimeTypeFor(path: string): string | undefined {
  const ext = extname(path).toLowerCase();
  const map: Record<string, string> = {
    ".avif": "image/avif",
    ".gif": "image/gif",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
    ".m4v": "video/x-m4v",
    ".mov": "video/quicktime",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
  };
  return map[ext];
}

async function sha256File(path: string): Promise<string> {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk as Buffer);
  return digest.digest("hex");
}

async function probeVisual(path: string): Promise<{
  width: number | null;
  height: number | null;
  formatName: string;
  duration: number | null;
}> {
  const { stdout } = await run(ffprobeBin(), [
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "stream=codec_type,width,height:format=format_name,duration",
    "-of", "json",
    path,
  ], {
    encoding: "utf8",
    timeout: 15_000,
    maxBuffer: 1024 * 1024,
  });
  const parsed = JSON.parse(stdout || "{}") as ProbeJson;
  const stream = parsed.streams?.find((item) => item.codec_type === "video") ?? parsed.streams?.[0];
  const positive = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : null;
  const rawDuration = Number(parsed.format?.duration);
  return {
    width: positive(stream?.width),
    height: positive(stream?.height),
    formatName: parsed.format?.format_name || "",
    duration: Number.isFinite(rawDuration) && rawDuration > 0 ? rawDuration : null,
  };
}

function kindFromProbe(ref: string, probe: Awaited<ReturnType<typeof probeVisual>>): MotionMediaKind {
  const inferred = inferMotionMediaKind(ref);
  if (inferred !== "unknown") return inferred;
  if (probe.duration) return "video";
  if (/(?:image2|jpeg_pipe|png_pipe|webp_pipe|gif)/i.test(probe.formatName)) return "image";
  return "unknown";
}

/**
 * 对已完成归属校验的本地素材做内容级绑定：SHA-256 + ffprobe 尺寸/类型。
 * 检查前后文件属性必须相同，防止读取过程中被替换后产生错绑。
 */
export async function inspectOwnedMotionSource(input: {
  imageRef: string;
  merchantId: string;
  projectId: string;
}): Promise<MotionSourceInspection> {
  const localPath = resolveOwnedUploadRef(input.imageRef, input.merchantId, input.projectId);
  if (!localPath) throw new Error("动态素材不属于当前商家或项目");

  const before = await lstat(localPath);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error("动态素材必须是普通文件");
  // 同时防守父目录符号链接：真实路径仍必须在 uploads 根内。
  const [resolvedPath, resolvedRoot] = await Promise.all([realpath(localPath), realpath(getUploadsDir())]);
  const normalizedPath = normalize(resolvedPath);
  const normalizedRoot = normalize(resolvedRoot);
  if (normalizedPath !== normalizedRoot && !normalizedPath.startsWith(normalizedRoot + sep)) {
    throw new Error("动态素材真实路径越界");
  }
  const [imageHash, probe] = await Promise.all([sha256File(normalizedPath), probeVisual(normalizedPath)]);
  const after = await lstat(normalizedPath);
  if (
    !after.isFile()
    || after.isSymbolicLink()
    || before.size !== after.size
    || before.mtimeMs !== after.mtimeMs
    || before.ino !== after.ino
  ) {
    throw new Error("动态素材在检查期间发生变化，请重试");
  }

  return {
    imageRef: input.imageRef,
    localPath: normalizedPath,
    imageHash,
    mediaKind: kindFromProbe(input.imageRef, probe),
    width: probe.width,
    height: probe.height,
    mimeType: mimeTypeFor(normalizedPath),
    sizeBytes: after.size,
  };
}

export function motionSourceFromInspection(input: {
  inspection: MotionSourceInspection;
  assetId?: string | null;
  assetType?: MotionAssetType | null;
}): MotionSource {
  return {
    assetId: input.assetId,
    assetType: input.assetType,
    imageRef: input.inspection.imageRef,
    imageHash: input.inspection.imageHash,
    mediaKind: input.inspection.mediaKind,
    width: input.inspection.width,
    height: input.inspection.height,
  };
}
