import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import { ProviderError } from "@backend/providers/base";

const mocks = vi.hoisted(() => ({
  runAgentOperation: vi.fn(),
  classifyAgentError: vi.fn((error: unknown) => {
    const raw = error && typeof error === "object" ? error as { status?: number; message?: string; name?: string } : {};
    const message = `${raw.name ?? ""} ${raw.message ?? String(error ?? "")}`;
    if (/safety|sensitive|安全|内容审核/i.test(message)) {
      return { category: "safety", fallbackAllowed: false, reason: "供应商内容安全策略拒绝" };
    }
    if (/未配置|configuration/i.test(message)) {
      return { category: "configuration", fallbackAllowed: false, reason: "模型配置无效或不完整" };
    }
    if (raw.status === 402 || /insufficient.*(?:quota|balance|credit)|billing|余额不足/i.test(message)) {
      return { category: "billing", fallbackAllowed: true, reason: "供应商余额或额度不足" };
    }
    if (raw.status === 429 || /rate.?limit|too many requests/i.test(message)) {
      return { category: "rate_limit", fallbackAllowed: true, reason: "供应商请求限流" };
    }
    if ((raw.status ?? 0) >= 500 || /service unavailable/i.test(message)) {
      return { category: "provider_5xx", fallbackAllowed: true, reason: "供应商服务暂时异常" };
    }
    if (/timeout|timed out/i.test(message)) {
      return { category: "timeout", fallbackAllowed: true, reason: "供应商请求超时" };
    }
    if (/network|fetch failed/i.test(message)) {
      return { category: "network", fallbackAllowed: true, reason: "供应商网络连接失败" };
    }
    if (raw.name === "SyntaxError" || /json.*parse|无法解析/i.test(message)) {
      return { category: "parse", fallbackAllowed: true, reason: "供应商响应结构无法解析" };
    }
    if ((raw.status ?? 0) >= 400) {
      return { category: "client_4xx", fallbackAllowed: false, reason: "供应商拒绝当前请求" };
    }
    return { category: "unknown", fallbackAllowed: false, reason: "供应商请求结果未知" };
  }),
  reportTelemetry: vi.fn(),
  generateScript: vi.fn(),
  buildTemplateProductScript: vi.fn(),
  analyzeProduct: vi.fn(),
  generateTopicScript: vi.fn(),
  buildTemplateTopicScript: vi.fn(),
  createProvider: vi.fn(),
  generateImage: vi.fn(),
  generateVideo: vi.fn(),
  toRemoteUsableImage: vi.fn(),
  getDb: vi.fn(),
  requireOwnedProject: vi.fn(),
  createGenerationOperation: vi.fn(() => ({ duplicate: false })),
  failBeforeClaim: vi.fn(() => true),
}));

const FAKE_MERCHANT = { id: "test-merchant", email: "test@example.com", shopName: null, planId: "trial" };
const ORIGINAL_DEPLOYMENT_MODE = process.env.HUIMAI_DEPLOYMENT_MODE;
const ORIGINAL_SINGLE_USER = process.env.CLIPFORGE_SINGLE_USER;

vi.mock("@backend/core/agent/agent-strategy", () => ({
  runAgentOperation: mocks.runAgentOperation,
}));

vi.mock("@server/admin/agents", () => ({
  runAgentOperation: mocks.runAgentOperation,
  classifyAgentError: mocks.classifyAgentError,
}));

// 这份测试只关心"路由是否忽略请求体里的 llmConfig、改走线上 Agent 策略"，
// 商家鉴权/配额计量是另一回事，这里直接短路成固定商家 + 直通到 mocks.runAgentOperation。
vi.mock("@backend/core/auth/require-merchant", () => ({
  requireMerchant: vi.fn(async () => ({ merchant: FAKE_MERCHANT })),
  requireOwnedProject: mocks.requireOwnedProject,
}));

vi.mock("@backend/core/auth/usage", () => ({
  runMeteredAgentOperation: vi.fn((_merchantId: string, agentId: string, label: string, op: unknown) =>
    mocks.runAgentOperation(agentId, label, op)
  ),
  runGenerationOperationItem: vi.fn(async (
    _merchantId: string,
    options: { agentId: string; userLabel: string; operationKey: string },
    op: unknown,
  ) => ({
    value: await mocks.runAgentOperation(options.agentId, options.userLabel, op),
    replayed: false,
    operationId: options.operationKey,
  })),
  createGenerationOperation: mocks.createGenerationOperation,
  failGenerationOperationItemBeforeClaim: mocks.failBeforeClaim,
  completeGenerationOperationItemFromCache: vi.fn((_merchantId: string, options: { operationKey: string }, value: unknown) => ({
    value,
    replayed: false,
    operationId: options.operationKey,
  })),
  hashGenerationRequest: vi.fn((value: unknown) => JSON.stringify(value)),
  safeGenerationErrorMessage: vi.fn((error: unknown, fallback = "生成失败") => error instanceof Error ? error.message : fallback),
  QuotaExceededError: class QuotaExceededError extends Error {},
  InvalidGenerationOperationError: class InvalidGenerationOperationError extends Error {},
  GenerationOperationConflictError: class GenerationOperationConflictError extends Error {},
  GenerationItemInProgressError: class GenerationItemInProgressError extends Error {},
  GenerationItemFailedError: class GenerationItemFailedError extends Error {},
  GenerationItemLeaseLostError: class GenerationItemLeaseLostError extends Error {},
}));

vi.mock("@backend/script-engine/generator", () => ({
  generateScript: mocks.generateScript,
  buildTemplateProductScript: mocks.buildTemplateProductScript,
  analyzeProduct: mocks.analyzeProduct,
  generateTopicScript: mocks.generateTopicScript,
  buildTemplateTopicScript: mocks.buildTemplateTopicScript,
}));

vi.mock("@backend/providers", () => ({
  createProvider: mocks.createProvider,
}));

vi.mock("@backend/shared/remote-image", () => ({
  toRemoteUsableImage: mocks.toRemoteUsableImage,
}));

vi.mock("@backend/db", () => ({
  getDb: mocks.getDb,
}));

import { POST as imagePost } from "@/app/api/ai/image/route";
import { POST as videoPost } from "@/app/api/ai/video/route";
import { POST as scriptPost } from "@/app/api/llm/script/route";
import { POST as topicScriptPost } from "@/app/api/topic/script/route";

function jsonRequest(body: unknown): NextRequest {
  return new Request("http://localhost/test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

function mockDb() {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(async () => [{ id: "topic-project", contentType: "topic", merchantId: FAKE_MERCHANT.id }]),
      })),
    })),
    delete: vi.fn(() => ({ where: vi.fn(async () => undefined) })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({ where: vi.fn(async () => undefined) })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn((values: unknown) => ({
        returning: vi.fn(async () => {
          const rows = Array.isArray(values) ? values : [values];
          return rows.map((value, index) => {
            const row = value as Record<string, unknown>;
            return {
              id: `row-${index + 1}`,
              title: row.title ?? "",
              styleType: row.styleType ?? "custom",
              totalDuration: row.totalDuration ?? 0,
              shots: row.shots ?? [],
              selected: row.selected ?? false,
              contentType: row.contentType,
            };
          });
        }),
      })),
    })),
  };
}

describe("ordinary generation routes use published Agent strategy", () => {
  beforeEach(() => {
    process.env.HUIMAI_DEPLOYMENT_MODE = "saas";
    delete process.env.CLIPFORGE_SINGLE_USER;
    vi.clearAllMocks();
    mocks.getDb.mockReturnValue(mockDb());
    mocks.createProvider.mockReturnValue({
      generateImage: mocks.generateImage,
      generateVideo: mocks.generateVideo,
    });
    mocks.toRemoteUsableImage.mockImplementation(async (url?: string) => url);
    mocks.requireOwnedProject.mockResolvedValue({ ok: true });
    const templateDraft = [{
      title: "【占位草稿】测试",
      styleType: "custom",
      totalDuration: 20,
      shots: [{
        shotId: 1,
        type: "hook",
        duration: 20,
        description: "【待人工补充｜不可直接发布】",
        camera: "static",
        visualSource: "ai_generate",
        transition: "direct_concat",
        voiceover: "【待人工补充｜不可直接发布】",
      }],
    }];
    mocks.buildTemplateProductScript.mockReturnValue(templateDraft);
    mocks.buildTemplateTopicScript.mockReturnValue(templateDraft);
  });

  afterAll(() => {
    if (ORIGINAL_DEPLOYMENT_MODE === undefined) delete process.env.HUIMAI_DEPLOYMENT_MODE;
    else process.env.HUIMAI_DEPLOYMENT_MODE = ORIGINAL_DEPLOYMENT_MODE;
    if (ORIGINAL_SINGLE_USER === undefined) delete process.env.CLIPFORGE_SINGLE_USER;
    else process.env.CLIPFORGE_SINGLE_USER = ORIGINAL_SINGLE_USER;
  });

  it("/api/llm/script ignores request llmConfig and uses the script Agent runtime config", async () => {
    mocks.runAgentOperation.mockImplementationOnce(async (_agentId, _label, operation) =>
      operation(
        { provider: "openai-compatible", baseUrl: "https://agent.llm", apiKey: "agent-key", model: "agent-model" },
        "script system prompt",
        false,
      ),
    );
    mocks.generateScript.mockResolvedValueOnce([
      { title: "Agent script", styleType: "pain_point", totalDuration: 30, shots: [] },
    ]);

    const res = await scriptPost(jsonRequest({
      productName: "氨基酸洁面乳",
      llmConfig: { baseUrl: "https://user.example", apiKey: "user-key", model: "user-model" },
    }));
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.scripts).toHaveLength(1);
    expect(mocks.runAgentOperation).toHaveBeenCalledWith("script", "氨基酸洁面乳", expect.any(Function));
    const input = mocks.generateScript.mock.calls[0][0];
    expect(input.llmConfig).toMatchObject({
      baseUrl: "https://agent.llm",
      apiKey: "agent-key",
      model: "agent-model",
    });
    expect(input.llmConfig.model).not.toBe("user-model");
    expect(input.systemPrompt).toBe("script system prompt");
  });

  it("/api/topic/script ignores request llmConfig and uses the topic-script Agent runtime config", async () => {
    mocks.runAgentOperation.mockImplementationOnce(async (_agentId, _label, operation) =>
      operation(
        { provider: "openai-compatible", baseUrl: "https://topic.agent", apiKey: "topic-key", model: "topic-model" },
        "topic system prompt",
        false,
      ),
    );
    mocks.generateTopicScript.mockResolvedValueOnce([
      { title: "Topic script", totalDuration: 25, shots: [] },
    ]);

    const res = await topicScriptPost(jsonRequest({
      projectId: "topic-project",
      topic: "下班后的十分钟自我修复",
      llmConfig: { baseUrl: "https://user.example", apiKey: "user-key", model: "user-model" },
    }));
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.projectId).toBe("topic-project");
    expect(mocks.runAgentOperation).toHaveBeenCalledWith("topic-script", "topic-project", expect.any(Function));
    const input = mocks.generateTopicScript.mock.calls[0][0];
    expect(input.llmConfig).toMatchObject({
      baseUrl: "https://topic.agent",
      apiKey: "topic-key",
      model: "topic-model",
    });
    expect(input.llmConfig.model).not.toBe("user-model");
    expect(input.systemPrompt).toBe("topic system prompt");
  });

  it("/api/ai/image ignores user provider fields and calls the image Agent provider config", async () => {
    mocks.runAgentOperation.mockImplementationOnce(async (_agentId, _label, operation) =>
      operation(
        {
          provider: "atlas-cloud",
          baseUrl: "https://agent.image",
          apiKey: "agent-image-key",
          model: "openai/gpt-image-2/text-to-image",
        },
        "image system prompt",
        false,
        { reportTelemetry: mocks.reportTelemetry },
      ),
    );
    mocks.toRemoteUsableImage.mockResolvedValueOnce("https://files.example/product.png");
    mocks.generateImage.mockResolvedValueOnce({
      imageUrls: ["https://cdn.example/image.png"],
      duration: 1200,
      seed: 42,
      modelId: "should-not-leak",
    });

    const res = await imagePost(jsonRequest({
      projectId: "owned-project",
      mode: "image-to-image",
      prompt: "保持商品不变，换成厨房场景",
      imageUrl: "/api/files/owned-project/product.png",
      provider: "user-provider",
      model: "user-model",
      apiKey: "user-key",
      baseUrl: "https://user.example",
      options: {
        size: "1024x1024",
        count: 999,
        modelId: "user-expensive-model",
        prompt: "user override",
      },
    }));
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(mocks.runAgentOperation).toHaveBeenCalledWith("imageAgent", "image:保持商品不变，换成厨房场景", expect.any(Function));
    expect(mocks.createProvider).toHaveBeenCalledWith({
      name: "atlas-cloud",
      apiKey: "agent-image-key",
      baseUrl: "https://agent.image",
    });
    expect(mocks.generateImage).toHaveBeenCalledWith(expect.objectContaining({
      modelId: "openai/gpt-image-2/edit",
      prompt: "保持商品不变，换成厨房场景",
      referenceImageUrl: "https://files.example/product.png",
      count: 1,
    }));
    expect(mocks.reportTelemetry).toHaveBeenCalledWith({ effectiveModel: "openai/gpt-image-2/edit" });
    expect(data).toMatchObject({ imageUrls: ["https://cdn.example/image.png"], duration: 1200, seed: 42 });
    expect(data.modelId).toBeUndefined();
    expect(data.provider).toBeUndefined();
  });

  it("/api/ai/image 遇到 ModelNotOpen 不在路由内偷换 Seedream 4，失败交回 Agent 控制面", async () => {
    mocks.runAgentOperation.mockImplementationOnce(async (_agentId, _label, operation) =>
      operation(
        {
          provider: "volcengine",
          baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
          apiKey: "agent-image-key",
          model: "doubao-seedream-5-0-260128",
        },
        "image system prompt",
        false,
        { reportTelemetry: mocks.reportTelemetry },
      ),
    );
    mocks.generateImage.mockRejectedValueOnce(new Error("ModelNotOpen: not activated the model service"));

    const res = await imagePost(jsonRequest({
      projectId: "owned-project",
      mode: "text-to-image",
      prompt: "生成真实商品图",
    }));

    expect(res.status).toBe(500);
    expect(mocks.generateImage).toHaveBeenCalledTimes(1);
    expect(mocks.generateImage).toHaveBeenCalledWith(expect.objectContaining({
      modelId: "doubao-seedream-5-0-260128",
    }));
    expect(mocks.generateImage).not.toHaveBeenCalledWith(expect.objectContaining({
      modelId: "doubao-seedream-4-0-250828",
    }));
    expect(mocks.reportTelemetry).toHaveBeenCalledWith({ effectiveModel: "doubao-seedream-5-0-260128" });
  });

  it.each([
    ["timeout", new Error("request timeout")],
    ["parse", new SyntaxError("JSON parse failed")],
    ["provider billing", Object.assign(new Error("insufficient quota"), { status: 402 })],
    ["safety", new Error("sensitive content safety rejection")],
    ["client 4xx", Object.assign(new Error("bad request"), { status: 400 })],
    ["unknown", new Error("something unexpected")],
  ])("SaaS /api/llm/script 的 %s 错误统一 fail-close，不生成本地模板", async (_name, error) => {
    mocks.runAgentOperation.mockRejectedValueOnce(error);

    const res = await scriptPost(jsonRequest({
      productName: "测试商品",
      count: 1,
      quick: true,
    }));
    const data = await res.json();

    expect(res.status).toBe(500);
    expect(mocks.buildTemplateProductScript).not.toHaveBeenCalled();
    expect(data.warning).toBeUndefined();
  });

  it.each([
    ["network", new Error("network error")],
    ["parse", new SyntaxError("JSON parse failed")],
    ["provider billing", Object.assign(new Error("insufficient quota"), { status: 402 })],
    ["safety", new Error("内容审核 safety rejection")],
    ["client 4xx", Object.assign(new Error("bad request"), { status: 422 })],
    ["unknown", new Error("unexpected topic failure")],
  ])("SaaS /api/topic/script 的 %s 错误统一 fail-close，不生成本地模板", async (_name, error) => {
    mocks.runAgentOperation.mockRejectedValueOnce(error);

    const res = await topicScriptPost(jsonRequest({
      projectId: "topic-project",
      topic: "测试主题",
      count: 1,
    }));
    const data = await res.json();

    expect(res.status).toBe(500);
    expect(mocks.buildTemplateTopicScript).not.toHaveBeenCalled();
    expect(data.warning).toBeUndefined();
  });

  it.each([
    ["timeout", new Error("request timeout"), true],
    ["parse", new SyntaxError("JSON parse failed"), true],
    ["provider billing", Object.assign(new Error("insufficient quota"), { status: 402 }), true],
    ["safety", new Error("sensitive content safety rejection"), false],
    ["client 4xx", Object.assign(new Error("bad request"), { status: 400 }), false],
    ["unknown", new Error("something unexpected"), false],
  ])("显式 desktop single-user 下 /api/llm/script 的 %s 错误仍按分类决定占位草稿", async (_name, error, allowed) => {
    process.env.HUIMAI_DEPLOYMENT_MODE = "desktop";
    process.env.CLIPFORGE_SINGLE_USER = "1";
    mocks.runAgentOperation.mockRejectedValueOnce(error);

    const res = await scriptPost(jsonRequest({
      productName: "测试商品",
      count: 1,
      quick: true,
    }));
    const data = await res.json();

    expect(res.status).toBe(allowed ? 200 : 500);
    expect(mocks.buildTemplateProductScript).toHaveBeenCalledTimes(allowed ? 1 : 0);
    if (allowed) expect(data.warning).toMatch(/不可直接发布/);
    else expect(data.warning).toBeUndefined();
  });

  it("仅设置 desktop、未显式开启 single-user 时仍禁止本地模板", async () => {
    process.env.HUIMAI_DEPLOYMENT_MODE = "desktop";
    delete process.env.CLIPFORGE_SINGLE_USER;
    mocks.runAgentOperation.mockRejectedValueOnce(new Error("request timeout"));

    const res = await scriptPost(jsonRequest({
      productName: "测试商品",
      count: 1,
      quick: true,
    }));

    expect(res.status).toBe(500);
    expect(mocks.buildTemplateProductScript).not.toHaveBeenCalled();
  });

  it.each([
    ["network", new Error("network error"), true],
    ["safety", new Error("内容审核 safety rejection"), false],
  ])("显式 desktop single-user 下 /api/topic/script 的 %s 错误仍按分类决定占位草稿", async (_name, error, allowed) => {
    process.env.HUIMAI_DEPLOYMENT_MODE = "desktop";
    process.env.CLIPFORGE_SINGLE_USER = "1";
    mocks.runAgentOperation.mockRejectedValueOnce(error);

    const res = await topicScriptPost(jsonRequest({
      projectId: "topic-project",
      topic: "测试主题",
      count: 1,
    }));
    const data = await res.json();

    expect(res.status).toBe(allowed ? 200 : 500);
    expect(mocks.buildTemplateTopicScript).toHaveBeenCalledTimes(allowed ? 1 : 0);
    if (allowed) expect(data.warning).toMatch(/不可直接发布/);
    else expect(data.warning).toBeUndefined();
  });

  it("/api/ai/video ignores user provider fields and calls the video Agent provider config", async () => {
    mocks.runAgentOperation.mockImplementationOnce(async (_agentId, _label, operation) =>
      operation(
        {
          provider: "atlas-cloud",
          baseUrl: "https://agent.video",
          apiKey: "agent-video-key",
          model: "bytedance/seedance-2.0/text-to-video",
        },
        "video system prompt",
        false,
      ),
    );
    mocks.toRemoteUsableImage.mockResolvedValueOnce("https://files.example/frame.png");
    mocks.generateVideo.mockResolvedValueOnce({
      videoUrls: ["https://cdn.example/video.mp4"],
      coverImageUrl: "https://cdn.example/cover.jpg",
      duration: 5,
      processingTime: 2200,
      hasAudio: true,
      modelId: "should-not-leak",
    });

    const res = await videoPost(jsonRequest({
      projectId: "owned-project",
      mode: "image-to-video",
      prompt: "镜头缓慢推进",
      imageUrl: "/api/files/owned-project/frame.png",
      provider: "user-provider",
      model: "user-model",
      apiKey: "user-key",
      baseUrl: "https://user.example",
      options: {
        duration: 5,
        modelId: "user-expensive-model",
        prompt: "user override",
        firstFrameUrl: "https://attacker.example/first.png",
        lastFrameUrl: "https://attacker.example/last.png",
        audioEnabled: true,
        extra: { expensiveVendorMode: true },
      },
    }));
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(mocks.runAgentOperation).toHaveBeenCalledWith("videoAgent", "video:镜头缓慢推进", expect.any(Function));
    expect(mocks.createProvider).toHaveBeenCalledWith({
      name: "atlas-cloud",
      apiKey: "agent-video-key",
      baseUrl: "https://agent.video",
    });
    expect(mocks.generateVideo).toHaveBeenCalledWith(expect.objectContaining({
      modelId: "bytedance/seedance-2.0/image-to-video",
      prompt: "镜头缓慢推进",
      firstFrameUrl: "https://files.example/frame.png",
      lastFrameUrl: undefined,
    }));
    expect(mocks.generateVideo.mock.calls[0][0]).not.toHaveProperty("audioEnabled");
    expect(mocks.generateVideo.mock.calls[0][0]).not.toHaveProperty("extra");
    expect(data).toMatchObject({
      videoUrls: ["https://cdn.example/video.mp4"],
      coverImageUrl: "https://cdn.example/cover.jpg",
      duration: 5,
      processingTime: 2200,
      hasAudio: true,
    });
    expect(data.modelId).toBeUndefined();
    expect(data.provider).toBeUndefined();
  });

  it.each([
    ["image", imagePost, { prompt: "生成商品图" }],
    ["video", videoPost, { prompt: "生成商品视频" }],
  ] as const)("/api/ai/%s 缺少 projectId 时在项目和 provider 调用前拒绝", async (_name, post, body) => {
    const res = await post(jsonRequest(body));

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: "缺少 projectId" });
    expect(mocks.requireOwnedProject).not.toHaveBeenCalled();
    expect(mocks.toRemoteUsableImage).not.toHaveBeenCalled();
    expect(mocks.runAgentOperation).not.toHaveBeenCalled();
    expect(mocks.createProvider).not.toHaveBeenCalled();
    expect(mocks.generateImage).not.toHaveBeenCalled();
    expect(mocks.generateVideo).not.toHaveBeenCalled();
  });

  it("批量 item 在 provider claim 前被请求校验拒绝时显式收口账本子项", async () => {
    const res = await imagePost(jsonRequest({
      projectId: "owned-project",
      prompt: "",
      operationId: "image-batch:preflight-001",
      operationType: "image-batch",
      itemKey: "shot:1",
    }));

    expect(res.status).toBe(400);
    expect(mocks.failBeforeClaim).toHaveBeenCalledWith(FAKE_MERCHANT.id, expect.objectContaining({
      operationKey: "image-batch:preflight-001",
      operationType: "image-batch",
      itemKey: "shot:1",
      agentId: "imageAgent",
      projectId: "owned-project",
      failureCode: "invalid_prompt_before_claim",
    }));
    expect(mocks.runAgentOperation).not.toHaveBeenCalled();
  });

  it("视频付费提交结果不确定时不会由首尾帧模式自动重提", async () => {
    mocks.runAgentOperation.mockImplementationOnce(async (_agentId, _label, operation) =>
      operation({
        provider: "atlas-cloud",
        baseUrl: "https://agent.video",
        apiKey: "agent-video-key",
        model: "bytedance/seedance-2.0/image-to-video",
      }, "", false, { reportTelemetry: mocks.reportTelemetry }),
    );
    mocks.toRemoteUsableImage
      .mockResolvedValueOnce("https://files.example/first.png")
      .mockResolvedValueOnce("https://files.example/last.png");
    mocks.generateVideo.mockRejectedValueOnce(new ProviderError(
      "供应商提交结果未知",
      "SUBMISSION_UNCERTAIN",
      "atlas-cloud",
    ));

    const res = await videoPost(jsonRequest({
      projectId: "owned-project",
      mode: "image-to-video",
      prompt: "首尾帧测试",
      imageUrl: "/api/files/owned-project/first.png",
      lastFrameUrl: "/api/files/owned-project/last.png",
    }));

    expect(res.status).toBe(500);
    expect(mocks.generateVideo).toHaveBeenCalledTimes(1);
  });

  it("视频安全拦截不会通过移除尾帧自动重提", async () => {
    mocks.runAgentOperation.mockImplementationOnce(async (_agentId, _label, operation) =>
      operation({
        provider: "atlas-cloud",
        baseUrl: "https://agent.video",
        apiKey: "agent-video-key",
        model: "bytedance/seedance-2.0/image-to-video",
      }, "", false, { reportTelemetry: mocks.reportTelemetry }),
    );
    mocks.toRemoteUsableImage
      .mockResolvedValueOnce("https://files.example/first.png")
      .mockResolvedValueOnce("https://files.example/last.png");
    mocks.generateVideo.mockRejectedValueOnce(new ProviderError(
      "InputImageSensitiveContentDetected: last frame blocked by safety",
      "CONTENT_POLICY",
      "atlas-cloud",
      400,
    ));

    const res = await videoPost(jsonRequest({
      projectId: "owned-project",
      mode: "image-to-video",
      prompt: "安全拒绝测试",
      imageUrl: "/api/files/owned-project/first.png",
      lastFrameUrl: "/api/files/owned-project/last.png",
    }));

    expect(res.status).toBe(500);
    expect(mocks.generateVideo).toHaveBeenCalledTimes(1);
    expect(mocks.reportTelemetry).toHaveBeenCalledWith({
      effectiveModel: "bytedance/seedance-2.0/image-to-video",
    });
  });

  it("/api/ai/image 的跨项目本地参考图在 provider 调用前返回 404", async () => {
    const res = await imagePost(jsonRequest({
      projectId: "owned-project",
      prompt: "生成商品图",
      mode: "image-to-image",
      imageUrl: "/api/files/other-project/secret.png",
    }));

    expect(res.status).toBe(404);
    expect(mocks.requireOwnedProject).toHaveBeenCalledWith(FAKE_MERCHANT.id, "owned-project");
    expect(mocks.toRemoteUsableImage).not.toHaveBeenCalled();
    expect(mocks.runAgentOperation).not.toHaveBeenCalled();
    expect(mocks.createProvider).not.toHaveBeenCalled();
    expect(mocks.generateImage).not.toHaveBeenCalled();
  });

  it("/api/ai/video 的跨项目首尾帧在 provider 调用前返回 404", async () => {
    const res = await videoPost(jsonRequest({
      projectId: "owned-project",
      prompt: "生成商品视频",
      mode: "image-to-video",
      imageUrl: "/api/files/owned-project/first.png",
      lastFrameUrl: "/api/files/other-project/secret.png",
    }));

    expect(res.status).toBe(404);
    expect(mocks.requireOwnedProject).toHaveBeenCalledWith(FAKE_MERCHANT.id, "owned-project");
    expect(mocks.toRemoteUsableImage).not.toHaveBeenCalled();
    expect(mocks.runAgentOperation).not.toHaveBeenCalled();
    expect(mocks.createProvider).not.toHaveBeenCalled();
    expect(mocks.generateVideo).not.toHaveBeenCalled();
  });
});
