import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createSafeModelFetch } from "@backend/shared/openai-client";
import {
  providerTelemetryFromPayload,
  withModelTelemetryReporter,
} from "@backend/shared/model-telemetry";
import { classifyAgentError } from "@server/admin/agents/service";

const previousMode = process.env.HUIMAI_DEPLOYMENT_MODE;
const previousSingleUser = process.env.CLIPFORGE_SINGLE_USER;

beforeEach(() => {
  process.env.HUIMAI_DEPLOYMENT_MODE = "saas";
  delete process.env.CLIPFORGE_SINGLE_USER;
});

afterEach(() => {
  if (previousMode === undefined) delete process.env.HUIMAI_DEPLOYMENT_MODE;
  else process.env.HUIMAI_DEPLOYMENT_MODE = previousMode;
  if (previousSingleUser === undefined) delete process.env.CLIPFORGE_SINGLE_USER;
  else process.env.CLIPFORGE_SINGLE_USER = previousSingleUser;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("OpenAI-compatible 受控客户端", () => {
  it("供应商错误正文在进入 SDK 前被丢弃", async () => {
    const secret = "sk-provider-echo-never-persist";
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ error: { message: secret } }),
      { status: 400, statusText: "Bad Request", headers: { "X-Request-Id": "req-safe" } },
    ));
    vi.stubGlobal("fetch", fetchMock);
    const guarded = createSafeModelFetch("https://93.184.216.34/v1");

    const response = await guarded("https://93.184.216.34/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: "Bearer test-only", "Content-Type": "application/json" },
      body: JSON.stringify({ model: "fixed", messages: [] }),
    });

    expect(response.status).toBe(400);
    expect(await response.text()).toBe("");
    expect(response.headers.get("x-request-id")).toBe("req-safe");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("拒绝私网和不同源目标，且不发出网络请求", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const privateFetch = createSafeModelFetch("https://127.0.0.1/v1");
    await expect(privateFetch("https://127.0.0.1/v1/chat/completions"))
      .rejects.toThrow(/内网|保留地址/);

    const guarded = createSafeModelFetch("https://93.184.216.34/v1");
    await expect(guarded("https://8.8.8.8/v1/chat/completions"))
      .rejects.toThrow(/不同源/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("拒绝声明超出 10MiB 的成功响应", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", {
      status: 200,
      headers: { "Content-Length": String(10 * 1024 * 1024 + 1) },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const guarded = createSafeModelFetch("https://93.184.216.34/v1");

    await expect(guarded("https://93.184.216.34/v1/chat/completions"))
      .rejects.toThrow("MODEL_RESPONSE_TOO_LARGE");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("只采集供应商实际返回的 usage/cost，且不按 token 猜价", async () => {
    expect(providerTelemetryFromPayload({
      model: "gpt-4o-2024-08-06",
      usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
    })).toEqual({
      inputTokens: 10,
      outputTokens: 4,
      totalTokens: 14,
      effectiveModel: "gpt-4o-2024-08-06",
    });
    expect(providerTelemetryFromPayload({ usage: { prompt_tokens: 10 } })?.costUsd).toBeUndefined();

    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [],
      model: "provider-fixed-revision-7",
      usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17, cost_usd: 0.0017 },
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const guarded = createSafeModelFetch("https://93.184.216.34/v1");
    const reports: unknown[] = [];

    await withModelTelemetryReporter((telemetry) => reports.push(telemetry), async () => {
      const response = await guarded("https://93.184.216.34/v1/chat/completions");
      await response.json();
    });

    expect(reports).toEqual([{
      inputTokens: 12,
      outputTokens: 5,
      totalTokens: 17,
      costUsd: 0.0017,
      effectiveModel: "provider-fixed-revision-7",
    }]);
  });

  it("持久化分类理由使用固定文案，不包含供应商错误正文", () => {
    const secret = "upstream echoed prompt and sk-secret-value";
    const error = Object.assign(new Error(secret), { status: 503 });
    const classified = classifyAgentError(error);

    expect(classified).toMatchObject({ category: "provider_5xx", fallbackAllowed: true });
    expect(classified.reason).toBe("供应商服务暂时异常");
    expect(classified.reason).not.toContain(secret);
  });
});
