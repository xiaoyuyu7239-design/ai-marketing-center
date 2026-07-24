/**
 * 单条视频复盘（数据飞轮的"总结分析"环）：回流数据到位后，结合"当时的诊断分 + 实际表现 +
 * 账号自己的基线"总结这条视频哪里好、哪里差、下条怎么改。
 * 两个原则：
 * 1. 实际表现的方向判断（above/average/below）由代码按账号基线算，不让 LLM 报数——口径要稳定可复现；
 * 2. 结论定位"待验证假设"：单条视频的偶然不能当规律，样本不足时明说，不硬下结论。
 * 本模块保持纯函数、可单测；LLM 调用与 DB 在外层 route。
 */

import type { DiagnosisDimension } from "@backend/db/schema";
import { DIAGNOSIS_DIMENSION_LABELS, type DiagnosisDimensionKey } from "./content-diagnosis";

/** 复盘用的单条实际数据快照（取该项目最新一条回流记录） */
export interface RetroMetricsSnapshot {
  views: number;
  likes: number;
  comments: number;
  shares: number;
  orders: number;
}

/** LLM/规则产出的复盘正文 */
export interface ParsedRetro {
  /** 这条做对了什么（≤3 条） */
  highlights: string[];
  /** 哪里拖了后腿（≤3 条） */
  issues: string[];
  /** 下条试试（待验证假设，≤3 条） */
  nextActions: string[];
  /** 一句话总结 */
  summary: string;
}

/** 实际表现 vs 账号基线的方向判定 */
export interface ActualVerdict {
  /** null = 账号其他视频的数据太少，无从对比 */
  actual: "above" | "average" | "below" | null;
  /** 判定依据（大白话，直接展示给商家） */
  basis: string;
  /** 账号基线：其他视频播放中位数 */
  baselineViews: number;
  /** 参与对比的其他视频数据条数 */
  samples: number;
}

/** 与账号基线对比的样本门槛：其他视频不足 2 条就不下方向结论 */
export const ACTUAL_MIN_SAMPLES = 2;
/** 高于/低于基线的判定倍率：±20% 以内算"和平时差不多"，避免把正常波动说成好坏 */
export const ACTUAL_ABOVE_RATIO = 1.2;
export const ACTUAL_BELOW_RATIO = 0.8;

const cleanText = (v: unknown, maxLen: number) => (typeof v === "string" ? v.trim().slice(0, maxLen) : "");
const cleanList = (v: unknown, maxItems: number, maxLen: number) =>
  Array.isArray(v) ? v.map((item) => cleanText(item, maxLen)).filter(Boolean).slice(0, maxItems) : [];

function median(sorted: number[]): number {
  if (!sorted.length) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

/**
 * 实际表现方向判定：这条视频的播放 vs 账号其他视频的播放中位数。
 * 用"其他视频"做基线（不含这条自己的回流记录），避免自己跟自己比永远"持平"。
 */
export function computeActualVerdict(projectViews: number, otherViews: number[], locale: "zh" | "en"): ActualVerdict {
  const views = otherViews.filter((v) => Number.isFinite(v) && v > 0).sort((a, b) => a - b);
  const samples = views.length;
  const baselineViews = median(views);

  if (samples < ACTUAL_MIN_SAMPLES) {
    return {
      actual: null,
      basis:
        locale === "en"
          ? `Not enough data from your other videos (${samples} logged) to compare against yet.`
          : `你其他视频回填的数据还只有 ${samples} 条，暂时没法比出这条算好还是差。`,
      baselineViews,
      samples,
    };
  }

  const ratio = baselineViews > 0 ? projectViews / baselineViews : 0;
  const actual = ratio >= ACTUAL_ABOVE_RATIO ? "above" : ratio <= ACTUAL_BELOW_RATIO ? "below" : "average";
  return {
    actual,
    basis:
      locale === "en"
        ? `This video: ${projectViews} views; your usual video: about ${baselineViews} (based on ${samples} other logged videos).`
        : `这条播放 ${projectViews}，你平时一条大约 ${baselineViews}（按另外 ${samples} 条已回填的算）。`,
    baselineViews,
    samples,
  };
}

export interface RetroPromptInput {
  productName: string;
  styleType?: string;
  platform: string;
  title?: string;
  metrics: RetroMetricsSnapshot;
  verdict: ActualVerdict;
  /** 当时的发布前诊断（可空：老板可能没做过诊断） */
  diagnosis?: {
    overallScore: number;
    prediction: "above" | "average" | "below" | null;
    dimensions: DiagnosisDimension[];
  } | null;
  locale: "zh" | "en";
}

const DIRECTION_TEXT: Record<"above" | "average" | "below", { zh: string; en: string }> = {
  above: { zh: "高于平时", en: "above usual" },
  average: { zh: "和平时差不多", en: "around usual" },
  below: { zh: "低于平时", en: "below usual" },
};

/** 构建复盘的 user prompt：实际数据 + 账号基线 + 当时的体检结论一起给，让 LLM 有据可依 */
export function buildRetroPrompt(input: RetroPromptInput): string {
  const { metrics, verdict, diagnosis } = input;
  const lines = [
    input.locale === "en"
      ? "This short video has been published and its real numbers are in. Write the retro in English."
      : "这条带货短视频已发布并回填了真实数据，请帮店主复盘，用中文输出。",
    `商品/product: ${input.productName}`,
    `平台/platform: ${input.platform}`,
    ...(input.title ? [`标题/title: ${cleanText(input.title, 80)}`] : []),
    ...(input.styleType ? [`脚本风格/style: ${input.styleType}`] : []),
    `实际数据/metrics: ${JSON.stringify(metrics)}`,
    `与账号平时水平对比/vs-baseline: ${verdict.actual ? DIRECTION_TEXT[verdict.actual].zh : "样本不足无从对比"}（${verdict.basis}）`,
  ];
  if (diagnosis) {
    const dims = diagnosis.dimensions.map((d) => ({ key: d.key, score: d.score, comment: cleanText(d.comment, 60) }));
    lines.push(
      `发布前体检/diagnosis: 总分 ${diagnosis.overallScore}，当时预测${diagnosis.prediction ? `「${DIRECTION_TEXT[diagnosis.prediction].zh}」` : "（当时样本不足未预测）"}，各维度 ${JSON.stringify(dims)}`
    );
  } else {
    lines.push("发布前体检/diagnosis: 这条没做过发布前诊断");
  }
  return lines.join("\n");
}

/** 解析 LLM 复盘 JSON：各列表限 3 条、每条 60 字；全空视为不可用返回 null（走规则兜底） */
export function parseRetroResponse(raw: unknown): ParsedRetro | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const result: ParsedRetro = {
    highlights: cleanList(value.highlights, 3, 60),
    issues: cleanList(value.issues, 3, 60),
    nextActions: cleanList(value.nextActions, 3, 60),
    summary: cleanText(value.summary, 120),
  };
  if (!result.summary && !result.highlights.length && !result.issues.length && !result.nextActions.length) return null;
  return result;
}

/** 规则兜底的双语文案 */
const RULE_SUMMARY: Record<"above" | "average" | "below" | "none", { zh: string; en: string }> = {
  above: { zh: "这条比你平时的视频表现好，值得照这个拍法再来几条。", en: "This one beat your usual numbers — worth repeating the approach." },
  average: { zh: "这条和你平时的视频表现差不多，稳中求进。", en: "About your usual level — steady, keep iterating." },
  below: { zh: "这条比你平时的视频弱一些，参考下面几条改进再试。", en: "Below your usual level — try the fixes below next time." },
  none: { zh: "账号回填的数据还少，先多发几条、把数据填上，复盘会越来越准。", en: "Too little logged data yet — publish and log more, retros will sharpen." },
};

const dimLabel = (key: string, locale: "zh" | "en") =>
  DIAGNOSIS_DIMENSION_LABELS[key as DiagnosisDimensionKey]?.[locale] ?? key;

/**
 * 规则兜底复盘：LLM 不可用时的本地版本。方向结论来自 verdict（代码算的，可靠），
 * 亮点/问题借用当时诊断的高低分维度；没做过诊断就只给方向结论，不硬编内容评价。
 */
export function buildRuleRetro(input: {
  verdict: ActualVerdict;
  diagnosisDimensions?: DiagnosisDimension[] | null;
  locale: "zh" | "en";
}): ParsedRetro {
  const { verdict, locale } = input;
  const dims = input.diagnosisDimensions ?? [];
  const strong = dims.filter((d) => d.score >= 75).slice(0, 2);
  const weak = dims.filter((d) => d.score < 55).slice(0, 2);
  const t = (pair: { zh: string; en: string }) => pair[locale];

  return {
    highlights: strong.map((d) =>
      locale === "en" ? `"${dimLabel(d.key, locale)}" was already solid pre-publish` : `「${dimLabel(d.key, locale)}」发布前体检就不错`
    ),
    issues: weak.map((d) => d.comment || (locale === "en" ? `"${dimLabel(d.key, locale)}" scored low` : `「${dimLabel(d.key, locale)}」当时分数偏低`)),
    nextActions: weak.map((d) =>
      locale === "en" ? `Next video: tighten up "${dimLabel(d.key, locale)}"` : `下条把「${dimLabel(d.key, locale)}」再做扎实些`
    ),
    summary: t(RULE_SUMMARY[verdict.actual ?? "none"]),
  };
}

/**
 * 从复盘里挑出要写进店铺记忆的经验（下次生成脚本自动带上）：
 * 优先"下条试试"，最多 2 条——记忆是滚动的稀缺位，别一次灌满。
 */
export function pickRetroMemoryNotes(retro: ParsedRetro): string[] {
  return retro.nextActions.slice(0, 2);
}
