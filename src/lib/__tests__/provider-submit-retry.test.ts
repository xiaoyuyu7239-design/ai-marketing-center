import { afterEach, describe, expect, it, vi } from "vitest";

import { classifyAgentError } from "@server/admin/agents/service";
import {
  BaseProvider,
  ProviderError,
  toSafeProviderErrorDto,
} from "@backend/providers/base";
import { VolcEngineProvider } from "@backend/providers/volcengine";
import type {
  ImageResult,
  Model,
  TaskStatus,
  VideoResult,
} from "@backend/providers/types";

class ProbeProvider extends BaseProvider {
  readonly name = "probe";
  readonly displayName = "Probe";

  call(method: "GET" | "POST", retry?: "safe" | "always" | "never") {
    return this.request<{ ok: boolean }>("/tasks", {
      method,
      ...(method === "POST" ? { body: { prompt: "fixed" } } : {}),
      ...(retry ? { retry } : {}),
    });
  }

  async generateImage(): Promise<ImageResult> {
    throw new Error("not used");
  }

  async generateVideo(): Promise<VideoResult> {
    throw new Error("not used");
  }

  async getTaskStatus(): Promise<TaskStatus> {
    throw new Error("not used");
  }

  async listModels(): Promise<Model[]> {
    return [];
  }
}

function provider() {
  return new ProbeProvider({
    name: "probe",
    apiKey: "test-only",
    baseUrl: "https://93.184.216.34",
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("付费提交重试安全", () => {
  it("POST 收到 5xx 时只发送一次，并标记为提交结果不确定", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("upstream failed", { status: 502, statusText: "Bad Gateway" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(provider().call("POST")).rejects.toMatchObject({
      code: "SUBMISSION_UNCERTAIN",
      provider: "probe",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("POST 断网时只发送一次，且 Agent 不允许跨供应商 fallback", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    vi.stubGlobal("fetch", fetchMock);

    let caught: unknown;
    try {
      await provider().call("POST");
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ProviderError);
    expect(caught).toMatchObject({ code: "SUBMISSION_UNCERTAIN" });
    expect(classifyAgentError(caught)).toMatchObject({
      category: "unknown",
      fallbackAllowed: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("GET 查询仍可对瞬时 5xx 重试", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("busy", { status: 503, statusText: "Busy" }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const pending = provider().call("GET");
    await vi.advanceTimersByTimeAsync(500);

    await expect(pending).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("超大错误体在 64KiB 处取消，不会泄露供应商凭据", async () => {
    const secret = "sk-should-never-escape";
    const cancel = vi.fn();
    const body = new ReadableStream({
      pull(controller) {
        // 保持 stream 未关闭，以验证越过上限时主动 cancel，而不是恰好读到 EOF。
        controller.enqueue(new TextEncoder().encode(secret.repeat(1_000)));
      },
      cancel,
    });
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(body, { status: 400, statusText: "Bad Request" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    let caught: unknown;
    try {
      await provider().call("GET");
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({
      code: "INVALID_INPUT",
      category: "invalid_input",
      statusCode: 400,
    });
    expect(String(caught)).not.toContain(secret);
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      label: "safety",
      status: 400,
      payload: { error: { code: "InputImageSensitiveContentDetected", message: "sensitive input" } },
      category: "safety",
      code: "SAFETY_BLOCKED",
    },
    {
      label: "billing",
      status: 402,
      payload: { error: { code: "InsufficientBalance", message: "insufficient balance" } },
      category: "billing",
      code: "BILLING_REQUIRED",
    },
    {
      label: "auth",
      status: 401,
      payload: { error: { code: "InvalidApiKey", message: "unauthorized" } },
      category: "auth",
      code: "AUTH_FAILED",
    },
    {
      label: "rate limit",
      status: 429,
      payload: { error: { code: "RateLimitExceeded", message: "too many requests" } },
      category: "rate_limit",
      code: "RATE_LIMITED",
    },
    {
      label: "invalid input",
      status: 422,
      payload: { error: { code: "InvalidArgument", message: "invalid frame" } },
      category: "invalid_input",
      code: "INVALID_INPUT",
    },
  ])("4xx JSON 稳定分类为 $label", async ({ status, payload, category, code }) => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(payload), {
      status,
      headers: {
        "Content-Type": "application/json",
        ...(status === 429 ? { "Retry-After": "17" } : {}),
      },
    }));
    vi.stubGlobal("fetch", fetchMock);

    let caught: unknown;
    try {
      await provider().call("GET", "never");
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ProviderError);
    expect(caught).toMatchObject({ category, code });
    const detail = toSafeProviderErrorDto(caught);
    expect(detail).toMatchObject({ category, code });
    if (status === 429) {
      expect(caught).toMatchObject({ retryable: true, retryAfterSeconds: 17 });
      expect(detail.retryAfterSeconds).toBe(17);
    }
  });

  it("仅保留白名单诊断字段，安全 DTO 不返回上游 message/凭据", async () => {
    const secret = "sk-provider-secret";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: {
        code: "InvalidArgument",
        message: `invalid input Authorization: Bearer ${secret}`,
      },
      request_id: "req-safe-123",
      apiKey: secret,
      prompt: `do not retain ${secret}`,
      debug: { authorization: `Bearer ${secret}` },
    }), { status: 400, headers: { "Content-Type": "application/json" } })));

    let caught: unknown;
    try {
      await provider().call("GET", "never");
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({
      category: "invalid_input",
      requestId: "req-safe-123",
      upstreamCode: "InvalidArgument",
    });
    expect(String(caught)).not.toContain(secret);
    expect(JSON.stringify(caught)).not.toContain(secret);
    expect(toSafeProviderErrorDto(caught)).toEqual({
      code: "INVALID_INPUT",
      category: "invalid_input",
      message: "当前素材或参数不符合模型要求，请调整后重试",
      retryable: false,
      requestId: "req-safe-123",
      suggestedAction: "review_request",
    });
  });

  it("火山方舟人脸风控保留为专用 FACE_BLOCKED DTO，不被误译为配置失败", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: {
        code: "InputImageSensitiveContentDetected",
        message: "input image contains a protected face",
      },
      request_id: "ark-request-1",
    }), { status: 400, headers: { "Content-Type": "application/json" } })));
    const volc = new VolcEngineProvider({
      name: "volcengine",
      apiKey: "test-only",
      baseUrl: "https://93.184.216.34",
    });

    let caught: unknown;
    try {
      await volc.generateVideo({
        modelId: "fixed-seedance-endpoint",
        mode: "image-to-video",
        prompt: "subtle motion",
        firstFrameUrl: "https://cdn.example/face.png",
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({
      code: "ARK_FACE_BLOCKED",
      category: "safety",
      retryable: false,
      requestId: "ark-request-1",
    });
    expect(toSafeProviderErrorDto(caught)).toMatchObject({
      code: "FACE_BLOCKED",
      category: "safety",
      suggestedAction: "replace_input",
    });
  });

  it("拒绝超大成功响应；GET 可判为无效响应，POST 必须停在结果不确定", async () => {
    const oversizedHeaders = {
      "Content-Type": "application/json",
      "Content-Length": String(10 * 1024 * 1024 + 1),
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("{}", { status: 200, headers: oversizedHeaders }))
      .mockResolvedValueOnce(new Response("{}", { status: 200, headers: oversizedHeaders }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(provider().call("GET", "never")).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
    await expect(provider().call("POST")).rejects.toMatchObject({
      code: "SUBMISSION_UNCERTAIN",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("自定义模型端点指向私网时，在发出请求前拒绝", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const privateProvider = new ProbeProvider({
      name: "probe",
      apiKey: "test-only",
      baseUrl: "https://127.0.0.1",
    });

    await expect(privateProvider.call("GET", "never")).rejects.toMatchObject({
      code: "NETWORK_ERROR",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
