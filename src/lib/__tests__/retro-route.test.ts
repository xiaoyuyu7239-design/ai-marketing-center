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

const routeParams = (id: string) => ({ params: Promise.resolve({ id }) });

describe("单条视频复盘 /api/project/[id]/retro", () => {
  let dataDir: string;
  let register: typeof import("@/app/api/auth/register/route").POST;
  let createProject: typeof import("@/app/api/project/route").POST;
  let addMetric: typeof import("@/app/api/project/[id]/metrics/route").POST;
  let mutatePublishRecord: typeof import("@/app/api/publish-records/route").POST;
  let retroPost: typeof import("@/app/api/project/[id]/retro/route").POST;
  let retroGet: typeof import("@/app/api/project/[id]/retro/route").GET;
  let cookieA: string;
  let cookieB: string;
  let projectId: string;
  let merchantAId: string;

  async function newProject(name: string, cookie: string): Promise<string> {
    const res = await createProject(
      jsonRequest("http://test.local/api/project", "POST", { name, productName: name }, cookie)
    );
    const j = await res.json();
    return j.id;
  }

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "clipforge-retro-test-"));
    process.env.APP_DATA_DIR = dataDir;
    // 清掉模型环境变量：LLM 不可用 → 复盘必须走规则兜底，测试不打真实网络
    delete process.env.CLIPFORGE_LLM_BASE_URL;
    delete process.env.CLIPFORGE_LLM_FALLBACK_BASE_URL;
    ({ POST: register } = await import("@/app/api/auth/register/route"));
    ({ POST: createProject } = await import("@/app/api/project/route"));
    ({ POST: addMetric } = await import("@/app/api/project/[id]/metrics/route"));
    ({ POST: mutatePublishRecord } = await import("@/app/api/publish-records/route"));
    ({ POST: retroPost, GET: retroGet } = await import("@/app/api/project/[id]/retro/route"));

    const resA = await register(
      jsonRequest("http://test.local/api/auth/register", "POST", { email: "retro-a@test.local", password: "pw123456" })
    );
    cookieA = extractCookie(resA);
    merchantAId = (await resA.json()).merchant?.id ?? "";
    const resB = await register(
      jsonRequest("http://test.local/api/auth/register", "POST", { email: "retro-b@test.local", password: "pw123456" })
    );
    cookieB = extractCookie(resB);

    projectId = await newProject("复盘主项目", cookieA);
  });

  afterAll(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("未登录 401；别人的项目 404；没回填数据 400 引导先填数", async () => {
    const anon = await retroPost(jsonRequest(`http://test.local/api/project/${projectId}/retro`, "POST", {}), routeParams(projectId));
    expect(anon.status).toBe(401);
    const other = await retroPost(jsonRequest(`http://test.local/api/project/${projectId}/retro`, "POST", {}, cookieB), routeParams(projectId));
    expect(other.status).toBe(404);
    const noData = await retroPost(jsonRequest(`http://test.local/api/project/${projectId}/retro`, "POST", {}, cookieA), routeParams(projectId));
    expect(noData.status).toBe(400);
    expect((await noData.json()).error).toContain("数据");
  });

  it("回填数据后可复盘：方向按账号其他视频基线算，预测 vs 实际定格对照，经验进店铺记忆", async () => {
    // 主项目回填 3000 播放；另外两个项目各回填 900/1100 做账号基线（中位数 1000）
    const publishMain = await mutatePublishRecord(jsonRequest("http://test.local/api/publish-records", "POST", {
      projectId,
      action: "publish",
      platform: "douyin",
    }, cookieA));
    expect(publishMain.status).toBe(200);
    const mainMetric = await addMetric(jsonRequest(`http://test.local/api/project/${projectId}/metrics`, "POST", { views: 3000, platform: "douyin" }, cookieA), routeParams(projectId));
    expect(mainMetric.status).toBe(200);
    for (const [name, views] of [["基线项目1", 900], ["基线项目2", 1100]] as const) {
      const pid = await newProject(name, cookieA);
      const publishResponse = await mutatePublishRecord(jsonRequest("http://test.local/api/publish-records", "POST", {
        projectId: pid,
        action: "publish",
        platform: "douyin",
      }, cookieA));
      expect(publishResponse.status).toBe(200);
      const metricResponse = await addMetric(jsonRequest(`http://test.local/api/project/${pid}/metrics`, "POST", { views, platform: "douyin" }, cookieA), routeParams(pid));
      expect(metricResponse.status).toBe(200);
    }
    // 预置一条"当时的发布前诊断"（带低分维度）：复盘要跟它做预测 vs 实际对照，规则兜底也借它的维度出建议
    const { getDb } = await import("@backend/db");
    const { contentDiagnosis } = await import("@backend/db/schema");
    await getDb().insert(contentDiagnosis).values({
      projectId,
      style: "scene",
      platform: "douyin",
      overallScore: 62,
      dimensions: [
        { key: "hook", score: 80, comment: "开场钩子不错" },
        { key: "cta", score: 45, comment: "结尾没说清下一步" },
      ],
      prediction: "average",
      source: "rule",
    });

    const res = await retroPost(jsonRequest(`http://test.local/api/project/${projectId}/retro`, "POST", { locale: "zh" }, cookieA), routeParams(projectId));
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.warning).toBeTruthy(); // LLM 不可用必须显式告知
    expect(j.retro.source).toBe("rule");
    expect(j.retro.actual).toBe("above"); // 3000 vs 中位数 1000
    expect(j.retro.actualBasis).toContain("3000");
    expect(j.retro.predicted).toBe("average"); // 预测定格自当时诊断 → "预测 vs 实际"对照记录成立
    expect(j.retro.summary).toContain("比你平时的视频表现好");
    expect(j.retro.nextActions.length).toBeGreaterThan(0); // 借低分维度出"下条试试"

    // 飞轮闭环验证："下条试试"已写进店铺记忆，下次生成脚本的提示会带上
    const { getStoreMemory, buildStoreMemoryHint } = await import("@backend/core/memory/store-memory");
    const memory = await getStoreMemory(merchantAId);
    expect(memory.reviewNotes.length).toBeGreaterThan(0);
    expect(buildStoreMemoryHint(memory)).toContain("近期复盘得出的经验");
  });

  it("GET 按新→旧列出复盘，且商家隔离", async () => {
    const res = await retroGet(getRequest(`http://test.local/api/project/${projectId}/retro`, cookieA), routeParams(projectId));
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.retros.length).toBe(1);
    const other = await retroGet(getRequest(`http://test.local/api/project/${projectId}/retro`, cookieB), routeParams(projectId));
    expect(other.status).toBe(404);
  });
});
