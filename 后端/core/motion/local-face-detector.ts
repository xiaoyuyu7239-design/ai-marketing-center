import "server-only";

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import type { FaceDetector, FaceDetectionOutput } from "./face-detector";

const run = promisify(execFile);

export const LOCAL_FACE_DETECTOR_REVISION =
  "ultraface-rfb320@6fd293d-score0.65-review0.35-v1";

interface DetectorCliResult {
  ok?: unknown;
  status?: unknown;
  detectorRevision?: unknown;
  faceCount?: unknown;
  maxScore?: unknown;
  detections?: unknown;
  error?: unknown;
}

function finiteUnit(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(1, value))
    : undefined;
}

function parseDetectorOutput(stdout: string): FaceDetectionOutput {
  const line = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
  if (!line) throw new Error("人脸检测器未返回结果");
  const payload = JSON.parse(line) as DetectorCliResult;
  if (payload.ok !== true || payload.detectorRevision !== LOCAL_FACE_DETECTOR_REVISION) {
    throw new Error(typeof payload.error === "string" ? payload.error : "人脸检测器结果无效");
  }
  if (!['clear', 'face_detected', 'review_required'].includes(String(payload.status))) {
    throw new Error("人脸检测器状态无效");
  }
  const boxes = Array.isArray(payload.detections)
    ? payload.detections.flatMap((item) => {
        if (!item || typeof item !== "object") return [];
        const box = item as Record<string, unknown>;
        const values = [box.x, box.y, box.width, box.height];
        if (!values.every((value) => typeof value === "number" && Number.isFinite(value))) return [];
        return [{
          x: Math.max(0, Math.round(box.x as number)),
          y: Math.max(0, Math.round(box.y as number)),
          width: Math.max(1, Math.round(box.width as number)),
          height: Math.max(1, Math.round(box.height as number)),
          ...(finiteUnit(box.score) !== undefined ? { score: finiteUnit(box.score) } : {}),
        }];
      })
    : undefined;
  return {
    status: payload.status as FaceDetectionOutput["status"],
    ...(finiteUnit(payload.maxScore) !== undefined ? { score: finiteUnit(payload.maxScore) } : {}),
    ...(typeof payload.faceCount === "number" && Number.isFinite(payload.faceCount)
      ? { faceCount: Math.max(0, Math.round(payload.faceCount)) }
      : {}),
    ...(boxes ? { boxes } : {}),
  };
}

/**
 * UltraFace 本地子进程适配器。主 Next 进程不直接加载 ONNX 原生绑定，
 * 保持 pnpm/standalone/Electron ABI 隔离；图片从始至终只在本机文件系统中读取。
 */
export function getDefaultFaceDetector(): FaceDetector {
  const toolDir = join(/* turbopackIgnore: true */ process.cwd(), "tools", "matting");
  const script = join(/* turbopackIgnore: true */ toolDir, "face-detect.mjs");
  const model = join(/* turbopackIgnore: true */ toolDir, "models", "version-RFB-320.onnx");
  const runtime = join(
    /* turbopackIgnore: true */ toolDir,
    "node_modules",
    "onnxruntime-node",
    "package.json",
  );
  const available = existsSync(script) && existsSync(model) && existsSync(runtime);

  return {
    modelRevision: LOCAL_FACE_DETECTOR_REVISION,
    available,
    async detect(input) {
      if (!available) {
        return { status: "review_required", note: "本地人脸检测器未完整安装" };
      }
      if (!isAbsolute(input.imagePath)) throw new Error("人脸检测只接受经归属校验的绝对路径");
      const { stdout } = await run(process.execPath, [script, input.imagePath], {
        cwd: toolDir,
        encoding: "utf8",
        timeout: 30_000,
        maxBuffer: 256 * 1024,
        env: { ...process.env, ORT_LOG_SEVERITY_LEVEL: "4" },
      });
      return parseDetectorOutput(stdout);
    },
  };
}

