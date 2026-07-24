#!/usr/bin/env node
/**
 * 商品图抠图 + 合成（本地免费，零 API）。
 * 用法：node matte.mjs <输入图> <输出图> [背景hex，默认 #ECEAE6]
 *
 * 相比"图生图重绘"：商品像素零改动（抠出来贴上去），彻底消除泛白/脑补 logo；
 * 只换背景 + 合成一圈真实的柔和接触阴影。
 */
import { removeBackground } from "@imgly/background-removal-node";
import sharp from "sharp";
import { readFile } from "node:fs/promises";

const [, , inPath, outPath, bgHexArg] = process.argv;
if (!inPath || !outPath) {
  console.error("usage: node matte.mjs <input> <output> [bgHex]");
  process.exit(2);
}
const bgHex = bgHexArg || "#ECEAE6"; // 浅暖灰，比纯白略深，避免商品和背景糊在一起

// 画布：竖版电商主图比例
const CANVAS_W = 1024;
const CANVAS_H = 1365;
const MARGIN = 0.16; // 商品四周留白比例

function hexToRgb(hex) {
  const h = hex.replace("#", "");
  return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
}

async function main() {
  // 1) 抠图：medium 通用模型，输出带 alpha 的 PNG（首次运行会下载模型到本地缓存，之后离线）。
  // 先用 sharp 归一成标准 PNG（去掉 HEIC/EXIF 旋转等），再交给抠图，避免"Unsupported format"。
  const normalizedPng = await sharp(await readFile(inPath)).rotate().png().toBuffer();
  const inputBlob = new Blob([normalizedPng], { type: "image/png" }); // 带 MIME 类型，抠图库才能识别格式
  const blob = await removeBackground(inputBlob, { model: "medium" });
  const cutoutPng = Buffer.from(await blob.arrayBuffer());

  // 2) 裁到商品实际边界（去掉抠图后四周的透明空白），再按留白缩放到画布内
  const trimmed = await sharp(cutoutPng).trim({ threshold: 10 }).toBuffer();
  const meta = await sharp(trimmed).metadata();
  const maxW = Math.round(CANVAS_W * (1 - MARGIN * 2));
  const maxH = Math.round(CANVAS_H * (1 - MARGIN * 2));
  const scale = Math.min(maxW / meta.width, maxH / meta.height);
  const drawW = Math.max(1, Math.round(meta.width * scale));
  const drawH = Math.max(1, Math.round(meta.height * scale));
  const product = await sharp(trimmed).resize(drawW, drawH, { fit: "fill" }).png().toBuffer();

  // 商品居中、略偏下（给顶部呼吸、底部接触阴影留空间）
  const left = Math.round((CANVAS_W - drawW) / 2);
  const top = Math.round((CANVAS_H - drawH) / 2 + CANVAS_H * 0.03);

  // 3) 接触阴影：商品底部一枚柔和的椭圆地面投影（SVG 高斯模糊椭圆，比死黑方块自然）
  const ellRx = Math.round(drawW * 0.42);
  const ellRy = Math.max(8, Math.round(drawH * 0.035));
  const ellCx = CANVAS_W / 2;
  const ellCy = top + drawH - ellRy * 0.3; // 贴着商品底边
  const blurPx = Math.max(6, Math.round(drawW * 0.04));
  const shadowSvg = Buffer.from(
    `<svg width="${CANVAS_W}" height="${CANVAS_H}" xmlns="http://www.w3.org/2000/svg">
      <defs><filter id="b" x="-50%" y="-50%" width="200%" height="200%">
        <feGaussianBlur stdDeviation="${blurPx}"/></filter></defs>
      <ellipse cx="${ellCx}" cy="${ellCy}" rx="${ellRx}" ry="${ellRy}" fill="black" fill-opacity="0.22" filter="url(#b)"/>
    </svg>`
  );

  // 4) 背景（纯色）→ 阴影 → 商品
  const bg = hexToRgb(bgHex);
  const composed = await sharp({
    create: { width: CANVAS_W, height: CANVAS_H, channels: 3, background: bg },
  })
    .composite([
      { input: shadowSvg, top: 0, left: 0 },
      { input: product, left, top },
    ])
    .jpeg({ quality: 92 })
    .toBuffer();

  await sharp(composed).toFile(outPath);
  console.log(JSON.stringify({ ok: true, out: outPath, w: CANVAS_W, h: CANVAS_H }));
}

main().catch((e) => {
  console.error(JSON.stringify({ ok: false, error: String(e && e.message || e) }));
  process.exit(1);
});
