#!/usr/bin/env node
/**
 * 本地人脸风险检查（零 API）。
 *
 * 用法：node face-detect.mjs <input-image>
 * stdout 只输出一行 JSON，供主程序安全解析。检测器只判断“是否有清晰人脸”，
 * 不识别身份、不生成人脸特征向量，也不上传图片。
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as ort from "onnxruntime-node";
import sharp from "sharp";

const [, , inputPath] = process.argv;
if (!inputPath) {
  console.error("usage: node face-detect.mjs <input-image>");
  process.exit(2);
}

const WIDTH = 320;
const HEIGHT = 240;
const FACE_THRESHOLD = 0.65;
const REVIEW_THRESHOLD = 0.35;
const NMS_IOU_THRESHOLD = 0.3;
const MODEL_SHA256 = "34cd7e60aeff28744c657de7a3dc64e872d506741de66987f3426f2b79f88017";
const DETECTOR_REVISION = "ultraface-rfb320@6fd293d-score0.65-review0.35-v1";
const here = dirname(fileURLToPath(import.meta.url));
const modelPath = join(here, "models", "version-RFB-320.onnx");

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function intersectionOverUnion(a, b) {
  const left = Math.max(a.x1, b.x1);
  const top = Math.max(a.y1, b.y1);
  const right = Math.min(a.x2, b.x2);
  const bottom = Math.min(a.y2, b.y2);
  const intersection = Math.max(0, right - left) * Math.max(0, bottom - top);
  const areaA = Math.max(0, a.x2 - a.x1) * Math.max(0, a.y2 - a.y1);
  const areaB = Math.max(0, b.x2 - b.x1) * Math.max(0, b.y2 - b.y1);
  const union = areaA + areaB - intersection;
  return union > 0 ? intersection / union : 0;
}

function nonMaximumSuppression(detections) {
  const sorted = [...detections].sort((left, right) => right.score - left.score);
  const kept = [];
  for (const candidate of sorted) {
    if (kept.every((existing) => intersectionOverUnion(existing, candidate) < NMS_IOU_THRESHOLD)) {
      kept.push(candidate);
    }
  }
  return kept;
}

async function main() {
  // 该旧版官方模型把权重也列在 graph input 里，ORT 会输出大量无害的优化警告。
  // CLI stdout 是机器协议，因此只保留 fatal；真实推理错误仍由 catch 结构化返回。
  ort.env.logLevel = "fatal";
  const model = await readFile(modelPath);
  const digest = createHash("sha256").update(model).digest("hex");
  if (digest !== MODEL_SHA256) throw new Error("人脸检测模型完整性校验失败");

  const source = sharp(await readFile(inputPath), { failOn: "error" }).rotate();
  const metadata = await source.metadata();
  const originalWidth = metadata.width || WIDTH;
  const originalHeight = metadata.height || HEIGHT;
  const { data } = await source
    .removeAlpha()
    .toColourspace("srgb")
    .resize(WIDTH, HEIGHT, { fit: "fill" })
    .raw()
    .toBuffer({ resolveWithObject: true });

  // UltraFace 输入为 RGB NCHW，归一化 (value - 127) / 128。
  const chw = new Float32Array(3 * WIDTH * HEIGHT);
  const plane = WIDTH * HEIGHT;
  for (let pixel = 0; pixel < plane; pixel += 1) {
    chw[pixel] = (data[pixel * 3] - 127) / 128;
    chw[plane + pixel] = (data[pixel * 3 + 1] - 127) / 128;
    chw[plane * 2 + pixel] = (data[pixel * 3 + 2] - 127) / 128;
  }

  const session = await ort.InferenceSession.create(model, {
    executionProviders: ["cpu"],
    graphOptimizationLevel: "all",
    logSeverityLevel: 4,
  });
  const result = await session.run({ input: new ort.Tensor("float32", chw, [1, 3, HEIGHT, WIDTH]) });
  const scores = result.scores?.data;
  const boxes = result.boxes?.data;
  if (!scores || !boxes || scores.length % 2 !== 0 || boxes.length * 2 !== scores.length * 4) {
    throw new Error("人脸检测模型输出格式异常");
  }

  const candidates = [];
  for (let index = 0; index < scores.length / 2; index += 1) {
    const score = Number(scores[index * 2 + 1]);
    if (!Number.isFinite(score) || score < REVIEW_THRESHOLD) continue;
    const x1 = clamp(Number(boxes[index * 4]), 0, 1);
    const y1 = clamp(Number(boxes[index * 4 + 1]), 0, 1);
    const x2 = clamp(Number(boxes[index * 4 + 2]), 0, 1);
    const y2 = clamp(Number(boxes[index * 4 + 3]), 0, 1);
    if (x2 <= x1 || y2 <= y1) continue;
    candidates.push({ x1, y1, x2, y2, score });
  }

  const detections = nonMaximumSuppression(candidates).slice(0, 20).map((item) => ({
    score: Number(item.score.toFixed(4)),
    x: Math.round(item.x1 * originalWidth),
    y: Math.round(item.y1 * originalHeight),
    width: Math.max(1, Math.round((item.x2 - item.x1) * originalWidth)),
    height: Math.max(1, Math.round((item.y2 - item.y1) * originalHeight)),
  }));
  const strong = detections.filter((item) => item.score >= FACE_THRESHOLD);
  const status = strong.length > 0 ? "face_detected" : detections.length > 0 ? "review_required" : "clear";

  console.log(JSON.stringify({
    ok: true,
    status,
    detectorRevision: DETECTOR_REVISION,
    faceCount: strong.length,
    maxScore: detections[0]?.score ?? 0,
    detections,
  }));
  await session.release();
}

main().catch((error) => {
  console.log(JSON.stringify({
    ok: false,
    status: "review_required",
    detectorRevision: DETECTOR_REVISION,
    error: error instanceof Error ? error.message : String(error),
  }));
  process.exit(1);
});
