import { describe, expect, it } from "vitest";
import {
  buildRetroPrompt,
  buildRuleRetro,
  computeActualVerdict,
  parseRetroResponse,
  pickRetroMemoryNotes,
} from "@backend/core/publish/video-retro";
import { defaultStoreMemory, learnFromReview, buildStoreMemoryHint } from "@backend/core/memory/store-memory";
import type { DiagnosisDimension } from "@backend/db/schema";

describe("复盘：实际表现 vs 账号基线", () => {
  it("其他视频样本不足 2 条 → 不下方向结论", () => {
    const v = computeActualVerdict(5000, [1000], "zh");
    expect(v.actual).toBeNull();
    expect(v.basis).toContain("1 条");
  });

  it("±20% 判定：≥1.2 倍算好，≤0.8 倍算弱，中间算差不多", () => {
    const others = [900, 1000, 1100]; // 中位数 1000
    expect(computeActualVerdict(1200, others, "zh").actual).toBe("above");
    expect(computeActualVerdict(1000, others, "zh").actual).toBe("average");
    expect(computeActualVerdict(800, others, "zh").actual).toBe("below");
  });

  it("依据说明含双方数字，是给老板看的大白话", () => {
    const v = computeActualVerdict(3000, [900, 1000, 1100], "zh");
    expect(v.basis).toContain("3000");
    expect(v.basis).toContain("1000");
    expect(v.basis).toContain("3 条");
  });

  it("无效播放数（0/负数）不计入基线", () => {
    const v = computeActualVerdict(100, [0, -1, 500], "zh");
    expect(v.samples).toBe(1);
    expect(v.actual).toBeNull();
  });
});

describe("复盘：LLM 结果解析", () => {
  it("列表限 3 条、超长截断、空项过滤", () => {
    const parsed = parseRetroResponse({
      highlights: ["a", "b", "c", "d"],
      issues: ["", "x".repeat(100)],
      nextActions: ["下条开头直接上成品图"],
      summary: "总体不错",
    });
    expect(parsed!.highlights).toHaveLength(3);
    expect(parsed!.issues).toEqual(["x".repeat(60)]);
    expect(parsed!.nextActions).toEqual(["下条开头直接上成品图"]);
  });

  it("全空/非对象 → null（走规则兜底）", () => {
    expect(parseRetroResponse({ highlights: [], issues: [], nextActions: [], summary: "" })).toBeNull();
    expect(parseRetroResponse(null)).toBeNull();
    expect(parseRetroResponse("text")).toBeNull();
  });
});

describe("复盘：规则兜底", () => {
  const dims: DiagnosisDimension[] = [
    { key: "hook", score: 80, comment: "开场钩子不错" },
    { key: "cta", score: 45, comment: "结尾没说清下一步" },
  ];

  it("方向结论来自 verdict，亮点/问题借用当时诊断的高低分维度", () => {
    const retro = buildRuleRetro({
      verdict: { actual: "above", basis: "", baselineViews: 1000, samples: 3 },
      diagnosisDimensions: dims,
      locale: "zh",
    });
    expect(retro.summary).toContain("比你平时的视频表现好");
    expect(retro.highlights[0]).toContain("开场钩子");
    expect(retro.issues[0]).toContain("结尾没说清下一步");
    expect(retro.nextActions[0]).toContain("行动号召");
  });

  it("没做过诊断 → 只给方向结论，不硬编内容评价", () => {
    const retro = buildRuleRetro({
      verdict: { actual: null, basis: "", baselineViews: 0, samples: 0 },
      diagnosisDimensions: null,
      locale: "zh",
    });
    expect(retro.highlights).toHaveLength(0);
    expect(retro.issues).toHaveLength(0);
    expect(retro.summary).toContain("先多发几条");
  });
});

describe("复盘：prompt 构建与记忆沉淀", () => {
  it("prompt 含实际数据、基线对比与当时体检；无诊断时明说", () => {
    const verdict = computeActualVerdict(3000, [900, 1000, 1100], "zh");
    const withDiag = buildRetroPrompt({
      productName: "厨房清洁剂",
      platform: "douyin",
      metrics: { views: 3000, likes: 200, comments: 10, shares: 5, orders: 2 },
      verdict,
      diagnosis: { overallScore: 75, prediction: "above", dimensions: [{ key: "hook", score: 80, comment: "不错" }] },
      locale: "zh",
    });
    expect(withDiag).toContain("厨房清洁剂");
    expect(withDiag).toContain("3000");
    expect(withDiag).toContain("总分 75");
    const noDiag = buildRetroPrompt({
      productName: "厨房清洁剂",
      platform: "douyin",
      metrics: { views: 3000, likes: 0, comments: 0, shares: 0, orders: 0 },
      verdict,
      diagnosis: null,
      locale: "zh",
    });
    expect(noDiag).toContain("没做过发布前诊断");
  });

  it("nextActions 前 2 条进店铺记忆，注入生成提示；新经验排前、去重、滚动上限", () => {
    const notes = pickRetroMemoryNotes({
      highlights: [],
      issues: [],
      nextActions: ["开头直接上成品图", "结尾报价格再给购买指引", "第三条不该进记忆"],
      summary: "",
    });
    expect(notes).toEqual(["开头直接上成品图", "结尾报价格再给购买指引"]);

    let memory = learnFromReview(defaultStoreMemory(), notes);
    expect(memory.reviewNotes).toEqual(notes);
    // 重复经验去重，新经验排前
    memory = learnFromReview(memory, ["开头直接上成品图", "多拍使用过程"]);
    expect(memory.reviewNotes[0]).toBe("开头直接上成品图");
    expect(memory.reviewNotes).toContain("多拍使用过程");
    expect(new Set(memory.reviewNotes).size).toBe(memory.reviewNotes.length);

    const hint = buildStoreMemoryHint(memory);
    expect(hint).toContain("近期复盘得出的经验");
    expect(hint).toContain("开头直接上成品图");
  });

  it("reviewNotes 为空时提示不出现复盘行（老用户记忆兼容）", () => {
    expect(buildStoreMemoryHint(defaultStoreMemory())).toBe("");
  });
});
