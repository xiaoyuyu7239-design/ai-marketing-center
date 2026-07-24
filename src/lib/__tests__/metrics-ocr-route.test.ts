import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { NextRequest } from "next/server";

function jsonRequest(url: string, method: string, body: unknown, cookie?: string): NextRequest {
  return new NextRequest(url, {
    method,
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

function extractCookie(res: Response): string {
  const setCookie = res.headers.get("set-cookie");
  if (!setCookie) throw new Error("响应没有 Set-Cookie");
  return setCookie.split(";")[0];
}

const routeParams = (id: string) => ({ params: Promise.resolve({ id }) });
const TINY_PNG = "data:image/png;base64,iVBORw0KGgo=";

describe("截图识别回填 /api/project/[id]/metrics/ocr", () => {
  let dataDir: string;
  let register: typeof import("@/app/api/auth/register/route").POST;
  let createProject: typeof import("@/app/api/project/route").POST;
  let ocr: typeof import("@/app/api/project/[id]/metrics/ocr/route").POST;
  let cookieA: string;
  let cookieB: string;
  let projectId: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "clipforge-metrics-ocr-test-"));
    process.env.APP_DATA_DIR = dataDir;
    // 清掉模型环境变量：识别端点不可用 → 走"AI 暂不可用"分支，测试不打真实网络
    delete process.env.CLIPFORGE_LLM_BASE_URL;
    delete process.env.CLIPFORGE_LLM_FALLBACK_BASE_URL;
    ({ POST: register } = await import("@/app/api/auth/register/route"));
    ({ POST: createProject } = await import("@/app/api/project/route"));
    ({ POST: ocr } = await import("@/app/api/project/[id]/metrics/ocr/route"));

    const resA = await register(
      jsonRequest("http://test.local/api/auth/register", "POST", { email: "ocr-a@test.local", password: "pw123456" })
    );
    cookieA = extractCookie(resA);
    const resB = await register(
      jsonRequest("http://test.local/api/auth/register", "POST", { email: "ocr-b@test.local", password: "pw123456" })
    );
    cookieB = extractCookie(resB);

    const projRes = await createProject(
      jsonRequest("http://test.local/api/project", "POST", { name: "OCR测试项目", productName: "测试商品" }, cookieA)
    );
    ({ id: projectId } = await projRes.json());
  });

  afterAll(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("未登录 → 401；别人的项目 → 404", async () => {
    const anon = await ocr(jsonRequest(`http://test.local/api/project/${projectId}/metrics/ocr`, "POST", { image: TINY_PNG }), routeParams(projectId));
    expect(anon.status).toBe(401);
    const other = await ocr(jsonRequest(`http://test.local/api/project/${projectId}/metrics/ocr`, "POST", { image: TINY_PNG }, cookieB), routeParams(projectId));
    expect(other.status).toBe(404);
  });

  it("没带图/图不合规 → 400 大白话报错", async () => {
    const empty = await ocr(jsonRequest(`http://test.local/api/project/${projectId}/metrics/ocr`, "POST", {}, cookieA), routeParams(projectId));
    expect(empty.status).toBe(400);
    expect((await empty.json()).error).toContain("截图");
    const bad = await ocr(
      jsonRequest(`http://test.local/api/project/${projectId}/metrics/ocr`, "POST", { image: "http://x/y.png" }, cookieA),
      routeParams(projectId)
    );
    expect(bad.status).toBe(400);
  });

  it("视觉模型未配置 → 502 且提示先手动填写（不静默失败）", async () => {
    const res = await ocr(
      jsonRequest(`http://test.local/api/project/${projectId}/metrics/ocr`, "POST", { image: TINY_PNG }, cookieA),
      routeParams(projectId)
    );
    expect(res.status).toBe(502);
    expect((await res.json()).error).toContain("手动填");
  });
});
