import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { POST } from "@/app/api/llm/test/route";

const previousMode = process.env.HUIMAI_DEPLOYMENT_MODE;
const previousSingleUser = process.env.CLIPFORGE_SINGLE_USER;

function request(baseUrl: string) {
  return new NextRequest("http://localhost/api/llm/test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ baseUrl, apiKey: "test-only", model: "fixed-model" }),
  });
}

beforeEach(() => {
  process.env.HUIMAI_DEPLOYMENT_MODE = "desktop";
  process.env.CLIPFORGE_SINGLE_USER = "1";
});

afterEach(() => {
  if (previousMode === undefined) delete process.env.HUIMAI_DEPLOYMENT_MODE;
  else process.env.HUIMAI_DEPLOYMENT_MODE = previousMode;
  if (previousSingleUser === undefined) delete process.env.CLIPFORGE_SINGLE_USER;
  else process.env.CLIPFORGE_SINGLE_USER = previousSingleUser;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("LLM 连接探针安全响应", () => {
  it("供应商错误正文不会回传给后台浏览器", async () => {
    const secret = "sk-provider-echo-must-not-leak";
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ error: { message: `invalid request ${secret}` } }),
      { status: 400, statusText: "Bad Request" },
    ));
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(request("https://93.184.216.34/v1"));
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("HTTP 400");
    expect(body).not.toContain(secret);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("私网模型地址在网络请求前被拒绝", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(request("https://127.0.0.1/v1"));
    const body = await response.json() as { ok: boolean; error: string };

    expect(body.ok).toBe(false);
    expect(body.error).toBe("连接测试失败，请检查模型地址、网络和证书配置");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
