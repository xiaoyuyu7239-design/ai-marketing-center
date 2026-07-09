/**
 * 自带脚本导入 —— 把用户自己写好的整段文案/旁白切成分镜，直接进出片流水线（不经 AI 生成）。
 *
 * 让「我已经有稿子，只想让它变成视频」成立：按句切分 → 估算每镜时长 → 产出标准 Shot[]，
 * 之后照常自动配画面（或配本地自有素材）+ 配音 + 合成。纯函数、零依赖、可单测。
 * 注：时长是规划估算，最终成片仍按真实配音时长卡点；描述沿用原句，供自动配素材检索回退。
 */

import type { Shot } from "@backend/db/schema";

/** 句末标点（切镜主依据） */
const SENTENCE_DELIM = /[。！？!?\n]+/;
/** 次级标点（超长句再切） */
const SUBCLAUSE_DELIM = /[，,；;、]+/;
/** 单镜文案上限（超过则按次级标点拆，避免一镜旁白过长） */
const MAX_CHARS_PER_SHOT = 100;
/** 分镜数上限（防滥用/超长输入） */
const MAX_SHOTS = 40;

function hasCJK(s: string): boolean {
  return /[一-鿿぀-ヿ가-힣]/.test(s);
}

/** 估算一段文案的配音时长（秒）：中日韩约 5 字/秒、拉丁约 14 字/秒，夹在 2–15s */
export function estimateDurationSec(text: string): number {
  const cps = hasCJK(text) ? 5 : 14;
  return Math.min(15, Math.max(2, Math.round(text.length / cps)));
}

/** 把整段文案切成「每镜一句」的片段：先按句末标点，超长句再按次级标点合并切分，去空。 */
export function splitNarration(text: string): string[] {
  const sentences = (text || "")
    .split(SENTENCE_DELIM)
    .map((s) => s.trim())
    .filter(Boolean);

  const pieces: string[] = [];
  for (const sent of sentences) {
    if (sent.length <= MAX_CHARS_PER_SHOT) {
      pieces.push(sent);
      continue;
    }
    // 超长句：按次级标点累积到接近上限再切，单段仍超长就硬保留（极端情况）
    let buf = "";
    for (const sub of sent.split(SUBCLAUSE_DELIM).map((s) => s.trim()).filter(Boolean)) {
      if (buf && (buf.length + sub.length) > MAX_CHARS_PER_SHOT) {
        pieces.push(buf);
        buf = sub;
      } else {
        buf = buf ? `${buf}，${sub}` : sub;
      }
    }
    if (buf) pieces.push(buf);
  }
  return pieces.slice(0, MAX_SHOTS);
}

/**
 * 把用户脚本切成标准分镜数组：首镜 hook、末镜 cta、其余 demo；
 * visualSource 设 "ai_generate"（与主题成片一致，由自动配素材/本地素材填画面）。
 */
export function splitNarrationIntoShots(text: string): Shot[] {
  const pieces = splitNarration(text);
  const n = pieces.length;
  return pieces.map((p, i) => ({
    shotId: i + 1,
    type: i === 0 ? "hook" : i === n - 1 ? "cta" : "demo",
    duration: estimateDurationSec(p),
    description: p, // 沿用原句，供 shotQuery 在无 stockKeywords 时回退检索
    camera: "static",
    visualSource: "ai_generate",
    transition: "ffmpeg_fade",
    voiceover: p,
    stockKeywords: [],
  }));
}
