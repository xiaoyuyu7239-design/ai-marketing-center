import { describe, expect, it } from "vitest";

import {
  CAPABILITY_FAMILIES,
  GOLDEN_AGENT_IDS,
  GOLDEN_CASES,
  getCapabilityFamilyForAgent,
  getGoldenCasesForAgent,
  validateGoldenSetIntegrity,
} from "@server/admin/evals/golden-set";

describe("model evaluation golden set", () => {
  it("covers every Agent exactly once by family and with complete weights", () => {
    expect(validateGoldenSetIntegrity()).toEqual([]);

    for (const agentId of GOLDEN_AGENT_IDS) {
      const cases = getGoldenCasesForAgent(agentId);
      expect(cases.length, agentId).toBeGreaterThan(0);
      expect(cases.reduce((sum, item) => sum + item.weight, 0), agentId).toBe(100);
      for (const goldenCase of cases) {
        expect(goldenCase.id).toMatch(/\.v1$/);
        expect(goldenCase.input.userPrompt.length).toBeGreaterThan(0);
        expect(goldenCase.rubric.reduce((sum, item) => sum + item.weight, 0)).toBe(100);
      }
    }
  });

  it("shares candidate pools by capability family", () => {
    expect(getCapabilityFamilyForAgent("script").candidatePoolId)
      .toBe(getCapabilityFamilyForAgent("topic-script").candidatePoolId);
    expect(getCapabilityFamilyForAgent("publish-copy").candidatePoolId)
      .toBe(getCapabilityFamilyForAgent("weekly-report").candidatePoolId);
    expect(getCapabilityFamilyForAgent("product-analysis").candidatePoolId)
      .toBe(getCapabilityFamilyForAgent("metrics-ocr").candidatePoolId);
    expect(new Set(CAPABILITY_FAMILIES.map((item) => item.candidatePoolId)).size)
      .toBe(CAPABILITY_FAMILIES.length);
  });

  it("never routes image, video, or TTS cases through chat completion", () => {
    const mediaCases = GOLDEN_CASES.filter((item) => item.outputKind === "media");
    expect(mediaCases.map((item) => item.agentId).sort()).toEqual(["imageAgent", "ttsAgent", "videoAgent"].sort());

    for (const goldenCase of mediaCases) {
      const family = getCapabilityFamilyForAgent(goldenCase.agentId);
      expect(family.requestKind).not.toBe("chat-json");
      expect(family.requestKind).not.toBe("vision-json");
      expect(goldenCase.requiredShape.humanReviewRequired).toBe(true);
      expect(goldenCase.rubric.every((item) => item.evaluator === "human")).toBe(true);
    }
  });
});
