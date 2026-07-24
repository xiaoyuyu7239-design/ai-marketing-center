/**
 * 发布前诊断（数据飞轮的"预测"环，第一期形态）：发布前按维度给脚本打"内容诊断分"，
 * 并结合该商家自己的历史回流数据做**相对预测**（高于/持平/低于账号平均）。
 * 刻意不预测绝对播放量——流量受账号权重/发布时机/平台流量池赛马影响，内容只解释一部分方差，
 * 绝对数字预测做不准且错了反噬产品信任；方向性判断 + 透明的依据说明才立得住。
 * 诊断分落库后与发布后回流的真实数据形成对照，攒够样本后可做校准升级。
 * 本模块保持纯函数、可单测；LLM 调用与 DB 读写在外层 route。
 */

import type { DiagnosisDimension, Shot } from "@backend/db/schema";

/** 诊断维度 key（与 LLM 输出、规则兜底、UI 展示三方对齐的唯一口径） */
export const DIAGNOSIS_DIMENSION_KEYS = ["hook", "clarity", "pacing", "copy", "cta"] as const;
export type DiagnosisDimensionKey = (typeof DIAGNOSIS_DIMENSION_KEYS)[number];

/** 维度展示名（zh/en 跟随界面语言；UI 组件直接引用，避免两处维护） */
export const DIAGNOSIS_DIMENSION_LABELS: Record<DiagnosisDimensionKey, { zh: string; en: string }> = {
  hook: { zh: "开场钩子", en: "Hook" },
  clarity: { zh: "卖点清晰度", en: "Selling point" },
  pacing: { zh: "节奏时长", en: "Pacing" },
  copy: { zh: "文案可读性", en: "Copy" },
  cta: { zh: "行动号召", en: "Call to action" },
};

/** 解析/兜底后的诊断结果（尚未包含相对预测，预测由 buildRelativePrediction 单独产出） */
export interface ParsedDiagnosis {
  dimensions: DiagnosisDimension[];
  /** 0-100，各维度均值——总分统一由代码算，不信 LLM 自报的总分，保证口径一致 */
  overallScore: number;
  summary: string;
  suggestions: string[];
}

/** 相对预测结果：方向 + 置信度 + 人话依据 */
export interface RelativePrediction {
  /** null = 历史样本不足，不硬给方向（宁缺毋滥，别拿猜的当预测） */
  prediction: "above" | "average" | "below" | null;
  /** v1 封顶 medium：没做过"诊断分 vs 实际"校准前，不给 high 的虚假精确 */
  confidence: "low" | "medium";
  /** 依据说明，透明呈现给商家（样本数、账号播放基线） */
  basis: string;
  samples: number;
  medianViews: number;
}

export interface DiagnosisScriptInput {
  productName: string;
  category?: string;
  platform: string;
  title?: string;
  styleType?: string;
  totalDuration?: number;
  shots: Shot[];
  locale: "zh" | "en";
}

const clampScore = (v: unknown) => Math.min(100, Math.max(0, Math.round(Number(v) || 0)));

const cleanText = (v: unknown, maxLen: number) => (typeof v === "string" ? v.trim().slice(0, maxLen) : "");

/**
 * 构建诊断的 user prompt：把脚本压成 LLM 好评审的结构。
 * 只送必要字段（voiceover/description/textOverlay），不送 prompt 等生图内部字段省 token。
 */
export function buildDiagnosisPrompt(input: DiagnosisScriptInput): string {
  const shots = input.shots.map((shot) => ({
    type: shot.type,
    duration: shot.duration,
    description: cleanText(shot.description, 120),
    voiceover: cleanText(shot.voiceover, 200),
    ...(shot.textOverlay?.text ? { textOverlay: cleanText(shot.textOverlay.text, 60) } : {}),
  }));
  const lines = [
    input.locale === "en"
      ? "Review the following short-video script before publishing. Score every dimension (hook/clarity/pacing/copy/cta), respond in English."
      : "请对以下即将发布的带货短视频脚本做发布前诊断。五个维度（hook/clarity/pacing/copy/cta）每个都必须打分，用中文输出。",
    `平台/platform: ${input.platform}`,
    `商品/product: ${input.productName}${input.category ? `（${input.category}）` : ""}`,
    ...(input.title ? [`标题/title: ${cleanText(input.title, 80)}`] : []),
    ...(input.styleType ? [`脚本风格/style: ${input.styleType}`] : []),
    ...(input.totalDuration ? [`总时长/duration: ${input.totalDuration}s`] : []),
    `分镜/shots: ${JSON.stringify(shots)}`,
  ];
  return lines.join("\n");
}

/**
 * 解析 LLM 返回的诊断 JSON：过滤未知维度、分数夹到 0-100、限制建议条数。
 * 有效维度不足 3 个视为不可用，返回 null 让调用方走规则兜底——半份结果比没有更误导。
 */
export function parseDiagnosisResponse(raw: unknown): ParsedDiagnosis | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as { dimensions?: unknown; summary?: unknown; suggestions?: unknown };
  if (!Array.isArray(value.dimensions)) return null;

  const seen = new Set<string>();
  const dimensions: DiagnosisDimension[] = [];
  for (const item of value.dimensions) {
    if (!item || typeof item !== "object") continue;
    const key = String((item as { key?: unknown }).key ?? "");
    if (!(DIAGNOSIS_DIMENSION_KEYS as readonly string[]).includes(key) || seen.has(key)) continue;
    seen.add(key);
    dimensions.push({
      key,
      score: clampScore((item as { score?: unknown }).score),
      comment: cleanText((item as { comment?: unknown }).comment, 120),
    });
  }
  if (dimensions.length < 3) return null;

  const suggestions = Array.isArray(value.suggestions)
    ? value.suggestions.map((s) => cleanText(s, 60)).filter(Boolean).slice(0, 5)
    : [];
  return {
    dimensions,
    overallScore: computeOverallScore(dimensions),
    summary: cleanText(value.summary, 120),
    suggestions,
  };
}

/** 总分 = 各维度均值（四舍五入）；统一由代码算，别处不要另起口径 */
export function computeOverallScore(dimensions: DiagnosisDimension[]): number {
  if (!dimensions.length) return 0;
  return Math.round(dimensions.reduce((a, d) => a + clampScore(d.score), 0) / dimensions.length);
}

/** 规则兜底的双语评语文案 */
const RULE_TEXT = {
  hookOk: { zh: "开场是钩子分镜且有口播，具备留人基础", en: "Opens with a voiced hook shot" },
  hookWeak: { zh: "开场不是钩子分镜或没有口播，前3秒难留人", en: "No hook shot / voiceover at the start" },
  clarityOk: { zh: "有商品展示与演示分镜，卖点有承载", en: "Has product reveal and demo shots" },
  clarityWeak: { zh: "缺商品展示或演示分镜，看完记不住为什么买", en: "Missing product reveal or demo shots" },
  pacingOk: { zh: "总时长在 15-45 秒的带货舒适区", en: "Duration within the 15-45s sweet spot" },
  pacingWeak: { zh: "总时长偏离 15-45 秒舒适区，完播承压", en: "Duration outside the 15-45s sweet spot" },
  copyOk: { zh: "单镜口播长度适中，字幕不挤", en: "Per-shot voiceover length is comfortable" },
  copyWeak: { zh: "有分镜口播过长，语速和字幕都会吃力", en: "Some voiceovers are too long per shot" },
  ctaOk: { zh: "结尾有明确行动号召", en: "Has a clear closing CTA" },
  ctaWeak: { zh: "缺少行动号召分镜，观众不知道下一步", en: "No CTA shot at the end" },
  summary: { zh: "本地规则快检结果（AI 诊断暂不可用），建议按低分项修改", en: "Local rule-based check (AI unavailable); fix the low-scoring items" },
} as const;

/**
 * 规则兜底诊断：LLM 不可用（未配置/超时/返回不可解析）时的本地确定性快检。
 * 只检查脚本结构层面可判定的事实（有没有钩子/CTA、时长、口播长度），不装懂内容好坏。
 */
export function buildRuleDiagnosis(input: { shots: Shot[]; totalDuration?: number; locale: "zh" | "en" }): ParsedDiagnosis {
  const { shots, locale } = input;
  const t = (pair: { zh: string; en: string }) => pair[locale];
  const first = shots[0];
  const duration = input.totalDuration || shots.reduce((a, s) => a + (s.duration || 0), 0);

  const hookOk = Boolean(first && first.type === "hook" && cleanText(first.voiceover, 200));
  const clarityOk =
    shots.some((s) => s.type === "product_reveal") && shots.some((s) => s.type === "demo");
  const pacingOk = duration >= 15 && duration <= 45;
  // 单镜口播超过 ~40 字，口播语速和字幕换行都会吃力（抖音竖屏字幕一屏约 15 字内舒适）
  const copyOk = shots.every((s) => cleanText(s.voiceover, 999).length <= 40);
  const ctaOk = shots.some((s) => s.type === "cta" && cleanText(s.voiceover, 200));

  const dim = (key: DiagnosisDimensionKey, ok: boolean, okText: { zh: string; en: string }, weakText: { zh: string; en: string }): DiagnosisDimension => ({
    key,
    score: ok ? 75 : 45,
    comment: t(ok ? okText : weakText),
  });

  const dimensions = [
    dim("hook", hookOk, RULE_TEXT.hookOk, RULE_TEXT.hookWeak),
    dim("clarity", clarityOk, RULE_TEXT.clarityOk, RULE_TEXT.clarityWeak),
    dim("pacing", pacingOk, RULE_TEXT.pacingOk, RULE_TEXT.pacingWeak),
    dim("copy", copyOk, RULE_TEXT.copyOk, RULE_TEXT.copyWeak),
    dim("cta", ctaOk, RULE_TEXT.ctaOk, RULE_TEXT.ctaWeak),
  ];
  return {
    dimensions,
    overallScore: computeOverallScore(dimensions),
    summary: t(RULE_TEXT.summary),
    suggestions: dimensions.filter((d) => d.score < 60).map((d) => d.comment),
  };
}

/** 相对预测的样本门槛：不到 3 条真实回流数据就不给方向，避免拿猜的当预测 */
export const PREDICTION_MIN_SAMPLES = 3;
/** 到这个样本量置信度才升到 medium（v1 封顶 medium，校准前不给 high） */
export const PREDICTION_MEDIUM_SAMPLES = 8;

function median(sorted: number[]): number {
  if (!sorted.length) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

/**
 * 相对预测：诊断分给方向（≥75 高于 / ≥55 持平 / <55 低于），账号历史播放中位数给基线。
 * 这是冷启动期的诚实规则版；攒够"诊断分 vs 实际表现"对照样本后再升级成校准过的模型。
 */
export function buildRelativePrediction(
  overallScore: number,
  viewsHistory: number[],
  locale: "zh" | "en"
): RelativePrediction {
  const views = viewsHistory.filter((v) => Number.isFinite(v) && v > 0).sort((a, b) => a - b);
  const samples = views.length;
  const medianViews = median(views);

  if (samples < PREDICTION_MIN_SAMPLES) {
    return {
      prediction: null,
      confidence: "low",
      basis:
        locale === "en"
          ? `Only ${samples} published data point(s) logged — publish a few videos and log their numbers to unlock the relative forecast.`
          : `你回填过的真实数据还只有 ${samples} 条，暂时不给预测；多发几条、回来把数据填上，这里就会亮起来。`,
      samples,
      medianViews,
    };
  }

  const prediction = overallScore >= 75 ? "above" : overallScore >= 55 ? "average" : "below";
  const confidence = samples >= PREDICTION_MEDIUM_SAMPLES ? "medium" : "low";
  return {
    prediction,
    confidence,
    basis:
      locale === "en"
        ? `Directional call from the diagnosis score vs. your own ${samples} logged video(s) (typical views ≈ ${medianViews}). Not an absolute view-count prediction.`
        : `参考你已经发过的 ${samples} 条视频（一般一条播放约 ${medianViews}），按这条的体检分估个方向，不猜具体播放量。`,
    samples,
    medianViews,
  };
}
