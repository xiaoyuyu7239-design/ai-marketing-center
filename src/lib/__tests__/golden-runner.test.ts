import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { defaultState } from "@server/admin/agents/defaults";
import { ffmpegBin } from "@backend/shared/ffmpeg-path";
import type { AgentEvalRecord } from "@server/admin/agents/types";
import { getGoldenCase } from "@server/admin/evals/golden-set";
import {
  assertGoldenMediaCandidateReady,
  candidateBindingFor,
  extractActualCostUsd,
  getGoldenCaseReadiness,
  getPromotionDecisionForDraft,
  promotionEvidenceForDraft,
  runGoldenJsonCase,
  runGoldenMediaCase,
} from "@server/admin/evals/runner";

const validProductAnalysis = {
  productName: "BlendJet 便携榨汁杯",
  category: "home",
  brand: "BlendJet",
  visualFeatures: {
    mainColor: "深蓝色",
    designStyle: "简洁便携",
    productForm: "圆柱形榨汁杯",
    texture: "透明杯体与磨砂底座",
  },
  sellingPoints: ["便携手提", "透明杯体可见食材"],
  targetAudience: "需要快速制作果汁的通勤人群",
  usageScenarios: ["居家早餐", "办公室加餐"],
  painPoints: ["传统榨汁机不便携带"],
  videoSuggestions: {
    recommendedAngles: ["正面特写", "杯体旋转特写"],
    keyVisuals: ["放入水果", "果汁完成状态"],
    suggestedStyle: "scene",
  },
};

function realMp3(root: string) {
  const path = join(root, "golden-real.mp3");
  const generated = spawnSync(ffmpegBin(), [
    "-v", "error", "-f", "lavfi", "-i", "sine=frequency=660:sample_rate=16000",
    "-t", "6", "-codec:a", "libmp3lame", "-y", path,
  ]);
  if (generated.status !== 0) throw new Error(`ffmpeg fixture failed: ${generated.stderr?.toString()}`);
  return readFileSync(path);
}

function passingRecord(
  base: ReturnType<typeof defaultState>,
  role: "primary" | "fallback",
  index: number,
): AgentEvalRecord {
  const agent = base.draftAgents.find((item) => item.id === "script")!;
  const binding = candidateBindingFor(base, agent, role, "chat-json");
  return {
    id: `${role}-${index}`,
    createdAt: new Date(2026, 6, 16, 10, 0, index).toISOString(),
    agentId: "script",
    candidateModel: agent[role].model,
    provider: agent[role].provider,
    promptVersion: agent.promptVersion,
    testCase: "科技品带货 20 秒分镜",
    output: "{}",
    latencyMs: 1_000,
    errored: false,
    jsonParsed: true,
    evaluationKind: "golden",
    status: "completed",
    caseId: "script.tech-earbuds.zh.v1",
    ...binding,
    candidateRole: role,
    requestKind: "chat-json",
    structurePassed: true,
    qualityScore: 90,
    actualCostUsd: null,
    artifactUrls: [],
  };
}

describe("Golden fixture and dedicated runner", () => {
  it("resolves the pinned product fixture and scores vision JSON", async () => {
    const goldenCase = getGoldenCase("product-analysis.juicer.zh.v1");
    expect(await getGoldenCaseReadiness(goldenCase)).toMatchObject({ ready: true });
    if (goldenCase.outputKind !== "json") throw new Error("unexpected media case");
    const executor = vi.fn(async (input: { imageDataUrls: string[] }) => ({
      output: JSON.stringify(validProductAnalysis),
      response: { usage: { cost_usd: 0.0123 } },
      inspected: input.imageDataUrls,
    }));
    const result = await runGoldenJsonCase(
      goldenCase,
      { provider: "openai-compatible", baseUrl: "https://api.openai.com/v1", apiKey: "test", model: "vision", visionModel: "vision" },
      "system",
      executor,
    );
    expect(executor).toHaveBeenCalledOnce();
    const executorInput = executor.mock.calls[0][0];
    expect(executorInput.imageDataUrls[0]).toMatch(/^data:image\/png;base64,/);
    expect(result.score.structurePassed).toBe(true);
    expect(result.score.qualityScore).toBe(100);
    expect(result.actualCostUsd).toBe(0.0123);
  });

  it("fails before the executor when an OCR fixture is disabled", async () => {
    const goldenCase = getGoldenCase("metrics-ocr.douyin-clear.zh.v1");
    expect(await getGoldenCaseReadiness(goldenCase)).toMatchObject({ ready: false });
    if (goldenCase.outputKind !== "json") throw new Error("unexpected media case");
    const executor = vi.fn();
    await expect(runGoldenJsonCase(
      goldenCase,
      { provider: "openai-compatible", baseUrl: "https://api.openai.com/v1", apiKey: "test", model: "vision" },
      "system",
      executor,
    )).rejects.toThrow(/OCR|fixture|case/i);
    expect(executor).not.toHaveBeenCalled();
  });

  it("never infers cost from tokens or latency", () => {
    expect(extractActualCostUsd({ usage: { total_tokens: 1234 } })).toBeNull();
    expect(extractActualCostUsd({ latencyMs: 900, cost: 0.1 })).toBeNull();
    expect(extractActualCostUsd({ usage: { costUsd: 0.02 } })).toBe(0.02);
    expect(extractActualCostUsd({ extra: { usage: { cost_usd: 0.03 } } })).toBe(0.03);
  });

  it("mirrors production mode mapping and rejects truly incompatible media IDs before a paid call", () => {
    const imageCase = getGoldenCase("image.product-still-life.v1");
    const videoCase = getGoldenCase("video.product-orbit.v1");
    if (imageCase.outputKind !== "media" || videoCase.outputKind !== "media") throw new Error("unexpected JSON case");
    const base = {
      provider: "atlas-cloud",
      baseUrl: "https://api.atlascloud.ai/api/v1",
      apiKey: "test",
    };
    expect(() => assertGoldenMediaCandidateReady(imageCase, {
      ...base,
      model: "openai/gpt-image-2/text-to-image",
    })).not.toThrow();
    expect(() => assertGoldenMediaCandidateReady(imageCase, {
      ...base,
      model: "bytedance/seedream-v5.0-lite",
    })).toThrow(/model|生图参数/i);
    expect(() => assertGoldenMediaCandidateReady(videoCase, {
      ...base,
      model: "bytedance/seedance-2.0/text-to-video",
    })).not.toThrow();
    expect(() => assertGoldenMediaCandidateReady(videoCase, {
      ...base,
      model: "bytedance/seedance-2.0",
    })).toThrow(/model|9:16/i);
  });

  it("validates the pinned media fixture before invoking a paid executor", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "huimai-invalid-golden-fixture-"));
    mkdirSync(join(fixtureRoot, "public/examples"), { recursive: true });
    writeFileSync(join(fixtureRoot, "public/examples/juicer.png"), Buffer.from("tampered"));
    process.env.HUIMAI_GOLDEN_FIXTURE_ROOT = fixtureRoot;
    const executor = vi.fn();
    try {
      const goldenCase = getGoldenCase("image.product-still-life.v1");
      if (goldenCase.outputKind !== "media") throw new Error("unexpected JSON case");
      await expect(runGoldenMediaCase(
        goldenCase,
        { provider: "atlas-cloud", baseUrl: "https://api.atlascloud.ai/api/v1", apiKey: "test", model: "image-model" },
        "system",
        "eval_fixture_001",
        executor,
      )).rejects.toThrow(/fixture|\u9501\u5b9a|\u4e00\u81f4/i);
      expect(executor).not.toHaveBeenCalled();
    } finally {
      delete process.env.HUIMAI_GOLDEN_FIXTURE_ROOT;
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("persists a real TTS artifact and leaves scoring for human review", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "huimai-golden-tts-runner-"));
    process.env.APP_DATA_DIR = dataDir;
    const executor = vi.fn(async (input: { goldenCase: { input: { data: Record<string, unknown> } }; imageDataUrls: string[] }) => {
      expect(input.goldenCase.input.data.text).toBe("早上赶时间，这杯燕麦加牛奶拌一拌，三分钟就能带走。");
      expect(input.imageDataUrls).toEqual([]);
      const audio = realMp3(dataDir);
      return { mediaType: "audio" as const, audio, response: { usage: { total_tokens: 10 } } };
    });
    try {
      const goldenCase = getGoldenCase("tts.mandarin-product.zh.v1");
      if (goldenCase.outputKind !== "media") throw new Error("unexpected JSON case");
      const result = await runGoldenMediaCase(
        goldenCase,
        { provider: "openai", baseUrl: "https://api.openai.com/v1", apiKey: "test", model: "tts-1", voice: "alloy" },
        "system prompt must not be spoken",
        "eval_tts_001",
        executor,
      );
      expect(executor).toHaveBeenCalledOnce();
      expect(result.actualCostUsd).toBeNull();
      expect(result.artifactUrls[0]).toMatch(/^\/api\/admin\/model-evals\/artifacts\/eval_tts_001\/.+\.mp3$/);
      expect(result.output).toMatch(/\u4eba\u5de5 rubric/);
    } finally {
      delete process.env.APP_DATA_DIR;
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe("draft promotion gate decision", () => {
  it("is fail-closed in production and bypassable only in development", () => {
    const state = defaultState();
    const productionBootstrap = getPromotionDecisionForDraft(state, "script", { production: true });
    expect(productionBootstrap.enforced).toBe(true);
    expect(productionBootstrap.passed).toBe(false);
    expect(productionBootstrap.failures.join(" ")).toMatch(/Golden Set/);

    const development = getPromotionDecisionForDraft(state, "script", { production: false });
    expect(development.enforced).toBe(false);
    expect(development.passed).toBe(true);
  });

  it("requires distinct Golden case coverage for both exact draft candidates", () => {
    const base = defaultState();
    base.evals = [0, 1, 2].flatMap((index) => [
      passingRecord(base, "primary", index),
      passingRecord(base, "fallback", index),
    ]);
    const repeated = getPromotionDecisionForDraft(base, "script", { production: true });
    expect(repeated.passed).toBe(false);
    expect(repeated.candidates.every((candidate) => candidate.passed === false)).toBe(true);
    expect(repeated.candidates.every((candidate) => candidate.summary?.distinctCaseCount === 1)).toBe(true);
    expect(repeated.failures.join(" ")).toMatch(/case 种类数不足/);

    const agent = base.draftAgents.find((item) => item.id === "script")!;
    agent.primary.model = "new-unmeasured-model";
    const stale = getPromotionDecisionForDraft(base, "script", { production: true });
    expect(stale.passed).toBe(false);
    expect(stale.candidates.find((candidate) => candidate.role === "primary")?.summary).toBeNull();
  });

  it("builds strict server-owned promotion evidence from current bindings", () => {
    const state = defaultState();
    const verifiedAt = "2026-07-16T08:00:00.000Z";
    const evidence = promotionEvidenceForDraft(state, "script", verifiedAt);
    const agent = state.draftAgents.find((item) => item.id === "script")!;
    const primary = candidateBindingFor(state, agent, "primary", "chat-json");
    const fallback = candidateBindingFor(state, agent, "fallback", "chat-json");
    expect(evidence).toMatchObject({
      schemaVersion: 1,
      agentId: "script",
      requestKind: "chat-json",
      verifiedAt,
      goldenSetSha256: primary.goldenSetSha256,
      codeVersion: primary.codeVersion,
      primary: {
        candidateKey: primary.candidateKey,
        evaluationFingerprint: primary.evaluationFingerprint,
      },
      fallback: {
        candidateKey: fallback.candidateKey,
        evaluationFingerprint: fallback.evaluationFingerprint,
      },
    });
    const reordered = structuredClone(state);
    const reorderedAgent = reordered.draftAgents.find((item) => item.id === "script")!;
    const endpoint = reorderedAgent.primary;
    reorderedAgent.primary = {
      ...(endpoint.visionModel ? { visionModel: endpoint.visionModel } : {}),
      secretRef: endpoint.secretRef,
      baseUrl: endpoint.baseUrl,
      model: endpoint.model,
      provider: endpoint.provider,
    };
    expect(candidateBindingFor(reordered, reorderedAgent, "primary", "chat-json"))
      .toEqual(primary);
    expect(() => promotionEvidenceForDraft(state, "script", "not-a-date")).toThrow(/ISO/);
  });

  it("invalidates old candidates when same-version prompt content or code version changes", () => {
    const base = defaultState();
    base.evals = [0, 1, 2].flatMap((index) => [
      passingRecord(base, "primary", index),
      passingRecord(base, "fallback", index),
    ]);
    const baseline = getPromotionDecisionForDraft(base, "script", { production: true });
    expect(baseline.passed).toBe(false);
    expect(baseline.candidates.every((candidate) => candidate.summary?.distinctCaseCount === 1)).toBe(true);

    const agent = base.draftAgents.find((item) => item.id === "script")!;
    base.prompts = base.prompts.map((prompt) =>
      prompt.agentId === "script" && prompt.version === agent.promptVersion
        ? { ...prompt, content: `${prompt.content}\n未经新版本的内容篡改` }
        : prompt);
    const promptChanged = getPromotionDecisionForDraft(base, "script", { production: true });
    expect(promptChanged.passed).toBe(false);
    expect(promptChanged.candidates.every((candidate) => candidate.summary === null)).toBe(true);

    const fresh = defaultState();
    fresh.evals = [0, 1, 2].flatMap((index) => [
      passingRecord(fresh, "primary", index),
      passingRecord(fresh, "fallback", index),
    ]);
    const previousVersion = process.env.HUIMAI_CODE_VERSION;
    process.env.HUIMAI_CODE_VERSION = "different-build-sha";
    try {
      const codeChanged = getPromotionDecisionForDraft(fresh, "script", { production: true });
      expect(codeChanged.passed).toBe(false);
      expect(codeChanged.candidates.every((candidate) => candidate.summary === null)).toBe(true);
    } finally {
      if (previousVersion === undefined) delete process.env.HUIMAI_CODE_VERSION;
      else process.env.HUIMAI_CODE_VERSION = previousVersion;
    }
  });
});
