import { afterEach, describe, expect, it, vi } from "vitest";

const providerMocks = vi.hoisted(() => ({
  getTaskStatus: vi.fn(),
}));

vi.mock("@backend/providers", async (importOriginal) => {
  const original = await importOriginal<typeof import("@backend/providers")>();
  return {
    ...original,
    createProvider: vi.fn(() => ({ getTaskStatus: providerMocks.getTaskStatus })),
  };
});

import {
  assertDurableGoldenMediaMode,
  assertResumableGoldenMediaMode,
  GoldenMediaModeUnsupportedError,
  GoldenMediaPollRetryableError,
  GoldenMediaProviderRejectedError,
  GoldenMediaRateLimitedError,
  GoldenMediaSubmissionUncertainError,
  pollGoldenMediaTask,
  submitGoldenMediaTask,
  type GoldenMediaProviderRequest,
} from "@server/admin/evals/media-jobs/provider-adapter";

function request(
  provider = "atlas-cloud",
  requestKind: GoldenMediaProviderRequest["requestKind"] = "video-generation",
): GoldenMediaProviderRequest {
  return {
    provider,
    baseUrl: "https://93.184.216.34/api/v1",
    apiKey: "test-only-key",
    model: "vendor/model",
    requestKind,
    prompt: "locked prompt",
    referenceImageUrl: "data:image/png;base64,AAAA",
    width: 1080,
    height: 1920,
    count: 1,
    durationSeconds: 5,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("Golden 媒体异步 provider adapter", () => {
  it("同步生图与未验证模式在付费 fetch 前 fail-closed，TTS 只允许已审计 one-shot", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);

    expect(() => assertResumableGoldenMediaMode("volcengine", "image-generation"))
      .toThrow(GoldenMediaModeUnsupportedError);
    expect(() => assertResumableGoldenMediaMode("atlas", "tts-generation"))
      .toThrow(GoldenMediaModeUnsupportedError);
    expect(() => assertDurableGoldenMediaMode("openai", "tts-generation")).not.toThrow();
    expect(() => assertDurableGoldenMediaMode("volcengine", "tts-generation")).not.toThrow();
    expect(() => assertDurableGoldenMediaMode("unverified-tts", "tts-generation"))
      .toThrow(GoldenMediaModeUnsupportedError);
    await expect(submitGoldenMediaTask(request("siliconflow", "image-generation")))
      .rejects.toBeInstanceOf(GoldenMediaModeUnsupportedError);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("异步提交只 POST 一次并返回可持久化 taskId", async () => {
    const fetcher = vi.fn(async (...args: Parameters<typeof fetch>) => {
      void args;
      return new Response(JSON.stringify({ data: { id: "atlas-task-001" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetcher);

    await expect(submitGoldenMediaTask(request())).resolves.toBe("atlas-task-001");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ method: "POST", redirect: "manual" });
    expect(String(fetcher.mock.calls[0]?.[0])).toBe("https://93.184.216.34/api/v1/model/generateVideo");
  });

  it("fal taskId 冻结 modelId，便于重启后定位状态端点", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ request_id: "fal-request-001" }), { status: 200 }));
    vi.stubGlobal("fetch", fetcher);
    await expect(submitGoldenMediaTask(request("fal-ai", "image-generation")))
      .resolves.toBe("vendor/model::fal-request-001");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("明确 429 可按 Retry-After 安全延后，但 5xx、断网、2xx 缺 taskId 仍 uncertain", async () => {
    const rateLimitedFetch = vi.fn(async () => new Response(JSON.stringify({ request_id: "req-rate-001" }), {
      status: 429,
      headers: { "Content-Type": "application/json", "Retry-After": "120" },
    }));
    vi.stubGlobal("fetch", rateLimitedFetch);
    await expect(submitGoldenMediaTask(request())).rejects.toMatchObject({
      name: GoldenMediaRateLimitedError.name,
      retryAfterSeconds: 120,
      requestId: "req-rate-001",
    });
    expect(rateLimitedFetch).toHaveBeenCalledTimes(1);

    for (const response of [
      new Response("upstream failed", { status: 503 }),
      new Response(JSON.stringify({ data: {} }), { status: 200 }),
    ]) {
      const fetcher = vi.fn(async () => response);
      vi.stubGlobal("fetch", fetcher);
      await expect(submitGoldenMediaTask(request())).rejects.toBeInstanceOf(
        GoldenMediaSubmissionUncertainError,
      );
      expect(fetcher).toHaveBeenCalledTimes(1);
    }

    const fetcher = vi.fn(async () => Promise.reject(new TypeError("socket reset")));
    vi.stubGlobal("fetch", fetcher);
    await expect(submitGoldenMediaTask(request())).rejects.toBeInstanceOf(
      GoldenMediaSubmissionUncertainError,
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("明确 4xx 拒绝和重定向不伪装成可重试任务", async () => {
    for (const status of [400, 302]) {
      const fetcher = vi.fn(async () => new Response("rejected", { status }));
      vi.stubGlobal("fetch", fetcher);
      await expect(submitGoldenMediaTask(request())).rejects.toBeInstanceOf(
        GoldenMediaProviderRejectedError,
      );
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });

  it("4xx 只解析受限白名单诊断，保留安全分类/requestId 且不泄漏原始 message", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      error: {
        code: "InputImageSensitiveContentDetected",
        message: "safety moderation blocked apiKey=sk-super-secret-value",
        request_id: "req-safety-001",
        prompt: "must-never-persist",
      },
    }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetcher);

    const error = await submitGoldenMediaTask(request()).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GoldenMediaProviderRejectedError);
    expect(error).toMatchObject({
      code: "InputImageSensitiveContentDetected",
      category: "safety",
      requestId: "req-safety-001",
    });
    expect(String((error as Error).message)).not.toContain("sk-super-secret-value");
    expect(String((error as Error).message)).not.toContain("must-never-persist");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("媒体评测端点指向私网时不发出付费请求", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);

    await expect(submitGoldenMediaTask({
      ...request(),
      baseUrl: "https://127.0.0.1/api/v1",
    })).rejects.toBeInstanceOf(GoldenMediaSubmissionUncertainError);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("轮询每次只发一次 GET 状态语义，不在 HTTP 请求内 sleep", async () => {
    providerMocks.getTaskStatus.mockResolvedValueOnce({
      taskId: "remote-1",
      status: "processing",
      progress: 42,
    });
    await expect(pollGoldenMediaTask(request(), "remote-1")).resolves.toEqual({
      state: "pending",
      progress: 42,
    });
    expect(providerMocks.getTaskStatus).toHaveBeenCalledTimes(1);

    providerMocks.getTaskStatus.mockResolvedValueOnce({
      taskId: "remote-1",
      status: "completed",
      result: { taskId: "remote-1", videoUrls: ["https://cdn.example/out.mp4"], modelId: "" },
    });
    await expect(pollGoldenMediaTask(request(), "remote-1")).resolves.toMatchObject({
      state: "completed",
      remoteUrls: ["https://cdn.example/out.mp4"],
    });
    expect(providerMocks.getTaskStatus).toHaveBeenCalledTimes(2);
  });

  it("状态查询 4xx 也不推断远程付费任务已失败", async () => {
    providerMocks.getTaskStatus.mockRejectedValueOnce(
      Object.assign(new Error("unauthorized"), { statusCode: 401, code: "API_ERROR" }),
    );
    await expect(pollGoldenMediaTask(request(), "remote-paid-task"))
      .rejects.toBeInstanceOf(GoldenMediaPollRetryableError);
    expect(providerMocks.getTaskStatus).toHaveBeenCalledTimes(1);
  });
});
