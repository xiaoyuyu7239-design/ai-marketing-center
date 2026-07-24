import { describe, expect, it } from "vitest";
import {
  DIAGNOSIS_DIMENSION_KEYS,
  buildDiagnosisPrompt,
  buildRelativePrediction,
  buildRuleDiagnosis,
  computeOverallScore,
  parseDiagnosisResponse,
} from "@backend/core/publish/content-diagnosis";
import type { Shot } from "@backend/db/schema";

const shot = (partial: Partial<Shot>): Shot => ({
  shotId: 1,
  type: "hook",
  duration: 3,
  description: "画面",
  camera: "推近",
  visualSource: "product_image",
  transition: "direct_concat",
  voiceover: "口播",
  ...partial,
});

/** 结构完整的"好脚本"：钩子开场 + 商品展示 + 演示 + CTA，总时长 30s，口播不超长 */
const goodShots: Shot[] = [
  shot({ shotId: 1, type: "hook", duration: 3, voiceover: "还在为厨房油污发愁？" }),
  shot({ shotId: 2, type: "product_reveal", duration: 8, voiceover: "这瓶清洁剂喷一下" }),
  shot({ shotId: 3, type: "demo", duration: 12, voiceover: "重油污一擦就掉" }),
  shot({ shotId: 4, type: "cta", duration: 7, voiceover: "点击下方小黄车带回家" }),
];

describe("发布前诊断：LLM 结果解析", () => {
  it("解析合法结果：夹分数、过滤未知维度与重复维度、限建议条数", () => {
    const parsed = parseDiagnosisResponse({
      dimensions: [
        { key: "hook", score: 120, comment: "钩子强" },
        { key: "hook", score: 60, comment: "重复维度应被忽略" },
        { key: "clarity", score: -5, comment: "太模糊" },
        { key: "pacing", score: 66.6, comment: "略拖" },
        { key: "nonsense", score: 99, comment: "未知维度应被忽略" },
      ],
      summary: "总体可发",
      suggestions: ["s1", "s2", "s3", "s4", "s5", "s6", ""],
    });
    expect(parsed).not.toBeNull();
    expect(parsed!.dimensions.map((d) => d.key)).toEqual(["hook", "clarity", "pacing"]);
    expect(parsed!.dimensions[0].score).toBe(100);
    expect(parsed!.dimensions[1].score).toBe(0);
    expect(parsed!.dimensions[2].score).toBe(67);
    expect(parsed!.suggestions).toHaveLength(5);
    expect(parsed!.overallScore).toBe(computeOverallScore(parsed!.dimensions));
  });

  it("有效维度不足 3 个 / 非对象输入 → null（走规则兜底）", () => {
    expect(parseDiagnosisResponse({ dimensions: [{ key: "hook", score: 80 }] })).toBeNull();
    expect(parseDiagnosisResponse(null)).toBeNull();
    expect(parseDiagnosisResponse("{}")).toBeNull();
    expect(parseDiagnosisResponse({ summary: "没有维度" })).toBeNull();
  });
});

describe("发布前诊断：规则兜底", () => {
  it("结构完整的脚本各维度 75 分、无改进建议", () => {
    const result = buildRuleDiagnosis({ shots: goodShots, totalDuration: 30, locale: "zh" });
    expect(result.dimensions).toHaveLength(DIAGNOSIS_DIMENSION_KEYS.length);
    expect(result.dimensions.every((d) => d.score === 75)).toBe(true);
    expect(result.overallScore).toBe(75);
    expect(result.suggestions).toHaveLength(0);
  });

  it("缺钩子/缺CTA/超长口播/时长越界 → 对应维度低分并生成建议", () => {
    const badShots: Shot[] = [
      shot({ shotId: 1, type: "demo", duration: 50, voiceover: "这一段口播实在是太长了".repeat(5) }),
      shot({ shotId: 2, type: "social_proof", duration: 20, voiceover: "大家都说好" }),
    ];
    const result = buildRuleDiagnosis({ shots: badShots, locale: "zh" });
    const byKey = Object.fromEntries(result.dimensions.map((d) => [d.key, d.score]));
    expect(byKey.hook).toBe(45); // 开场不是钩子分镜
    expect(byKey.clarity).toBe(45); // 有 demo 但缺 product_reveal
    expect(byKey.pacing).toBe(45); // 70s 超出 15-45s 舒适区
    expect(byKey.copy).toBe(45); // 首镜口播超长
    expect(byKey.cta).toBe(45); // 无 CTA 分镜
    expect(result.suggestions.length).toBeGreaterThan(0);
  });
});

describe("发布前诊断：相对预测（只给方向不给绝对播放量）", () => {
  it("历史样本不足 3 条 → 不给方向，说明依据", () => {
    const r = buildRelativePrediction(90, [1000, 2000], "zh");
    expect(r.prediction).toBeNull();
    expect(r.confidence).toBe("low");
    expect(r.basis).toContain("2 条");
  });

  it("分数阈值映射方向：≥75 高于 / ≥55 持平 / <55 低于", () => {
    const views = [100, 200, 300, 400, 500];
    expect(buildRelativePrediction(80, views, "zh").prediction).toBe("above");
    expect(buildRelativePrediction(60, views, "zh").prediction).toBe("average");
    expect(buildRelativePrediction(40, views, "zh").prediction).toBe("below");
  });

  it("样本 ≥8 条置信度升为 medium，依据里含样本数与播放中位数", () => {
    const few = buildRelativePrediction(80, [100, 200, 300], "zh");
    expect(few.confidence).toBe("low");
    const many = buildRelativePrediction(80, [10, 20, 30, 40, 50, 60, 70, 80], "zh");
    expect(many.confidence).toBe("medium");
    expect(many.samples).toBe(8);
    expect(many.medianViews).toBe(45);
    expect(many.basis).toContain("8 条");
    expect(many.basis).toContain("45");
  });

  it("无效播放数（0/负数）不计入样本", () => {
    const r = buildRelativePrediction(80, [0, -5, 100], "zh");
    expect(r.samples).toBe(1);
    expect(r.prediction).toBeNull();
  });
});

describe("发布前诊断：prompt 构建", () => {
  it("包含商品名、平台、口播内容，不包含生图 prompt 等内部字段", () => {
    const prompt = buildDiagnosisPrompt({
      productName: "厨房清洁剂",
      category: "home",
      platform: "douyin",
      title: "油污一擦就掉",
      styleType: "scene",
      totalDuration: 30,
      shots: [shot({ voiceover: "还在为厨房油污发愁？", prompt: "内部生图prompt不应出现" })],
      locale: "zh",
    });
    expect(prompt).toContain("厨房清洁剂");
    expect(prompt).toContain("douyin");
    expect(prompt).toContain("还在为厨房油污发愁？");
    expect(prompt).not.toContain("内部生图prompt不应出现");
  });
});
