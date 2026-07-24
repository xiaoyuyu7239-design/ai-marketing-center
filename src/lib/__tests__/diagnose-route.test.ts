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

describe("发布前诊断 /api/project/[id]/diagnose", () => {
  let dataDir: string;
  let register: typeof import("@/app/api/auth/register/route").POST;
  let createProject: typeof import("@/app/api/project/route").POST;
  let diagnosePost: typeof import("@/app/api/project/[id]/diagnose/route").POST;
  let diagnoseGet: typeof import("@/app/api/project/[id]/diagnose/route").GET;
  let addMetric: typeof import("@/app/api/project/[id]/metrics/route").POST;
  let mutatePublishRecord: typeof import("@/app/api/publish-records/route").POST;
  let cookieA: string;
  let cookieB: string;
  let projectId: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "clipforge-diagnose-test-"));
    process.env.APP_DATA_DIR = dataDir;
    // 清掉模型环境变量：诊断的 LLM 主/备端点都不可用 → 必须走本地规则快检兜底，测试不打真实网络
    delete process.env.CLIPFORGE_LLM_BASE_URL;
    delete process.env.CLIPFORGE_LLM_FALLBACK_BASE_URL;
    ({ POST: register } = await import("@/app/api/auth/register/route"));
    ({ POST: createProject } = await import("@/app/api/project/route"));
    ({ POST: diagnosePost, GET: diagnoseGet } = await import("@/app/api/project/[id]/diagnose/route"));
    ({ POST: addMetric } = await import("@/app/api/project/[id]/metrics/route"));
    ({ POST: mutatePublishRecord } = await import("@/app/api/publish-records/route"));

    const resA = await register(
      jsonRequest("http://test.local/api/auth/register", "POST", { email: "diag-a@test.local", password: "pw123456" })
    );
    cookieA = extractCookie(resA);
    const resB = await register(
      jsonRequest("http://test.local/api/auth/register", "POST", { email: "diag-b@test.local", password: "pw123456" })
    );
    cookieB = extractCookie(resB);

    const projRes = await createProject(
      jsonRequest("http://test.local/api/project", "POST", { name: "诊断测试项目", productName: "厨房清洁剂", productCategory: "home" }, cookieA)
    );
    ({ id: projectId } = await projRes.json());
  });

  afterAll(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("未登录 → 401；别人的项目 → 404", async () => {
    const anon = await diagnosePost(jsonRequest(`http://test.local/api/project/${projectId}/diagnose`, "POST", {}), routeParams(projectId));
    expect(anon.status).toBe(401);
    const other = await diagnosePost(jsonRequest(`http://test.local/api/project/${projectId}/diagnose`, "POST", {}, cookieB), routeParams(projectId));
    expect(other.status).toBe(404);
  });

  it("项目还没有脚本 → 400 提示先生成脚本", async () => {
    const res = await diagnosePost(jsonRequest(`http://test.local/api/project/${projectId}/diagnose`, "POST", {}, cookieA), routeParams(projectId));
    expect(res.status).toBe(400);
    const j = await res.json();
    expect(j.error).toContain("脚本");
  });

  it("有脚本、LLM 未配置 → 规则兜底诊断落库；无回流数据时不给相对预测", async () => {
    // 直接插入脚本行（脚本生成路由依赖 LLM，测试离线直插）
    const { getDb } = await import("@backend/db");
    const { scripts } = await import("@backend/db/schema");
    await getDb().insert(scripts).values({
      projectId,
      version: 1,
      styleType: "scene",
      title: "油污一擦就掉",
      totalDuration: 30,
      selected: true,
      shots: [
        { shotId: 1, type: "hook", duration: 3, description: "特写", camera: "推近", visualSource: "product_image", transition: "direct_concat", voiceover: "还在为厨房油污发愁？" },
        { shotId: 2, type: "product_reveal", duration: 8, description: "展示", camera: "环绕", visualSource: "product_image", transition: "direct_concat", voiceover: "这瓶清洁剂喷一下" },
        { shotId: 3, type: "demo", duration: 12, description: "演示", camera: "固定", visualSource: "product_image", transition: "direct_concat", voiceover: "重油污一擦就掉" },
        { shotId: 4, type: "cta", duration: 7, description: "结尾", camera: "固定", visualSource: "product_image", transition: "direct_concat", voiceover: "点击小黄车带回家" },
      ],
    });

    const res = await diagnosePost(
      jsonRequest(`http://test.local/api/project/${projectId}/diagnose`, "POST", { platform: "douyin", locale: "zh" }, cookieA),
      routeParams(projectId)
    );
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.warning).toBeTruthy(); // LLM 不可用必须显式告知，不能装作 AI 诊断成功
    expect(j.diagnosis.source).toBe("rule");
    expect(j.diagnosis.overallScore).toBe(75); // 结构完整的好脚本，规则版全 75
    expect(j.diagnosis.dimensions).toHaveLength(5);
    expect(j.diagnosis.style).toBe("scene"); // 风格定格
    expect(j.diagnosis.prediction).toBeNull(); // 没有回流数据 → 不硬给方向
    expect(j.diagnosis.predictionBasis).toContain("0 条");
  });

  it("回填 3 条真实数据后 → 相对预测解锁，方向与依据齐全", async () => {
    for (const [index, views] of [1000, 2000, 3000].entries()) {
      const projectResponse = await createProject(
        jsonRequest("http://test.local/api/project", "POST", {
          name: `诊断基线项目 ${index + 1}`,
          productName: `诊断基线商品 ${index + 1}`,
        }, cookieA)
      );
      const { id: baselineProjectId } = await projectResponse.json();
      const publishResponse = await mutatePublishRecord(
        jsonRequest("http://test.local/api/publish-records", "POST", {
          projectId: baselineProjectId,
          action: "publish",
          platform: "douyin",
        }, cookieA)
      );
      expect(publishResponse.status).toBe(200);
      const res = await addMetric(
        jsonRequest(`http://test.local/api/project/${baselineProjectId}/metrics`, "POST", { platform: "douyin", views }, cookieA),
        routeParams(baselineProjectId)
      );
      expect(res.status).toBe(200);
    }
    const res = await diagnosePost(
      jsonRequest(`http://test.local/api/project/${projectId}/diagnose`, "POST", { locale: "zh" }, cookieA),
      routeParams(projectId)
    );
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.diagnosis.prediction).toBe("above"); // 总分 75 落在 ≥75 档 → 预计高于账号平均
    expect(j.diagnosis.predictionConfidence).toBe("low"); // 3 条样本
    expect(j.diagnosis.predictionBasis).toContain("3 条");
    expect(j.diagnosis.predictionBasis).toContain("2000"); // 播放中位数
  });

  it("GET 按新→旧列出历史诊断，且商家隔离", async () => {
    const res = await diagnoseGet(getRequest(`http://test.local/api/project/${projectId}/diagnose`, cookieA), routeParams(projectId));
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.diagnoses.length).toBe(2);
    const other = await diagnoseGet(getRequest(`http://test.local/api/project/${projectId}/diagnose`, cookieB), routeParams(projectId));
    expect(other.status).toBe(404);
  });
});
