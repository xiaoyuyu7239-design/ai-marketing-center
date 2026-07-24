import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { NextRequest } from "next/server";

function jsonRequest(url: string, body: unknown, cookie?: string): NextRequest {
  return new NextRequest(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body),
  });
}

function getRequest(url: string, cookie?: string): NextRequest {
  return new NextRequest(url, { headers: cookie ? { Cookie: cookie } : {} });
}

const routeParams = (id: string) => ({ params: Promise.resolve({ id }) });

describe("效果回流 /api/project/[id]/metrics", () => {
  let dataDir: string;
  let listMetrics: typeof import("@/app/api/project/[id]/metrics/route").GET;
  let addMetric: typeof import("@/app/api/project/[id]/metrics/route").POST;
  let getDb: typeof import("@backend/db").getDb;
  let tables: typeof import("@backend/db/schema");
  let cookieA: string;
  let cookieB: string;
  const merchantA = "metrics-merchant-a";
  const merchantB = "metrics-merchant-b";
  const projectA = "metrics-project-a";
  const unpublishedProject = "metrics-project-unpublished";
  const publishedAt = new Date("2026-07-15T12:34:00.000Z");

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "clipforge-metrics-route-test-"));
    process.env.APP_DATA_DIR = dataDir;

    ({ GET: listMetrics, POST: addMetric } = await import("@/app/api/project/[id]/metrics/route"));
    ({ getDb } = await import("@backend/db"));
    tables = await import("@backend/db/schema");
    const { createSession, SESSION_COOKIE } = await import("@backend/core/auth/session");

    const db = getDb();
    await db.insert(tables.merchants).values([
      { id: merchantA, email: "metrics-a@test.local", passwordHash: "!test-only" },
      { id: merchantB, email: "metrics-b@test.local", passwordHash: "!test-only" },
    ]);
    await db.insert(tables.projects).values({
      id: projectA,
      merchantId: merchantA,
      name: "A 的回流项目",
      productName: "A 商品",
      productCategory: "home",
    });
    await db.insert(tables.projects).values({
      id: unpublishedProject,
      merchantId: merchantA,
      name: "尚未发布的项目",
      productName: "未发布商品",
      productCategory: "home",
    });

    const sessionA = await createSession(merchantA);
    const sessionB = await createSession(merchantB);
    cookieA = `${SESSION_COOKIE}=${sessionA.token}`;
    cookieB = `${SESSION_COOKIE}=${sessionB.token}`;
  });

  afterAll(() => {
    delete process.env.APP_DATA_DIR;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("未登录 401；跨商家访问统一 404", async () => {
    const url = `http://test.local/api/project/${projectA}/metrics`;
    expect((await listMetrics(getRequest(url), routeParams(projectA))).status).toBe(401);
    expect((await listMetrics(getRequest(url, cookieB), routeParams(projectA))).status).toBe(404);
    expect((await addMetric(jsonRequest(url, { views: 10 }, cookieB), routeParams(projectA))).status).toBe(404);
  });

  it("空库明确返回 hasPerformanceData=false", async () => {
    const res = await listMetrics(
      getRequest(`http://test.local/api/project/${projectA}/metrics`, cookieA),
      routeParams(projectA)
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ metrics: [], hasPerformanceData: false });
  });

  it("拒绝非有限/非整数/负数计数，失败不落库", async () => {
    const url = `http://test.local/api/project/${projectA}/metrics`;
    const invalidBodies = [
      {},
      { views: 0 },
      { views: -1 },
      { views: 1.5 },
      { views: "NaN" },
      { views: "Infinity" },
      { views: Number.MAX_SAFE_INTEGER + 1 },
      { views: 10, likes: -1 },
      { views: 10, comments: 1.2 },
      { views: 10, shares: "not-a-number" },
      { views: 10, orders: "Infinity" },
    ];

    for (const body of invalidBodies) {
      const res = await addMetric(jsonRequest(url, body, cookieA), routeParams(projectA));
      expect(res.status, JSON.stringify(body)).toBe(400);
    }

    const rows = await getDb().select().from(tables.publishMetrics);
    expect(rows).toHaveLength(0);
  });

  it("未标记发布的项目不能伪造效果数据", async () => {
    const res = await addMetric(
      jsonRequest(
        `http://test.local/api/project/${unpublishedProject}/metrics`,
        { views: 100, platform: "douyin" },
        cookieA
      ),
      routeParams(unpublishedProject)
    );
    expect(res.status).toBe(409);
  });

  it("真实回填仅使用服务端 publish_records 的发布时间", async () => {
    await getDb().insert(tables.publishRecords).values({
      id: "metrics-publish-record-a",
      merchantId: merchantA,
      projectId: projectA,
      approvedAt: publishedAt,
      publishedAt,
      platform: "douyin",
    });

    const res = await addMetric(
      jsonRequest(
        `http://test.local/api/project/${projectA}/metrics`,
        {
          views: "1234",
          likes: "56",
          comments: "",
          shares: 7,
          orders: 2,
          platform: "douyin",
          // 客户端伪造时间必须被忽略。
          publishedAt: Date.parse("2039-01-01T00:00:00.000Z"),
        },
        cookieA
      ),
      routeParams(projectA)
    );
    expect(res.status).toBe(200);

    const rows = await getDb().select().from(tables.publishMetrics);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ views: 1234, likes: 56, comments: 0, shares: 7, orders: 2 });
    expect(rows[0].publishedAt?.getTime()).toBe(publishedAt.getTime());

    const listed = await listMetrics(
      getRequest(`http://test.local/api/project/${projectA}/metrics`, cookieA),
      routeParams(projectA)
    );
    const payload = await listed.json();
    expect(payload.hasPerformanceData).toBe(true);
    expect(payload.metrics).toHaveLength(1);

    const update = await addMetric(
      jsonRequest(
        `http://test.local/api/project/${projectA}/metrics`,
        { views: 1500, likes: 60, comments: 3, shares: 8, orders: 4, platform: "douyin" },
        cookieA
      ),
      routeParams(projectA)
    );
    expect(update.status).toBe(200);
    const updatedRows = await getDb().select().from(tables.publishMetrics);
    expect(updatedRows).toHaveLength(1);
    expect(updatedRows[0]).toMatchObject({ views: 1500, likes: 60, comments: 3, shares: 8, orders: 4 });
  });

  it("黄金发布时段样本防御性排除历史全 0 marker", async () => {
    await getDb().insert(tables.publishMetrics).values({
      id: "legacy-zero-published-marker",
      projectId: projectA,
      style: "custom",
      views: 0,
      likes: 0,
      comments: 0,
      shares: 0,
      orders: 0,
      note: "manual_published_marker",
      publishedAt,
    });
    const { getMerchantPublishSamples } = await import("@backend/core/publish/reminder-context");
    const samples = await getMerchantPublishSamples(merchantA);
    expect(samples).toHaveLength(1);
    expect(samples[0].engagement).toBe(1500);
  });
});
