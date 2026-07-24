import { describe, expect, it } from "vitest";

import {
  INVITE_BETA_PROMOTION_THRESHOLDS,
  aggregatePromotionMetrics,
  evaluatePromotion,
  percentile95,
  resolveValuesAtPath,
  scoreGoldenOutput,
  scoreHumanMediaCase,
  validateRequiredShape,
  type GoldenTrialResult,
  type PromotionThresholds,
} from "@server/admin/evals/scoring";

const validPublishCopy = {
  titles: ["早上三分钟吃好", "燕麦杯通勤吃法", "赶时间的早餐"],
  hashtags: ["#轻食早餐", "#通勤早餐", "#燕麦吃法"],
  caption: "早上赶时间，加牛奶拌一拌就能带走。",
};

function trial(overrides: Partial<GoldenTrialResult> = {}): GoldenTrialResult {
  return {
    candidateKey: "provider/model@config-v1",
    caseId: "publish-copy.oat.zh.v1",
    runId: `run-${Math.random()}`,
    success: true,
    structurePassed: true,
    qualityScore: 90,
    latencyMs: 1_000,
    actualCostUsd: 0.01,
    ...overrides,
  };
}

describe("golden JSON scoring", () => {
  it("scores a contract-compliant structured response deterministically", () => {
    const result = scoreGoldenOutput("publish-copy.oat.zh.v1", JSON.stringify(validPublishCopy));
    expect(result.evaluator).toBe("automatic-json");
    if (result.evaluator !== "automatic-json") throw new Error("unexpected evaluator");
    expect(result.parsed).toBe(true);
    expect(result.structurePassed).toBe(true);
    expect(result.qualityScore).toBe(100);
    expect(result.criteria.every((item) => item.passed)).toBe(true);
  });

  it("requires strict JSON and gives malformed output no comfort score", () => {
    const fenced = scoreGoldenOutput(
      "publish-copy.oat.zh.v1",
      `\`\`\`json\n${JSON.stringify(validPublishCopy)}\n\`\`\``,
    );
    expect(fenced.evaluator).toBe("automatic-json");
    if (fenced.evaluator !== "automatic-json") throw new Error("unexpected evaluator");
    expect(fenced.parsed).toBe(false);
    expect(fenced.structurePassed).toBe(false);
    expect(fenced.qualityScore).toBe(0);

    const extraField = scoreGoldenOutput("publish-copy.oat.zh.v1", { ...validPublishCopy, explanation: "额外文字" });
    expect(extraField.evaluator).toBe("automatic-json");
    if (extraField.evaluator !== "automatic-json") throw new Error("unexpected evaluator");
    expect(extraField.structurePassed).toBe(false);
    expect(extraField.qualityScore).toBe(0);
    expect(extraField.issues.some((item) => item.code === "unknown-key")).toBe(true);
  });

  it("supports wildcard and last-item paths without executing model output", () => {
    const root = { shots: [{ type: "hook" }, { type: "cta" }] };
    expect(resolveValuesAtPath(root, "shots.*.type")).toEqual(["hook", "cta"]);
    expect(resolveValuesAtPath(root, "shots.-1.type")).toEqual(["cta"]);
  });

  it("validates union and numeric boundaries", () => {
    const shape = {
      type: "object" as const,
      required: {
        score: { type: "number" as const, integer: true, min: 0, max: 100 },
        note: { type: "union" as const, variants: [{ type: "null" as const }, { type: "string" as const, minLength: 1 }] },
      },
    };
    expect(validateRequiredShape({ score: 0, note: null }, shape)).toEqual([]);
    expect(validateRequiredShape({ score: 100, note: "ok" }, shape)).toEqual([]);
    expect(validateRequiredShape({ score: 100.5, note: "" }, shape).length).toBeGreaterThan(0);
    expect(validateRequiredShape({ score: 101, note: null }, shape).length).toBeGreaterThan(0);
  });
});

describe("media human scoring", () => {
  it("returns a human-review requirement instead of pretending media is chat JSON", () => {
    const pending = scoreGoldenOutput("image.product-still-life.v1", "https://example.invalid/image.png");
    expect(pending).toMatchObject({
      evaluator: "human-media",
      structurePassed: null,
      qualityScore: null,
      humanReviewRequired: true,
    });
  });

  it("computes weighted human scores only after every rubric item and artifact are valid", () => {
    const complete = scoreHumanMediaCase("image.product-still-life.v1", {
      mediaType: "image",
      artifactCount: 1,
      scores: { identity: 5, composition: 5, artifacts: 5, "prompt-fit": 5, safety: 5 },
    });
    expect(complete.reviewComplete).toBe(true);
    expect(complete.qualityScore).toBe(100);

    const incomplete = scoreHumanMediaCase("image.product-still-life.v1", {
      mediaType: "image",
      artifactCount: 1,
      scores: { identity: 5 },
    });
    expect(incomplete.reviewComplete).toBe(false);
    expect(incomplete.qualityScore).toBeNull();

    const noArtifact = scoreHumanMediaCase("image.product-still-life.v1", {
      mediaType: "image",
      artifactCount: 0,
      scores: { identity: 5, composition: 5, artifacts: 5, "prompt-fit": 5, safety: 5 },
    });
    expect(noArtifact.artifactRequirementPassed).toBe(false);
    expect(noArtifact.qualityScore).toBeNull();
  });
});

describe("promotion aggregation", () => {
  it("uses nearest-rank P95", () => {
    expect(percentile95([1])).toBe(1);
    expect(percentile95(Array.from({ length: 20 }, (_, index) => index + 1))).toBe(19);
    expect(() => percentile95([])).toThrow();
  });

  it("does not fabricate zero cost when any actual-cost sample is missing", () => {
    const metrics = aggregatePromotionMetrics([
      trial({ runId: "run-1", actualCostUsd: 0.02 }),
      trial({ runId: "run-2", actualCostUsd: null }),
    ]);
    expect(metrics.costSampleCount).toBe(1);
    expect(metrics.distinctCaseCount).toBe(1);
    expect(metrics.costCoverageRate).toBe(0.5);
    expect(metrics.totalActualCostUsd).toBeNull();
    expect(metrics.averageActualCostUsd).toBeNull();
  });

  it("aggregates success, structure, quality coverage, latency, and complete actual cost", () => {
    const metrics = aggregatePromotionMetrics([
      trial({ runId: "run-1", success: true, structurePassed: true, qualityScore: 90, latencyMs: 100, actualCostUsd: 0.01 }),
      trial({ runId: "run-2", success: false, structurePassed: false, qualityScore: null, latencyMs: 200, actualCostUsd: 0.03 }),
    ]);
    expect(metrics).toMatchObject({
      sampleCount: 2,
      distinctCaseCount: 1,
      successRate: 0.5,
      structureSampleCount: 2,
      structurePassRate: 0.5,
      qualitySampleCount: 1,
      qualityCoverageRate: 0.5,
      qualityScore: 90,
      p95LatencyMs: 200,
      costCoverageRate: 1,
      totalActualCostUsd: 0.04,
      averageActualCostUsd: 0.02,
    });
  });

  it("blocks promotion when a configured cost ceiling has incomplete actual cost", () => {
    const metrics = aggregatePromotionMetrics([
      trial({ runId: "run-1", actualCostUsd: 0.01 }),
      trial({ runId: "run-2", actualCostUsd: null }),
    ]);
    const thresholds: PromotionThresholds = {
      minSamples: 2,
      minDistinctCases: 1,
      minSuccessRate: 1,
      minStructurePassRate: 1,
      minQualityCoverageRate: 1,
      minQualityScore: 80,
      maxP95LatencyMs: 2_000,
      minCostCoverageRate: 0,
      requireCostLimit: false,
      maxAverageActualCostUsd: 0.1,
    };
    const decision = evaluatePromotion(metrics, thresholds);
    expect(decision.passed).toBe(false);
    expect(decision.failures.map((item) => item.code)).toEqual(["cost-unavailable"]);
  });

  it("allows reviewed media only with full actual-cost coverage and a configured ceiling", () => {
    const metrics = aggregatePromotionMetrics([
      trial({ caseId: "tts.mandarin-product.zh.v1", runId: "tts-priced-1", structurePassed: null, actualCostUsd: 0.01 }),
      trial({ caseId: "tts.mandarin-product.zh.v1", runId: "tts-priced-2", structurePassed: null, actualCostUsd: 0.02 }),
      trial({ caseId: "tts.mandarin-product.zh.v1", runId: "tts-priced-3", structurePassed: null, actualCostUsd: 0.03 }),
    ]);
    const decision = evaluatePromotion(metrics, {
      minSamples: 3,
      minDistinctCases: 1,
      minSuccessRate: 0.95,
      minStructurePassRate: null,
      minQualityCoverageRate: 1,
      minQualityScore: 80,
      maxP95LatencyMs: 30_000,
      minCostCoverageRate: 1,
      requireCostLimit: true,
      maxAverageActualCostUsd: 0.025,
    });
    expect(metrics.costCoverageRate).toBe(1);
    expect(metrics.averageActualCostUsd).toBe(0.02);
    expect(decision).toEqual({ passed: true, failures: [] });
  });

  it("does not let three runs of the same case satisfy distinct Golden coverage", () => {
    const metrics = aggregatePromotionMetrics([
      trial({ runId: "same-case-run-1" }),
      trial({ runId: "same-case-run-2" }),
      trial({ runId: "same-case-run-3" }),
    ]);
    const thresholds: PromotionThresholds = {
      minSamples: 3,
      minDistinctCases: 3,
      minSuccessRate: 1,
      minStructurePassRate: 1,
      minQualityCoverageRate: 1,
      minQualityScore: 80,
      maxP95LatencyMs: 2_000,
      minCostCoverageRate: 0,
      requireCostLimit: false,
      maxAverageActualCostUsd: null,
    };

    expect(metrics).toMatchObject({ sampleCount: 3, distinctCaseCount: 1 });
    expect(evaluatePromotion(metrics, thresholds)).toEqual({
      passed: false,
      failures: [{
        code: "distinct-cases",
        message: "Golden case 种类数不足",
        actual: 1,
        required: 3,
      }],
    });
    expect(() => evaluatePromotion(metrics, { ...thresholds, minDistinctCases: 0 }))
      .toThrow(/minDistinctCases/);
  });

  it("treats structure rate as not applicable for fully reviewed media", () => {
    const metrics = aggregatePromotionMetrics([
      trial({ caseId: "tts.mandarin-product.zh.v1", runId: "tts-1", structurePassed: null, qualityScore: 82, actualCostUsd: null, latencyMs: 4_000 }),
      trial({ caseId: "tts.mandarin-product.zh.v1", runId: "tts-2", structurePassed: null, qualityScore: 85, actualCostUsd: null, latencyMs: 5_000 }),
      trial({ caseId: "tts.mandarin-product.zh.v1", runId: "tts-3", structurePassed: null, qualityScore: 84, actualCostUsd: null, latencyMs: 6_000 }),
    ]);
    expect(metrics.structurePassRate).toBeNull();
    const decision = evaluatePromotion(metrics, INVITE_BETA_PROMOTION_THRESHOLDS["tts-generation"]);
    expect(decision.passed).toBe(false);
    expect(decision.failures.map((item) => item.code)).toEqual([
      "distinct-cases",
      "cost-coverage",
      "cost-threshold-unconfigured",
    ]);
  });

  it("rejects mixed candidates, mixed Agents, duplicate runs, and invalid cost", () => {
    expect(() => aggregatePromotionMetrics([
      trial({ runId: "a", candidateKey: "candidate-a" }),
      trial({ runId: "b", candidateKey: "candidate-b" }),
    ])).toThrow(/\u5019\u9009\u6a21\u578b/);

    expect(() => aggregatePromotionMetrics([
      trial({ runId: "a" }),
      trial({ runId: "b", caseId: "weekly-report.low-data.zh.v1" }),
    ])).toThrow(/Agent/);

    expect(() => aggregatePromotionMetrics([
      trial({ runId: "same" }),
      trial({ runId: "same" }),
    ])).toThrow(/runId/);

    expect(() => aggregatePromotionMetrics([trial({ actualCostUsd: -0.01 })])).toThrow(/actualCostUsd/);
  });
});
