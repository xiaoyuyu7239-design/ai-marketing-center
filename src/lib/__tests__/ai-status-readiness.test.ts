import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  createProvider: vi.fn(),
  toSafeProviderErrorDto: vi.fn(),
  getAgentStrategy: vi.fn(),
  getAgentOperationReadiness: vi.fn(),
}));

vi.mock("@backend/providers", () => ({
  createProvider: mocks.createProvider,
  toSafeProviderErrorDto: mocks.toSafeProviderErrorDto,
}));

vi.mock("@server/admin/agents", () => ({
  getAgentStrategy: mocks.getAgentStrategy,
  getAgentOperationReadiness: mocks.getAgentOperationReadiness,
}));

vi.mock("@backend/core/auth/require-merchant", () => ({
  requireMerchant: vi.fn(async () => ({ merchant: { id: "merchant-1" } })),
}));

vi.mock("@server/admin/admin-auth", () => ({
  isAdminOrDesktopRequest: vi.fn(() => true),
}));

vi.mock("@backend/core/security/rate-limit", () => ({
  AUTHENTICATED_IP_RATE_LIMIT_PRESETS: { providerProbe: { limit: 1, windowMs: 1 } },
  consumeAuthenticatedIpRateLimit: vi.fn(() => ({ allowed: true })),
  rateLimitResponse: vi.fn(),
}));

describe("AI status 真实 readiness", () => {
  beforeEach(() => {
    mocks.createProvider.mockReset();
    mocks.toSafeProviderErrorDto.mockReset();
    mocks.getAgentStrategy.mockReset();
    mocks.getAgentOperationReadiness.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("只调用与实际 Agent 运行共用的本地 readiness，不发起供应商请求", async () => {
    const state = { agents: [] };
    mocks.getAgentStrategy.mockResolvedValue(state);
    mocks.getAgentOperationReadiness.mockImplementation((_state, agentId: string) => ({
      ready: agentId !== "videoAgent",
      reason: agentId === "videoAgent" ? "not ready" : "ready",
    }));
    const { GET } = await import("@/app/api/ai/status/route");

    const response = await GET(new NextRequest("http://localhost/api/ai/status"));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      imageReady: true,
      videoReady: false,
      ttsReady: true,
    });
    expect(mocks.getAgentOperationReadiness.mock.calls).toEqual([
      [state, "imageAgent"],
      [state, "videoAgent"],
      [state, "ttsAgent"],
    ]);
    expect(mocks.createProvider).not.toHaveBeenCalled();
  });

  it("POST 查询失败只返回结构化安全 DTO，不透传上游错误", async () => {
    const upstream = new Error("Authorization: Bearer sk-never-return");
    mocks.createProvider.mockReturnValue({
      getTaskStatus: vi.fn().mockRejectedValue(upstream),
    });
    mocks.toSafeProviderErrorDto.mockReturnValue({
      code: "RATE_LIMITED",
      category: "rate_limit",
      message: "模型服务当前较忙，请稍后重试",
      retryable: true,
      retryAfterSeconds: 11,
      requestId: "req-safe-1",
      suggestedAction: "retry_later",
    });
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { POST } = await import("@/app/api/ai/status/route");

    const response = await POST(new NextRequest("http://localhost/api/ai/status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "probe",
        taskId: "task-1",
        apiKey: "request-secret",
        baseUrl: "https://provider.example/v1",
      }),
    }));
    const payload = await response.json();

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("11");
    expect(payload).toMatchObject({
      error: "模型服务当前较忙，请稍后重试",
      detail: { code: "RATE_LIMITED", category: "rate_limit", requestId: "req-safe-1" },
    });
    expect(JSON.stringify(payload)).not.toMatch(/sk-never-return|request-secret/);
    expect(log).toHaveBeenCalledWith("查询任务状态失败:", {
      code: "RATE_LIMITED",
      category: "rate_limit",
      requestId: "req-safe-1",
    });
    log.mockRestore();
  });
});
