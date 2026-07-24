import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ffmpegBin } from "@backend/shared/ffmpeg-path";
import type { AgentEvalRecord } from "@server/admin/agents/types";

const openAiCreate = vi.hoisted(() => vi.fn());
const createProviderMock = vi.hoisted(() => vi.fn());
const mediaGenerateImage = vi.hoisted(() => vi.fn());
const mediaGenerateVideo = vi.hoisted(() => vi.fn());
const generateSpeechMock = vi.hoisted(() => vi.fn());
const safeFetchMock = vi.hoisted(() => vi.fn());

vi.mock("openai", () => ({
  default: class MockOpenAI {
    chat = { completions: { create: openAiCreate } };
  },
}));

vi.mock("@backend/providers", () => ({
  createProvider: createProviderMock,
}));

vi.mock("@backend/core/media/tts", () => ({
  generateSpeech: generateSpeechMock,
}));

vi.mock("@backend/shared/ssrf-guard", async (importOriginal) => {
  const original = await importOriginal<typeof import("@backend/shared/ssrf-guard")>();
  return { ...original, safeFetch: safeFetchMock, safeFetchPinned: safeFetchMock };
});

function png() {
  return readFileSync(join(process.cwd(), "public/examples/juicer.png"));
}

let videoFixture = Buffer.alloc(0);
let audioFixture = Buffer.alloc(0);

function mp4() {
  return videoFixture;
}

function mp3() {
  return audioFixture;
}

function generateMediaFixtures(root: string) {
  const videoPath = join(root, "golden-video.mp4");
  const audioPath = join(root, "golden-audio.mp3");
  const video = spawnSync(ffmpegBin(), [
    "-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=1080x1920:r=5",
    "-t", "5", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-y", videoPath,
  ]);
  const audio = spawnSync(ffmpegBin(), [
    "-v", "error", "-f", "lavfi", "-i", "sine=frequency=700:sample_rate=16000",
    "-t", "6", "-codec:a", "libmp3lame", "-y", audioPath,
  ]);
  if (video.status !== 0 || audio.status !== 0) {
    throw new Error(`ffmpeg fixtures failed: ${video.stderr?.toString()} ${audio.stderr?.toString()}`);
  }
  videoFixture = readFileSync(videoPath);
  audioFixture = readFileSync(audioPath);
}

function request(
  url: string,
  method = "GET",
  body?: unknown,
  cookie?: string,
  headers: Record<string, string> = {},
) {
  return new NextRequest(url, {
    method,
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(cookie ? { Cookie: cookie } : {}),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function operationKey() {
  return `test-golden-${randomUUID()}`;
}

const validScript = {
  title: "通勤降噪耳机",
  totalDuration: 20,
  shots: ["hook", "pain_point", "product_reveal", "demo", "cta"].map((type, index) => ({
    shotId: index + 1,
    type,
    duration: 4,
    description: `分镜 ${index + 1}`,
    camera: "稳定近景",
    visualSource: "ai_generate",
    transition: "direct_concat",
    voiceover: `第 ${index + 1} 句口播`,
    prompt: `commercial shot ${index + 1}`,
    searchTerms: [`earbuds shot ${index + 1}`],
  })),
};

describe("admin Golden model eval route", () => {
  let dataDir: string;
  let adminCookie: string;
  let route: typeof import("@/app/api/admin/model-evals/route");
  let artifactRoute: typeof import("@/app/api/admin/model-evals/artifacts/[evalId]/[artifactId]/route");
  let agents: typeof import("@server/admin/agents");
  let artifacts: typeof import("@server/admin/evals/artifacts");
  let runner: typeof import("@server/admin/evals/runner");
  let mediaJobs: typeof import("@server/admin/evals/media-jobs");

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "huimai-model-evals-test-"));
    generateMediaFixtures(dataDir);
    process.env.APP_DATA_DIR = dataDir;
    process.env.CLIPFORGE_LLM_API_KEY = "test-primary-secret";
    process.env.CLIPFORGE_LLM_FALLBACK_API_KEY = "test-fallback-secret";
    process.env.CLIPFORGE_LLM_BASE_URL = "https://api.openai.com/v1";
    process.env.CLIPFORGE_LLM_FALLBACK_BASE_URL = "https://api.siliconflow.cn/v1";
    process.env.CLIPFORGE_IMAGE_API_KEY = "test-image-primary-secret";
    process.env.CLIPFORGE_IMAGE_FALLBACK_API_KEY = "test-image-fallback-secret";
    process.env.CLIPFORGE_VIDEO_API_KEY = "test-video-primary-secret";
    process.env.CLIPFORGE_VIDEO_FALLBACK_API_KEY = "test-video-fallback-secret";
    process.env.CLIPFORGE_TTS_API_KEY = "test-tts-primary-secret";
    process.env.CLIPFORGE_TTS_FALLBACK_API_KEY = "test-tts-fallback-secret";
    agents = await import("@server/admin/agents");
    const { defaultState } = await import("@server/admin/agents/defaults");
    const state = defaultState();
    state.strategyRevision = 77;
    state.draftVersion = "strategy-draft-r77";
    state.draftAgents = state.draftAgents.map((agent) => {
      if (agent.id === "script") return {
          ...agent,
          strategyRevision: 77,
          primary: { ...agent.primary, baseUrl: "https://api.openai.com/v1", model: "draft-primary-eval" },
          fallback: { ...agent.fallback, baseUrl: "https://api.siliconflow.cn/v1", model: "draft-fallback-eval" },
        };
      if (agent.id === "imageAgent") return {
        ...agent,
        strategyRevision: 77,
        primary: { ...agent.primary, provider: "atlas-cloud", baseUrl: "https://api.atlascloud.ai/api/v1", model: "openai/gpt-image-2/edit" },
        fallback: { ...agent.fallback, provider: "atlas-cloud", baseUrl: "https://api.atlascloud.ai/api/v1", model: "openai/gpt-image-2/image-to-image" },
      };
      if (agent.id === "videoAgent") return {
        ...agent,
        strategyRevision: 77,
        primary: { ...agent.primary, provider: "atlas-cloud", baseUrl: "https://api.atlascloud.ai/api/v1", model: "bytedance/seedance-2.0/text-to-video" },
        fallback: { ...agent.fallback, provider: "atlas-cloud", baseUrl: "https://api.atlascloud.ai/api/v1", model: "bytedance/seedance-2.0/image-to-video" },
      };
      if (agent.id === "ttsAgent") return {
        ...agent,
        strategyRevision: 77,
        primary: { ...agent.primary, provider: "openai", baseUrl: "https://api.openai.com/v1", model: "draft-tts-primary", voice: "alloy" },
        fallback: { ...agent.fallback, provider: "atlas", baseUrl: "https://api.atlascloud.ai/api/v1", model: "draft-tts-fallback", voice: "eve" },
      };
      return agent;
    });
    await agents.saveAgentStrategy(state);
    const { createAdminToken, ADMIN_COOKIE_NAME } = await import("@server/admin/admin-auth");
    adminCookie = `${ADMIN_COOKIE_NAME}=${createAdminToken()}`;
    route = await import("@/app/api/admin/model-evals/route");
    artifactRoute = await import("@/app/api/admin/model-evals/artifacts/[evalId]/[artifactId]/route");
    artifacts = await import("@server/admin/evals/artifacts");
    runner = await import("@server/admin/evals/runner");
    mediaJobs = await import("@server/admin/evals/media-jobs");
  });

  beforeEach(() => {
    openAiCreate.mockReset();
    openAiCreate.mockResolvedValue({
      choices: [{ message: { content: JSON.stringify(validScript) } }],
      usage: { total_tokens: 999 },
    });
    createProviderMock.mockReset();
    mediaGenerateImage.mockReset();
    mediaGenerateVideo.mockReset();
    generateSpeechMock.mockReset();
    safeFetchMock.mockReset();
    createProviderMock.mockImplementation(() => ({
      generateImage: mediaGenerateImage,
      generateVideo: mediaGenerateVideo,
      getTaskStatus: vi.fn(),
      listModels: vi.fn(),
    }));
    mediaGenerateImage.mockResolvedValue({
      taskId: "image-task",
      imageUrls: ["https://cdn.example.test/golden-image.png"],
      modelId: "provider-does-not-control-candidate",
      extra: { usage: { cost_usd: 0.04 } },
    });
    mediaGenerateVideo.mockResolvedValue({
      taskId: "video-task",
      videoUrls: ["https://cdn.example.test/golden-video.mp4"],
      modelId: "provider-does-not-control-candidate",
    });
    generateSpeechMock.mockResolvedValue(mp3());
    safeFetchMock.mockImplementation(async (url: string) => new Response(
      url.includes("video") ? mp4() : png(),
      { status: 200, headers: { "Content-Type": url.includes("video") ? "video/mp4" : "image/png" } },
    ));
  });

  async function seedStoredImageEval(role: "primary" | "fallback" = "primary") {
    const state = await agents.getAgentStrategy();
    const agent = state.draftAgents.find((item) => item.id === "imageAgent")!;
    const id = `media_eval_${randomUUID().replace(/-/g, "")}`;
    const metadata = await artifacts.storeGoldenRemoteArtifacts(
      id,
      "image",
      ["https://cdn.example.test/golden-image.png"],
    );
    const binding = runner.candidateBindingFor(state, agent, role, "image-generation");
    const record: AgentEvalRecord = {
      id,
      createdAt: new Date().toISOString(),
      agentId: "imageAgent",
      candidateModel: runner.effectiveCandidateModel(agent, role, "image-generation"),
      provider: agent[role].provider,
      promptVersion: agent.promptVersion,
      testCase: "商品主体保真的竖屏素材图",
      output: "已生成 1 个 image 评测产物，等待人工 rubric 评审",
      latencyMs: 12_000,
      errored: false,
      jsonParsed: false,
      evaluationKind: "golden",
      status: "awaiting-human-review",
      caseId: "image.product-still-life.v1",
      ...binding,
      candidateRole: role,
      requestKind: "image-generation",
      structurePassed: null,
      qualityScore: null,
      actualCostUsd: null,
      artifactUrls: metadata.map((item) => item.url),
      artifactMetadata: metadata,
      criteria: [],
      reviewIssues: ["等待人工 rubric 评审"],
    };
    state.evals = [record, ...state.evals.filter((item) => item.id !== id)];
    await agents.saveAgentStrategy(state);
    return record;
  }

  afterAll(() => {
    delete process.env.APP_DATA_DIR;
    delete process.env.CLIPFORGE_LLM_API_KEY;
    delete process.env.CLIPFORGE_LLM_FALLBACK_API_KEY;
    delete process.env.CLIPFORGE_LLM_BASE_URL;
    delete process.env.CLIPFORGE_LLM_FALLBACK_BASE_URL;
    delete process.env.CLIPFORGE_IMAGE_API_KEY;
    delete process.env.CLIPFORGE_IMAGE_FALLBACK_API_KEY;
    delete process.env.CLIPFORGE_VIDEO_API_KEY;
    delete process.env.CLIPFORGE_VIDEO_FALLBACK_API_KEY;
    delete process.env.CLIPFORGE_TTS_API_KEY;
    delete process.env.CLIPFORGE_TTS_FALLBACK_API_KEY;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("requires an admin session and exposes fixture readiness", async () => {
    expect((await route.GET(request("http://localhost/api/admin/model-evals"))).status).toBe(401);
    const response = await route.GET(request("http://localhost/api/admin/model-evals", "GET", undefined, adminCookie));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    const payload = await response.json();
    expect(payload.golden.integrityPassed).toBe(true);
    expect(payload.golden.cases.find((item: { id: string }) => item.id === "product-analysis.juicer.zh.v1").ready).toBe(true);
    expect(payload.golden.cases.find((item: { id: string }) => item.id === "metrics-ocr.douyin-clear.zh.v1")).toMatchObject({ ready: false });
    expect(payload.golden.cases.find((item: { id: string }) => item.id === "image.product-still-life.v1")).toMatchObject({ ready: true, outputKind: "media" });
    expect(payload.golden.cases.find((item: { id: string }) => item.id === "video.product-orbit.v1")).toMatchObject({ ready: true, outputKind: "media" });
    expect(payload.golden.cases.find((item: { id: string }) => item.id === "tts.mandarin-product.zh.v1")).toMatchObject({ ready: true, outputKind: "media" });
  });

  it("returns 422 before any paid call for a disabled OCR fixture", async () => {
    const response = await route.POST(request("http://localhost/api/admin/model-evals", "POST", {
      agentId: "metrics-ocr",
      caseId: "metrics-ocr.douyin-clear.zh.v1",
      candidateRoles: ["primary"],
    }, adminCookie));
    expect(response.status).toBe(422);
    expect(openAiCreate).not.toHaveBeenCalled();
    expect(createProviderMock).not.toHaveBeenCalled();
    expect(generateSpeechMock).not.toHaveBeenCalled();
  });

  it("runs exact draft primary/fallback independently and persists Golden fields", async () => {
    const response = await route.POST(request("http://localhost/api/admin/model-evals", "POST", {
      agentId: "script",
      caseId: "script.tech-earbuds.zh.v1",
      promptVersion: "script-v1",
      candidateRoles: ["primary", "fallback"],
    }, adminCookie));
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.results).toHaveLength(2);
    expect(payload.results.map((item: { candidateRole: string }) => item.candidateRole)).toEqual(["primary", "fallback"]);
    expect(payload.results.every((item: Record<string, unknown>) =>
      item.caseId === "script.tech-earbuds.zh.v1"
      && item.requestKind === "chat-json"
      && item.structurePassed === true
      && item.qualityScore === 100
      && item.actualCostUsd === null
      && Array.isArray(item.artifactUrls))).toBe(true);
    expect(openAiCreate).toHaveBeenCalledTimes(2);
    expect(openAiCreate.mock.calls.map((call) => call[0].model)).toEqual(["draft-primary-eval", "draft-fallback-eval"]);

    const state = await agents.getAgentStrategy();
    expect(state.runs).toHaveLength(0);
    expect(state.evals.filter((item) => item.caseId === "script.tech-earbuds.zh.v1")).toHaveLength(2);
  });

  it("atomically enqueues async media and TTS one-shot jobs with 202/idempotency", async () => {
    const body = {
      agentId: "imageAgent",
      caseId: "image.product-still-life.v1",
      candidateRoles: ["primary", "fallback"],
    };
    const missingKey = await route.POST(request(
      "http://localhost/api/admin/model-evals",
      "POST",
      body,
      adminCookie,
    ));
    expect(missingKey.status).toBe(400);

    const key = operationKey();
    const imageResponse = await route.POST(request(
      "http://localhost/api/admin/model-evals",
      "POST",
      body,
      adminCookie,
      { "Idempotency-Key": key },
    ));
    expect(imageResponse.status).toBe(202);
    expect(imageResponse.headers.get("location")).toBe("/api/admin/model-evals");
    expect(imageResponse.headers.get("retry-after")).toBe("3");
    const imagePayload = await imageResponse.json();
    expect(imagePayload.jobs).toHaveLength(2);
    expect(imagePayload.jobs.map((item: { candidateRole: string }) => item.candidateRole)).toEqual(["primary", "fallback"]);
    expect(imagePayload.jobs.every((item: Record<string, unknown>) =>
      item.status === "pending"
      && item.taskIdCheckpointed === false
      && item.duplicate === false
      && !("payload" in item)
      && !("remoteTaskId" in item)
      && !("leaseToken" in item))).toBe(true);
    expect(JSON.stringify(imagePayload)).not.toContain("secretRef");
    expect(JSON.stringify(imagePayload)).not.toContain("test-image-primary-secret");

    const persisted = mediaJobs.getGoldenMediaEvalJob(imagePayload.jobs[0].id)!;
    expect(mediaJobs.buildGoldenMediaProviderConnection(persisted)).toMatchObject({
      provider: "atlas-cloud",
      model: "openai/gpt-image-2/edit",
      requestKind: "image-generation",
    });
    const driftedState = structuredClone(await agents.getAgentStrategy());
    driftedState.prompts = driftedState.prompts.map((prompt) =>
      prompt.agentId === "imageAgent" && prompt.version === driftedState.draftAgents.find((item) => item.id === "imageAgent")?.promptVersion
        ? { ...prompt, content: `${prompt.content}\n模拟入队后漂移` }
        : prompt);
    await expect(mediaJobs.buildGoldenMediaProviderRequest(persisted, driftedState)).rejects.toThrow(/已变更/);

    const replay = await route.POST(request(
      "http://localhost/api/admin/model-evals",
      "POST",
      body,
      adminCookie,
      { "Idempotency-Key": key },
    ));
    expect(replay.status).toBe(202);
    const replayPayload = await replay.json();
    expect(replayPayload.jobs.map((item: { id: string }) => item.id)).toEqual(
      imagePayload.jobs.map((item: { id: string }) => item.id),
    );
    expect(replayPayload.jobs.every((item: { duplicate: boolean }) => item.duplicate)).toBe(true);

    const videoResponse = await route.POST(request(
      "http://localhost/api/admin/model-evals",
      "POST",
      {
        agentId: "videoAgent",
        caseId: "video.product-orbit.v1",
        candidateRoles: ["fallback"],
      },
      adminCookie,
      { "Idempotency-Key": operationKey() },
    ));
    expect(videoResponse.status).toBe(202);
    expect((await videoResponse.json()).jobs[0]).toMatchObject({
      candidateRole: "fallback",
      model: "bytedance/seedance-2.0/image-to-video",
      requestKind: "video-generation",
      status: "pending",
    });

    const ttsResponse = await route.POST(request(
      "http://localhost/api/admin/model-evals",
      "POST",
      {
        agentId: "ttsAgent",
        caseId: "tts.mandarin-product.zh.v1",
        candidateRoles: ["primary"],
      },
      adminCookie,
      { "Idempotency-Key": operationKey() },
    ));
    expect(ttsResponse.status).toBe(202);
    expect((await ttsResponse.json()).jobs[0]).toMatchObject({
      candidateRole: "primary",
      model: "draft-tts-primary",
      requestKind: "tts-generation",
      status: "pending",
      taskIdCheckpointed: false,
    });

    const statusPayload = await (await route.GET(request(
      "http://localhost/api/admin/model-evals",
      "GET",
      undefined,
      adminCookie,
    ))).json();
    expect(statusPayload.mediaJobs.some((job: { id: string }) => job.id === imagePayload.jobs[0].id)).toBe(true);
    expect(mediaGenerateImage).not.toHaveBeenCalled();
    expect(mediaGenerateVideo).not.toHaveBeenCalled();
    expect(generateSpeechMock).not.toHaveBeenCalled();
    expect(createProviderMock).not.toHaveBeenCalled();
    expect(openAiCreate).not.toHaveBeenCalled();
  });

  it("serves artifacts only to admins and only under their owning eval record", async () => {
    const owner = await seedStoredImageEval("primary");
    const other = await seedStoredImageEval("fallback");
    const artifactId = owner.artifactUrls![0].split("/").at(-1)!;
    const artifactRequest = request(`http://localhost${owner.artifactUrls![0]}`, "GET");

    expect((await artifactRoute.GET(artifactRequest, {
      params: Promise.resolve({ evalId: owner.id, artifactId }),
    })).status).toBe(401);
    const allowed = await artifactRoute.GET(
      request(`http://localhost${owner.artifactUrls![0]}`, "GET", undefined, adminCookie),
      { params: Promise.resolve({ evalId: owner.id, artifactId }) },
    );
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get("cache-control")).toContain("no-store");
    expect(allowed.headers.get("content-type")).toBe("image/png");

    const crossRecord = await artifactRoute.GET(
      request(`http://localhost/api/admin/model-evals/artifacts/${other.id}/${artifactId}`, "GET", undefined, adminCookie),
      { params: Promise.resolve({ evalId: other.id, artifactId }) },
    );
    expect(crossRecord.status).toBe(404);
    const traversal = await artifactRoute.GET(
      request("http://localhost/api/admin/model-evals/artifacts/fake/secret", "GET", undefined, adminCookie),
      { params: Promise.resolve({ evalId: owner.id, artifactId: "..%2F..%2Fsqlite.db" }) },
    );
    expect(traversal.status).toBe(404);
  });

  it("saves a complete human media rubric only for a real artifact record", async () => {
    const state = await agents.getAgentStrategy();
    const imageAgent = state.draftAgents.find((item) => item.id === "imageAgent")!;
    state.evals.unshift({
      id: "media-eval-for-review",
      createdAt: new Date().toISOString(),
      agentId: "imageAgent",
      candidateModel: imageAgent.primary.model,
      provider: imageAgent.primary.provider,
      promptVersion: imageAgent.promptVersion,
      testCase: "商品主体保真的竖屏素材图",
      output: "待人工审核产物",
      latencyMs: 12_000,
      errored: false,
      jsonParsed: false,
      evaluationKind: "golden",
      status: "awaiting-human-review",
      caseId: "image.product-still-life.v1",
      candidateKey: `primary:${imageAgent.primary.provider}/${imageAgent.primary.model}@r${imageAgent.strategyRevision}`,
      candidateRole: "primary",
      requestKind: "image-generation",
      structurePassed: null,
      qualityScore: null,
      actualCostUsd: null,
      artifactUrls: ["/api/files/evals/image-result.png"],
    });
    await agents.saveAgentStrategy(state);

    const fakeResponse = await route.PATCH(request("http://localhost/api/admin/model-evals", "PATCH", {
      evalId: "media-eval-for-review",
      scores: { identity: 5, composition: 5, artifacts: 5, "prompt-fit": 5, safety: 5 },
    }, adminCookie));
    expect(fakeResponse.status).toBe(409);

    const generatedRecord = await seedStoredImageEval("primary");

    const response = await route.PATCH(request("http://localhost/api/admin/model-evals", "PATCH", {
      evalId: generatedRecord.id,
      scores: { identity: 5, composition: 5, artifacts: 5, "prompt-fit": 5, safety: 5 },
    }, adminCookie));
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.record).toMatchObject({ status: "completed", qualityScore: 100, structurePassed: null });
    expect(payload.record.humanScores).toEqual({ identity: 5, composition: 5, artifacts: 5, "prompt-fit": 5, safety: 5 });
  });

  it("rejects an incompatible media model before provider execution", async () => {
    const original = await agents.getAgentStrategy();
    const invalid = structuredClone(original);
    invalid.draftAgents = invalid.draftAgents.map((agent) => agent.id === "imageAgent"
      ? { ...agent, primary: { ...agent.primary, model: "openai/gpt-image-2" } }
      : agent);
    await agents.saveAgentStrategy(invalid);
    try {
      const response = await route.POST(request("http://localhost/api/admin/model-evals", "POST", {
        agentId: "imageAgent",
        caseId: "image.product-still-life.v1",
        candidateRoles: ["primary"],
      }, adminCookie, { "Idempotency-Key": operationKey() }));
      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({ code: "CANDIDATE_NOT_READY", candidateRole: "primary" });
      expect(createProviderMock).not.toHaveBeenCalled();
      expect(safeFetchMock).not.toHaveBeenCalled();
    } finally {
      await agents.saveAgentStrategy(original);
    }
  });

  it("re-hashes artifacts before human scoring and deletes record-owned files", async () => {
    const record = await seedStoredImageEval("primary");
    const artifactPath = join(dataDir, "admin-evals", record.artifactMetadata![0].filename);
    expect(existsSync(artifactPath)).toBe(true);
    appendFileSync(artifactPath, Buffer.from([0]));
    const review = await route.PATCH(request("http://localhost/api/admin/model-evals", "PATCH", {
      evalId: record.id,
      scores: { identity: 5, composition: 5, artifacts: 5, "prompt-fit": 5, safety: 5 },
    }, adminCookie));
    expect(review.status).toBe(409);

    const deleted = await route.DELETE(request("http://localhost/api/admin/model-evals", "DELETE", {
      evalId: record.id,
    }, adminCookie));
    expect(deleted.status).toBe(200);
    expect(existsSync(artifactPath)).toBe(false);
    expect((await agents.getAgentStrategy()).evals.some((item) => item.id === record.id)).toBe(false);
  });
});
