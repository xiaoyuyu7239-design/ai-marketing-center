import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  runAgentOperation: vi.fn(),
  generateScript: vi.fn(),
  analyzeProduct: vi.fn(),
  generateTopicScript: vi.fn(),
  createProvider: vi.fn(),
  generateImage: vi.fn(),
  generateVideo: vi.fn(),
  toRemoteUsableImage: vi.fn(),
  getDb: vi.fn(),
}));

vi.mock("@backend/core/agent/agent-strategy", () => ({
  runAgentOperation: mocks.runAgentOperation,
}));

vi.mock("@server/admin/agents", () => ({
  runAgentOperation: mocks.runAgentOperation,
}));

vi.mock("@backend/script-engine/generator", () => ({
  generateScript: mocks.generateScript,
  analyzeProduct: mocks.analyzeProduct,
  generateTopicScript: mocks.generateTopicScript,
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
        where: vi.fn(async () => [{ id: "topic-project", contentType: "topic" }]),
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
    vi.clearAllMocks();
    mocks.getDb.mockReturnValue(mockDb());
    mocks.createProvider.mockReturnValue({
      generateImage: mocks.generateImage,
      generateVideo: mocks.generateVideo,
    });
    mocks.toRemoteUsableImage.mockImplementation(async (url?: string) => url);
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
      mode: "image-to-image",
      prompt: "保持商品不变，换成厨房场景",
      imageUrl: "/api/files/project/product.png",
      provider: "user-provider",
      model: "user-model",
      apiKey: "user-key",
      baseUrl: "https://user.example",
      options: { size: "1024x1024" },
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
      referenceImageUrl: "https://files.example/product.png",
    }));
    expect(data).toMatchObject({ imageUrls: ["https://cdn.example/image.png"], duration: 1200, seed: 42 });
    expect(data.modelId).toBeUndefined();
    expect(data.provider).toBeUndefined();
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
      mode: "image-to-video",
      prompt: "镜头缓慢推进",
      imageUrl: "/api/files/project/frame.png",
      provider: "user-provider",
      model: "user-model",
      apiKey: "user-key",
      baseUrl: "https://user.example",
      options: { duration: 5 },
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
      firstFrameUrl: "https://files.example/frame.png",
    }));
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
});
