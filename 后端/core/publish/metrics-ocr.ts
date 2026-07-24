/**
 * 截图 OCR 回填（数据飞轮第②环）：老板把抖音数据截图粘贴进来，视觉模型读出数字预填表单，
 * 老板核对后再保存——识别只做"预填"，最终提交必须经人工确认，OCR 认错数字不能直接进库。
 * 设计原因：数据回流是飞轮最薄弱的一环（商家忙、手填依从性低），把回填摩擦降到 10 秒粘贴一下。
 * 本模块只做纯解析（LLM 返回 → 规范化数字），可单测；视觉调用与 DB 在外层 route。
 */

/** OCR 识别出的指标字段：null = 截图里没认出该字段（绝不编造 0） */
export interface MetricsOcrFields {
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  orders: number | null;
}

export interface MetricsOcrResult {
  fields: MetricsOcrFields;
  /** 识别出的平台（douyin/kuaishou/xiaohongshu/tiktok），认不出为 null */
  platform: string | null;
}

const KNOWN_PLATFORMS = new Set(["douyin", "kuaishou", "xiaohongshu", "tiktok"]);

/**
 * 把平台数据截图里的中文计数写法转成数字：
 * "1.2万"→12000、"3456"→3456、"1,234"→1234、"2.3w"→23000、"1.5k"→1500、"1亿"→100000000。
 * 认不出（null/空串/非数字）返回 null——宁缺勿错，缺的字段让老板自己填。
 */
export function parseCnNumber(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
  }
  if (typeof value !== "string") return null;
  const text = value.trim().replace(/,/g, "");
  if (!text) return null;
  const match = text.match(/^(\d+(?:\.\d+)?)\s*(亿|万|w|W|k|K)?$/);
  if (!match) return null;
  const base = Number(match[1]);
  if (!Number.isFinite(base)) return null;
  const unit = match[2];
  const multiplier = unit === "亿" ? 100_000_000 : unit === "万" || unit === "w" || unit === "W" ? 10_000 : unit === "k" || unit === "K" ? 1_000 : 1;
  return Math.floor(base * multiplier);
}

/**
 * 解析视觉模型返回的识别 JSON。一个数字都没认出（含"不是数据截图"的情况）返回 null，
 * 让路由回复"换张更清楚的截图或手填"，而不是把一排 0 填进表单误导保存。
 */
export function parseMetricsOcrResponse(raw: unknown): MetricsOcrResult | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const fields: MetricsOcrFields = {
    views: parseCnNumber(value.views),
    likes: parseCnNumber(value.likes),
    comments: parseCnNumber(value.comments),
    shares: parseCnNumber(value.shares),
    orders: parseCnNumber(value.orders),
  };
  if (Object.values(fields).every((v) => v === null)) return null;

  const rawPlatform = typeof value.platform === "string" ? value.platform.trim().toLowerCase() : "";
  return {
    fields,
    platform: KNOWN_PLATFORMS.has(rawPlatform) ? rawPlatform : null,
  };
}

/** 允许的截图 data URL 前缀（只收图片；svg 有脚本注入面，不收） */
const IMAGE_DATA_URL = /^data:image\/(png|jpeg|jpg|webp);base64,/;
/** data URL 长度上限（约 9MB 原图的 base64），防止把整机截屏录像塞进来 */
export const MAX_IMAGE_DATA_URL_LENGTH = 12_000_000;

/** 校验前端传来的截图 data URL，不合规返回给老板看的大白话原因 */
export function validateImageDataUrl(image: unknown): { ok: true; image: string } | { ok: false; reason: string } {
  if (typeof image !== "string" || !image) return { ok: false, reason: "没收到截图，重新粘贴或上传一下" };
  if (!IMAGE_DATA_URL.test(image)) return { ok: false, reason: "只支持 png/jpg/webp 格式的图片" };
  if (image.length > MAX_IMAGE_DATA_URL_LENGTH) return { ok: false, reason: "图片太大了，换张小一点的截图" };
  return { ok: true, image };
}
