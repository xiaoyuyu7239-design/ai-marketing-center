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

describe("待发布库服务端持久化 /api/publish-records", () => {
  let dataDir: string;
  let register: typeof import("@/app/api/auth/register/route").POST;
  let createProject: typeof import("@/app/api/project/route").POST;
  let listRecords: typeof import("@/app/api/publish-records/route").GET;
  let mutateRecord: typeof import("@/app/api/publish-records/route").POST;
  let cookieA: string;
  let cookieB: string;
  let projectId: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "clipforge-publish-records-test-"));
    process.env.APP_DATA_DIR = dataDir;
    ({ POST: register } = await import("@/app/api/auth/register/route"));
    ({ POST: createProject } = await import("@/app/api/project/route"));
    ({ GET: listRecords, POST: mutateRecord } = await import("@/app/api/publish-records/route"));

    cookieA = extractCookie(
      await register(jsonRequest("http://localhost/api/auth/register", "POST", { email: "pub-a@example.com", password: "password-a-123" }))
    );
    cookieB = extractCookie(
      await register(jsonRequest("http://localhost/api/auth/register", "POST", { email: "pub-b@example.com", password: "password-b-123" }))
    );
    const created = await createProject(jsonRequest("http://localhost/api/project", "POST", { name: "A的项目", productName: "A商品" }, cookieA));
    projectId = (await created.json()).id;
  });

  afterAll(() => {
    delete process.env.APP_DATA_DIR;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("未登录访问一律 401", async () => {
    expect((await listRecords(getRequest("http://localhost/api/publish-records"))).status).toBe(401);
    expect((await mutateRecord(jsonRequest("http://localhost/api/publish-records", "POST", { projectId, action: "approve" }))).status).toBe(401);
  });

  it("认可入库 → 标记发布 → 移出库存 的完整生命周期", async () => {
    // 认可入库
    const approveRes = await mutateRecord(jsonRequest("http://localhost/api/publish-records", "POST", { projectId, action: "approve" }, cookieA));
    expect(approveRes.status).toBe(200);
    let records = (await (await listRecords(getRequest("http://localhost/api/publish-records", cookieA))).json()).records;
    expect(records).toHaveLength(1);
    expect(records[0].projectId).toBe(projectId);
    expect(records[0].approvedAt).toBeTruthy();
    expect(records[0].publishedAt).toBeNull();

    // 标记发布（带平台）
    await mutateRecord(jsonRequest("http://localhost/api/publish-records", "POST", { projectId, action: "publish", platform: "douyin" }, cookieA));
    records = (await (await listRecords(getRequest("http://localhost/api/publish-records", cookieA))).json()).records;
    expect(records[0].publishedAt).toBeTruthy();
    expect(records[0].platform).toBe("douyin");

    // 取消发布标记：入库状态保留
    await mutateRecord(jsonRequest("http://localhost/api/publish-records", "POST", { projectId, action: "unpublish" }, cookieA));
    records = (await (await listRecords(getRequest("http://localhost/api/publish-records", cookieA))).json()).records;
    expect(records[0].publishedAt).toBeNull();
    expect(records[0].approvedAt).toBeTruthy();

    // 移出库存：整条记录删除
    await mutateRecord(jsonRequest("http://localhost/api/publish-records", "POST", { projectId, action: "unapprove" }, cookieA));
    records = (await (await listRecords(getRequest("http://localhost/api/publish-records", cookieA))).json()).records;
    expect(records).toHaveLength(0);
  });

  it("商家 B 无法操作商家 A 的项目，也看不到 A 的记录", async () => {
    await mutateRecord(jsonRequest("http://localhost/api/publish-records", "POST", { projectId, action: "approve" }, cookieA));

    const crossRes = await mutateRecord(jsonRequest("http://localhost/api/publish-records", "POST", { projectId, action: "approve" }, cookieB));
    expect(crossRes.status).toBe(404);

    const recordsB = (await (await listRecords(getRequest("http://localhost/api/publish-records", cookieB))).json()).records;
    expect(recordsB).toHaveLength(0);
  });

  it("非法 action 返回 400", async () => {
    const res = await mutateRecord(jsonRequest("http://localhost/api/publish-records", "POST", { projectId, action: "destroy-all" }, cookieA));
    expect(res.status).toBe(400);
  });
});
