import { beforeEach, describe, expect, it, vi } from "vitest";

import { ProviderError } from "@backend/providers";

const mocks = vi.hoisted(() => ({
  generateSpeech: vi.fn(),
  acquireLease: vi.fn(),
  releaseLease: vi.fn(),
  storeAudio: vi.fn(),
  deleteArtifacts: vi.fn(),
  verifyArtifacts: vi.fn(),
  getState: vi.fn(),
  mutateState: vi.fn(),
  buildTtsRequest: vi.fn(),
}));

vi.mock("@backend/core/media/tts", () => ({
  generateSpeech: mocks.generateSpeech,
}));

vi.mock("@server/admin/evals/artifacts", () => {
  class GoldenEvaluationBusyError extends Error {}
  return {
    GoldenEvaluationBusyError,
    acquireGoldenEvaluationLease: mocks.acquireLease,
    deleteGoldenArtifacts: mocks.deleteArtifacts,
    storeGoldenAudioArtifact: mocks.storeAudio,
    storeGoldenRemoteArtifacts: vi.fn(),
    verifyGoldenArtifacts: mocks.verifyArtifacts,
  };
});

vi.mock("@server/admin/agents/store", () => ({
  getAgentStrategy: mocks.getState,
  mutateAgentStrategy: mocks.mutateState,
}));

vi.mock("@server/admin/agents/constants", () => ({ MAX_EVALS: 500 }));
vi.mock("@server/admin/agents/utils", () => ({ nowIso: () => "2026-07-16T09:00:00.000Z" }));
vi.mock("@server/admin/evals/runner", () => ({ extractActualCostUsd: () => null }));

const binding = {
  candidateKey: "tts-candidate-key",
  evaluationFingerprint: "a".repeat(64),
  promptContentSha256: "b".repeat(64),
  draftConfigSha256: "c".repeat(64),
  goldenSetSha256: "d".repeat(64),
  codeVersion: "test-code",
};
const constraints = {
  caseName: "普通话商品口播",
  mediaType: "audio" as const,
  minimumArtifacts: 1,
  expectedArtifactCount: 1,
  aspectRatio: null,
  durationSeconds: null,
  durationRangeSeconds: [4, 12] as [number, number],
};

vi.mock("@server/admin/evals/media-jobs/preparation", () => ({
  buildGoldenMediaProviderConnection: vi.fn(),
  buildGoldenMediaProviderRequest: vi.fn(),
  buildGoldenTtsOneShotRequest: mocks.buildTtsRequest,
  goldenMediaJobBinding: () => binding,
  goldenMediaJobConstraints: () => constraints,
}));

vi.mock("@server/admin/evals/media-jobs/provider-adapter", () => {
  class GoldenMediaSubmissionUncertainError extends Error {
    readonly code = "SUBMISSION_UNCERTAIN";
  }
  return {
    GoldenMediaSubmissionUncertainError,
    pollGoldenMediaTask: vi.fn(),
    submitGoldenMediaTask: vi.fn(),
  };
});

vi.mock("@server/admin/evals/media-jobs/repository", () => {
  class GoldenMediaJobRetryableError extends Error {
    readonly code = "GOLDEN_MEDIA_JOB_RETRYABLE";
  }
  class GoldenMediaPreSubmitRetryableError extends Error {
    readonly code = "GOLDEN_MEDIA_PRE_SUBMIT_RETRYABLE";
  }
  return { GoldenMediaJobRetryableError, GoldenMediaPreSubmitRetryableError };
});

import { GoldenEvaluationBusyError } from "@server/admin/evals/artifacts";
import {
  GoldenMediaSubmissionUncertainError,
} from "@server/admin/evals/media-jobs/provider-adapter";
import {
  GoldenMediaPreSubmitRetryableError,
} from "@server/admin/evals/media-jobs/repository";
import { executePersistedGoldenTtsEvalJob } from "@server/admin/evals/media-jobs/processor";

function job() {
  const now = new Date();
  return {
    id: "eval_tts_one_shot_001",
    status: "submitting" as const,
    remoteTaskId: null,
    requestKind: "tts-generation" as const,
    agentId: "ttsAgent",
    caseId: "tts.mandarin-product.zh.v1",
    candidateRole: "primary" as const,
    candidateKey: binding.candidateKey,
    provider: "openai",
    model: "tts-1",
    promptVersion: "tts-v1",
    strategyRevision: 1,
    startedAt: now,
  };
}

const artifact = {
  url: "/api/admin/model-evals/artifacts/eval_tts_one_shot_001/audio.mp3",
  filename: "00000000-0000-4000-8000-000000000000.mp3",
  mediaType: "audio" as const,
  mimeType: "audio/mpeg",
  sizeBytes: 20_000,
  sha256: "e".repeat(64),
  probe: {
    formatName: "mp3",
    codecName: "mp3",
    durationSeconds: 6,
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  const state = { evals: [] as Array<Record<string, unknown>> };
  mocks.getState.mockResolvedValue(state);
  mocks.mutateState.mockImplementation(async (updater: (value: typeof state) => typeof state) => {
    const next = updater(state);
    state.evals = next.evals;
    return next;
  });
  mocks.acquireLease.mockResolvedValue(mocks.releaseLease);
  mocks.releaseLease.mockResolvedValue(undefined);
  mocks.buildTtsRequest.mockResolvedValue({
    text: "早上赶时间，这杯燕麦加牛奶拌一拌。",
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    apiKey: "test-only-key",
    model: "tts-1",
    voice: "alloy",
    speed: 1,
  });
  mocks.generateSpeech.mockResolvedValue(Buffer.from("real-mp3"));
  mocks.storeAudio.mockResolvedValue([artifact]);
});

describe("Golden TTS 持久 one-shot", () => {
  it("先获取评测 lease，精确调用一次且真实成本保持未知", async () => {
    const outcome = await executePersistedGoldenTtsEvalJob(job() as never);

    expect(mocks.acquireLease).toHaveBeenCalledTimes(1);
    expect(mocks.generateSpeech).toHaveBeenCalledTimes(1);
    expect(mocks.generateSpeech).toHaveBeenCalledWith(
      "早上赶时间，这杯燕麦加牛奶拌一拌。",
      expect.objectContaining({ provider: "openai", model: "tts-1", voice: "alloy", speed: 1 }),
      { bypassCache: true },
    );
    expect(mocks.storeAudio).toHaveBeenCalledTimes(1);
    expect(outcome).toMatchObject({
      state: "completed",
      result: { evalId: "eval_tts_one_shot_001", actualCostUsd: null },
      artifactUrls: [artifact.url],
    });
    expect(mocks.releaseLease).toHaveBeenCalledTimes(1);
  });

  it("供应商提交结果不明时永久转 uncertain 语义，不会再调一次", async () => {
    mocks.generateSpeech.mockRejectedValueOnce(
      new ProviderError("unknown", "SUBMISSION_UNCERTAIN", "openai"),
    );
    await expect(executePersistedGoldenTtsEvalJob(job() as never))
      .rejects.toBeInstanceOf(GoldenMediaSubmissionUncertainError);
    expect(mocks.generateSpeech).toHaveBeenCalledTimes(1);
    expect(mocks.storeAudio).not.toHaveBeenCalled();
    expect(mocks.releaseLease).toHaveBeenCalledTimes(1);
  });

  it("付费前 evaluation lease 忙时安全退回 pending，不触发 TTS", async () => {
    mocks.acquireLease.mockRejectedValueOnce(new GoldenEvaluationBusyError());
    await expect(executePersistedGoldenTtsEvalJob(job() as never))
      .rejects.toBeInstanceOf(GoldenMediaPreSubmitRetryableError);
    expect(mocks.generateSpeech).not.toHaveBeenCalled();
    expect(mocks.storeAudio).not.toHaveBeenCalled();
  });
});
