import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ComposeJobPayloadV1 } from "@backend/core/jobs/compose-payload";
import type { JobRecord } from "@backend/core/jobs/repository";

const mocks = vi.hoisted(() => ({
  assetPath: "",
  outputPath: "",
  dataDir: "",
  composeVideo: vi.fn(),
  runAgentOperation: vi.fn(),
  generateSpeech: vi.fn(),
  generateSpeechFree: vi.fn(),
  fetchFreeBgm: vi.fn(),
  markJobPaidTtsUsed: vi.fn(),
}));

vi.mock("@backend/core/jobs/compose-payload", () => ({
  parseComposeJobPayload: (value: unknown) => value,
  resolveComposeFileRef: () => mocks.assetPath,
}));

vi.mock("@backend/core/jobs/repository", () => ({
  checkpointJobResult: vi.fn(() => true),
  markJobPaidTtsUsed: mocks.markJobPaidTtsUsed,
  sanitizeJobError: (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    return message
      .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
      .replace(/sk-[A-Za-z0-9_-]+/g, "[REDACTED]");
  },
  JobLeaseLostError: class JobLeaseLostError extends Error {},
}));

vi.mock("@backend/core/agent/agent-strategy", () => ({
  runAgentOperation: mocks.runAgentOperation,
}));

vi.mock("@backend/core/media/tts", () => ({
  generateSpeech: mocks.generateSpeech,
}));

vi.mock("@backend/core/media/edge-tts", () => ({
  generateSpeechFree: mocks.generateSpeechFree,
}));

vi.mock("@backend/core/media/tts-cache", () => ({
  readTtsCache: vi.fn(async () => null),
  ttsCacheKey: vi.fn(() => "test-cache-key"),
  writeTtsCache: vi.fn(async () => undefined),
}));

vi.mock("@backend/core/media/free-bgm", () => ({
  fetchFreeBgm: mocks.fetchFreeBgm,
  moodQueryForCategory: vi.fn(() => "category-query"),
  moodQueryForMood: vi.fn(() => "mood-query"),
}));

vi.mock("@backend/shared/paths", () => ({
  getDataDir: () => mocks.dataDir,
  getUploadsDir: () => join(mocks.dataDir, "uploads"),
}));

vi.mock("@backend/shared/ffmpeg-path", () => ({
  ffmpegBin: () => "/usr/bin/false",
  ffprobeBin: () => "/usr/bin/false",
}));

vi.mock("@backend/video-composer/composer", () => ({
  composeVideo: mocks.composeVideo,
  FADE_DURATION: 0.5,
  resolveChineseFontFamily: () => "Noto Sans CJK SC",
  chunkCaption: (text: string, startTime: number, endTime: number) => [
    { text, startTime, endTime },
  ],
}));

import {
  MAX_PAID_TTS_VOICEOVER_SHOTS,
  PAID_TTS_WORKFLOW_BUDGET_MS,
  runComposeJob,
} from "@backend/core/jobs/compose-handler";

function payload(license: string | null, freeTts = false, agentTts = false): ComposeJobPayloadV1 {
  return {
    version: 1,
    merchantId: "merchant-001",
    projectId: "project-001",
    selectedScriptId: "script-001",
    project: {
      name: "合成门禁测试",
      productName: "测试商品",
      productPrice: null,
      productCategory: "home",
      productImages: [],
    },
    shots: [
      {
        shotId: 1,
        type: "hook",
        duration: 3,
        transition: "direct_concat",
        voiceover: "这是测试旁白",
      },
    ],
    assets: [
      {
        id: "asset-001",
        shotId: 1,
        fileRef: "/api/files/project-001/stock.png",
        type: "stock_footage",
        provider: "openverse",
        author: "Alice",
        license,
        sourceUrl: "https://media.example/asset-001",
        licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
        attributionText: "Alice / CC BY 4.0",
        requiresAttribution: true,
      },
    ],
    options: {
      output: {
        resolution: "720p",
        aspectRatio: "9:16",
        videoPreset: "veryfast",
        crf: 22,
      },
      agentTts,
      freeTts: { enabled: freeTts, voice: "zh-CN-XiaoxiaoNeural" },
      freeBgm: false,
      bgmDuck: false,
      karaoke: false,
      productCard: false,
    },
  };
}

function job(jobPayload: ComposeJobPayloadV1): JobRecord {
  const now = new Date();
  return {
    id: "job-001",
    type: "compose",
    merchantId: jobPayload.merchantId,
    projectId: jobPayload.projectId,
    compositionId: "composition-stable-001",
    idempotencyKey: "compose-handler-key",
    requestHash: null,
    generationUsageId: null,
    paidTtsUsed: false,
    payloadVersion: 1,
    payload: jobPayload as unknown as Record<string, unknown>,
    result: null,
    status: "running",
    attempts: 1,
    maxAttempts: 2,
    availableAt: now,
    leaseOwner: "worker-001",
    leaseToken: "lease-token-001",
    lockedAt: now,
    leaseExpiresAt: new Date(now.getTime() + 90_000),
    heartbeatAt: now,
    errorCode: null,
    errorMessage: null,
    startedAt: now,
    finishedAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

function withVoiceoverCount(
  base: ComposeJobPayloadV1,
  count: number,
): ComposeJobPayloadV1 {
  return {
    ...base,
    shots: Array.from({ length: count }, (_, index) => ({
      ...base.shots[0],
      shotId: index + 1,
      voiceover: `第 ${index + 1} 镜测试旁白`,
    })),
    assets: Array.from({ length: count }, (_, index) => ({
      ...base.assets[0],
      id: `asset-${index + 1}`,
      shotId: index + 1,
      fileRef: `/api/files/project-001/stock-${index + 1}.png`,
      sourceUrl: `https://media.example/asset-${index + 1}`,
    })),
  };
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "huimai-compose-handler-"));
  mocks.dataDir = dir;
  mocks.assetPath = join(dir, "asset.png");
  mocks.outputPath = join(dir, "final_composition-stable-001.mp4");
  writeFileSync(mocks.assetPath, "asset");
  writeFileSync(mocks.outputPath, "video");
  mocks.composeVideo.mockReset();
  mocks.composeVideo.mockResolvedValue(mocks.outputPath);
  mocks.generateSpeechFree.mockReset();
  mocks.generateSpeechFree.mockResolvedValue(Buffer.from("fake-mp3-audio"));
  mocks.generateSpeech.mockReset();
  mocks.generateSpeech.mockResolvedValue(Buffer.alloc(200, 1));
  mocks.fetchFreeBgm.mockReset();
  mocks.fetchFreeBgm.mockResolvedValue(null);
  mocks.runAgentOperation.mockReset();
  mocks.runAgentOperation.mockRejectedValue(new Error("TTS should not run in this test"));
  mocks.markJobPaidTtsUsed.mockReset();
  mocks.markJobPaidTtsUsed.mockReturnValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe("runComposeJob 合规与确定性门禁", () => {
  it("worker 内逐镜 TTS 不再逐镜扣用户额度，workflow 只在入队边界计量", () => {
    const source = readFileSync(
      join(process.cwd(), "后端", "core", "jobs", "compose-handler.ts"),
      "utf8",
    );
    expect(source).toContain("runAgentOperation(");
    expect(source).not.toContain("import { runMeteredAgentOperation }");
    expect(source).not.toMatch(/const audio = await runMeteredAgentOperation\(/);
  });

  it("实际选中 stock 许可未核验时在任何 TTS/BGM 网络请求前失败", async () => {
    const invalid = payload(null, true, true);
    invalid.options.freeBgm = true;
    await expect(runComposeJob(job(invalid), "worker-001", "lease-token-001")).rejects.toThrow(
      /缺少来源或许可/,
    );
    expect(mocks.runAgentOperation).not.toHaveBeenCalled();
    expect(mocks.generateSpeechFree).not.toHaveBeenCalled();
    expect(mocks.fetchFreeBgm).not.toHaveBeenCalled();
    expect(mocks.composeVideo).not.toHaveBeenCalled();
  });

  it("许可可核验时传入唯一 compositionId，并强制全程 AIGC 显式标识", async () => {
    const result = await runComposeJob(
      job(payload("CC BY 4.0")),
      "worker-001",
      "lease-token-001",
    );
    expect(result.outputPath).toBe(mocks.outputPath);
    expect(result.credits).toHaveLength(1);
    expect(mocks.composeVideo).toHaveBeenCalledTimes(1);
    const config = mocks.composeVideo.mock.calls[0][0];
    expect(config.compositionId).toBe("composition-stable-001");
    expect(config.projectId).toBe("project-001");
    expect(config.overlays).toContainEqual(
      expect.objectContaining({ text: "AI生成/辅助", style: "disclosure", startTime: 0 }),
    );
  });

  it("归属/租约快照不一致时不读素材、不执行合成", async () => {
    const mismatched = job(payload("CC BY 4.0"));
    mismatched.leaseToken = "new-token";
    await expect(runComposeJob(mismatched, "worker-001", "stale-token")).rejects.toThrow(
      /归属、类型或租约快照不一致/,
    );
    expect(mocks.composeVideo).not.toHaveBeenCalled();
  });

  it("TTS 中间产物隔离到 compositionId 目录，retry 不会误用其他合成的音频", async () => {
    await runComposeJob(
      job(payload("CC BY 4.0", true)),
      "worker-001",
      "lease-token-001",
    );
    const expectedAudio = join(
      dir,
      "uploads",
      "project-001",
      "tts",
      "composition-stable-001",
      "shot-1.mp3",
    );
    expect(existsSync(expectedAudio)).toBe(true);
    expect(existsSync(join(dir, "uploads", "project-001", "tts", "shot-1.mp3"))).toBe(false);
    expect(mocks.composeVideo.mock.calls[0][0].clips[0].audioPath).toBe(expectedAudio);
  });

  it("付费 TTS 原子落盘后返回 paidTtsUsed；retry 只复用可信 agent provenance 不再请求供应商", async () => {
    mocks.runAgentOperation.mockImplementation(async (_agentId, _label, operation) => operation({
      provider: "openai-compatible",
      baseUrl: "https://tts.example/v1",
      apiKey: "server-only-secret",
      model: "tts-model",
      voice: "alloy",
    }));
    const paidPayload = payload("CC BY 4.0", false, true);
    const first = await runComposeJob(job(paidPayload), "worker-001", "lease-token-001");
    expect(first.paidTtsUsed).toBe(true);
    expect(mocks.runAgentOperation).toHaveBeenCalledTimes(1);
    expect(mocks.markJobPaidTtsUsed).toHaveBeenCalledTimes(1);

    const audioPath = join(
      dir,
      "uploads",
      "project-001",
      "tts",
      "composition-stable-001",
      "shot-1.mp3",
    );
    const provenance = JSON.parse(readFileSync(`${audioPath}.source.json`, "utf8"));
    expect(provenance).toMatchObject({ version: 1, source: "agent" });
    expect(JSON.stringify(provenance)).not.toContain("server-only-secret");

    const retriedJob = job(paidPayload);
    retriedJob.paidTtsUsed = true;
    const replay = await runComposeJob(retriedJob, "worker-001", "lease-token-001");
    expect(replay.paidTtsUsed).toBe(true);
    expect(mocks.runAgentOperation).toHaveBeenCalledTimes(1);
    expect(mocks.markJobPaidTtsUsed).toHaveBeenCalledTimes(2);
  });

  it("agentTts 失败转 free TTS 时 provenance 标记 free，完成结果不误算付费额度", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mocks.runAgentOperation.mockRejectedValue(
      new Error("paid provider unavailable Authorization: Bearer sk-sensitive-token"),
    );
    mocks.generateSpeechFree.mockResolvedValue(Buffer.alloc(200, 2));
    const result = await runComposeJob(
      job(payload("CC BY 4.0", true, true)),
      "worker-001",
      "lease-token-001",
    );
    expect(result.paidTtsUsed).toBe(false);
    expect(mocks.markJobPaidTtsUsed).not.toHaveBeenCalled();
    const provenancePath = join(
      dir,
      "uploads",
      "project-001",
      "tts",
      "composition-stable-001",
      "shot-1.mp3.source.json",
    );
    expect(JSON.parse(readFileSync(provenancePath, "utf8"))).toMatchObject({ source: "free" });
    const serializedLogs = JSON.stringify(warn.mock.calls);
    expect(serializedLogs).not.toContain("sk-sensitive-token");
    expect(serializedLogs).toContain("[REDACTED]");
  });

  it("付费 TTS 最多请求 12 镜，超出镜数直接转免费配音", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mocks.runAgentOperation.mockImplementation(
      async (_agentId, _label, operation) => operation({
        provider: "openai-compatible",
        baseUrl: "https://tts.example/v1",
        apiKey: "server-only-secret",
        model: "tts-model",
        voice: "alloy",
      }),
    );
    const manyShots = withVoiceoverCount(
      payload("CC BY 4.0", true, true),
      MAX_PAID_TTS_VOICEOVER_SHOTS + 2,
    );
    const result = await runComposeJob(job(manyShots), "worker-001", "lease-token-001");
    expect(result.paidTtsUsed).toBe(true);
    expect(mocks.runAgentOperation).toHaveBeenCalledTimes(MAX_PAID_TTS_VOICEOVER_SHOTS);
    expect(mocks.generateSpeechFree).toHaveBeenCalledTimes(2);
  });

  it("付费 TTS 工作流达 180 秒总预算后不再发起新付费请求", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    mocks.runAgentOperation.mockImplementation(
      async (_agentId, _label, operation) => {
        const audio = await operation({
          provider: "openai-compatible",
          baseUrl: "https://tts.example/v1",
          apiKey: "server-only-secret",
          model: "tts-model",
          voice: "alloy",
        });
        now = PAID_TTS_WORKFLOW_BUDGET_MS + 1;
        return audio;
      },
    );
    const twoShots = withVoiceoverCount(payload("CC BY 4.0", true, true), 2);
    await runComposeJob(job(twoShots), "worker-001", "lease-token-001");
    expect(mocks.runAgentOperation).toHaveBeenCalledTimes(1);
    expect(mocks.generateSpeechFree).toHaveBeenCalledTimes(1);
  });
});
