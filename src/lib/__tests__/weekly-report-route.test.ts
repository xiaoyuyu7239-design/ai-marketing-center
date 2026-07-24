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

function getRequest(url: string, cookie?: string): NextRequest {
  return new NextRequest(url, { headers: cookie ? { Cookie: cookie } : {} });
}

function extractCookie(res: Response): string {
  const setCookie = res.headers.get("set-cookie");
  if (!setCookie) throw new Error("响应没有 Set-Cookie");
  return setCookie.split(";")[0];
}

describe("账号周报 /api/insights/weekly-report", () => {
  let dataDir: string;
  let register: typeof import("@/app/api/auth/register/route").POST;
  let createProject: typeof import("@/app/api/project/route").POST;
  let addMetric: typeof import("@/app/api/project/[id]/metrics/route").POST;
  let mutatePublishRecord: typeof import("@/app/api/publish-records/route").POST;
  let reportPost: typeof import("@/app/api/insights/weekly-report/route").POST;
  let reportGet: typeof import("@/app/api/insights/weekly-report/route").GET;
  let cookieA: string;
  let cookieB: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "clipforge-weekly-report-test-"));
    process.env.APP_DATA_DIR = dataDir;
    // 清掉模型环境变量：LLM 不可用 → 周报必须走规则兜底，测试不打真实网络
    delete process.env.CLIPFORGE_LLM_BASE_URL;
    delete process.env.CLIPFORGE_LLM_FALLBACK_BASE_URL;
    ({ POST: register } = await import("@/app/api/auth/register/route"));
    ({ POST: createProject } = await import("@/app/api/project/route"));
    ({ POST: addMetric } = await import("@/app/api/project/[id]/metrics/route"));
    ({ POST: mutatePublishRecord } = await import("@/app/api/publish-records/route"));
    ({ POST: reportPost, GET: reportGet } = await import("@/app/api/insights/weekly-report/route"));

    const resA = await register(
      jsonRequest("http://test.local/api/auth/register", "POST", { email: "weekly-a@test.local", password: "pw123456" })
    );
    cookieA = extractCookie(resA);
    const resB = await register(
      jsonRequest("http://test.local/api/auth/register", "POST", { email: "weekly-b@test.local", password: "pw123456" })
    );
    cookieB = extractCookie(resB);
  });

  afterAll(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("未登录 401；本周没回填过数据 → 400 引导先填数", async () => {
    const anon = await reportPost(jsonRequest("http://test.local/api/insights/weekly-report", "POST", {}));
    expect(anon.status).toBe(401);
    const noData = await reportPost(jsonRequest("http://test.local/api/insights/weekly-report", "POST", {}, cookieA));
    expect(noData.status).toBe(400);
    expect((await noData.json()).error).toContain("回填");
  });

  it("有本周数据 → 规则兜底周报落库：统计定格、warning 明示、内容大白话", async () => {
    for (const [index, views] of [1000, 2000].entries()) {
      const projRes = await createProject(
        jsonRequest("http://test.local/api/project", "POST", {
          name: `周报项目 ${index + 1}`,
          productName: `周报商品 ${index + 1}`,
        }, cookieA)
      );
      const { id: projectId } = await projRes.json();
      const publishResponse = await mutatePublishRecord(
        jsonRequest("http://test.local/api/publish-records", "POST", {
          projectId,
          action: "publish",
          platform: "douyin",
        }, cookieA)
      );
      expect(publishResponse.status).toBe(200);
      const res = await addMetric(
        jsonRequest(`http://test.local/api/project/${projectId}/metrics`, "POST", { views, orders: 1, platform: "douyin" }, cookieA),
        { params: Promise.resolve({ id: projectId }) }
      );
      expect(res.status).toBe(200);
    }

    const res = await reportPost(jsonRequest("http://test.local/api/insights/weekly-report", "POST", { locale: "zh" }, cookieA));
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.warning).toBeTruthy(); // LLM 不可用必须显式告知
    expect(j.report.source).toBe("rule");
    expect(j.report.stats.thisWeek.entries).toBe(2);
    expect(j.report.stats.thisWeek.views).toBe(3000);
    expect(j.report.stats.viewsTrendPct).toBeNull(); // 上周没数据不硬编趋势
    expect(j.report.summary).toContain("2 条");
    expect(j.report.nextActions.length).toBeGreaterThan(0);
  });

  it("GET 列出自己的周报；商家隔离（B 看不到 A 的）", async () => {
    const mine = await reportGet(getRequest("http://test.local/api/insights/weekly-report", cookieA));
    expect(mine.status).toBe(200);
    expect((await mine.json()).reports.length).toBe(1);
    const other = await reportGet(getRequest("http://test.local/api/insights/weekly-report", cookieB));
    expect(other.status).toBe(200);
    expect((await other.json()).reports.length).toBe(0);
  });
});
