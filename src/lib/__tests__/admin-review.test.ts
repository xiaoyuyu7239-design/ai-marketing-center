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

describe("运营后台 · 内容审核队列", () => {
  let dataDir: string;
  let adminCookie: string;
  let merchantCookie: string;
  let projectId: string;
  let register: typeof import("@/app/api/auth/register/route").POST;
  let createProject: typeof import("@/app/api/project/route").POST;
  let mutateRecord: typeof import("@/app/api/publish-records/route").POST;
  let listMerchantRecords: typeof import("@/app/api/publish-records/route").GET;
  let listQueue: typeof import("@/app/api/admin/review/route").GET;
  let reviewAction: typeof import("@/app/api/admin/review/route").PATCH;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "clipforge-admin-review-test-"));
    process.env.APP_DATA_DIR = dataDir;
    const { createAdminToken, ADMIN_COOKIE_NAME } = await import("@server/admin/admin-auth");
    adminCookie = `${ADMIN_COOKIE_NAME}=${createAdminToken()}`;
    ({ POST: register } = await import("@/app/api/auth/register/route"));
    ({ POST: createProject } = await import("@/app/api/project/route"));
    ({ GET: listMerchantRecords, POST: mutateRecord } = await import("@/app/api/publish-records/route"));
    ({ GET: listQueue, PATCH: reviewAction } = await import("@/app/api/admin/review/route"));

    const registerRes = await register(
      jsonRequest("http://localhost/api/auth/register", "POST", { email: "review-boss@example.com", password: "password-123", shopName: "审核测试店" })
    );
    merchantCookie = registerRes.headers.get("set-cookie")!.split(";")[0];
    const projectRes = await createProject(jsonRequest("http://localhost/api/project", "POST", { name: "审核项目", productName: "审核商品" }, merchantCookie));
    projectId = (await projectRes.json()).id;
    // 商家自己认可入库（默认 reviewStatus=approved）
    await mutateRecord(jsonRequest("http://localhost/api/publish-records", "POST", { projectId, action: "approve" }, merchantCookie));
  });

  afterAll(() => {
    delete process.env.APP_DATA_DIR;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("未带 admin cookie 一律 401", async () => {
    expect((await listQueue(getRequest("http://localhost/api/admin/review"))).status).toBe(401);
    expect((await reviewAction(jsonRequest("http://localhost/api/admin/review", "PATCH", { recordId: "x", reviewStatus: "rejected" }))).status).toBe(401);
  });

  it("审核队列能看到商家入库的内容，驳回后从商家待发布消失、恢复通过后回来", async () => {
    // 队列里有这条，默认已通过（商家自审）
    const queueRes = await listQueue(getRequest("http://localhost/api/admin/review", adminCookie));
    expect(queueRes.status).toBe(200);
    const { records } = await queueRes.json();
    const target = records.find((r: { projectId: string }) => r.projectId === projectId);
    expect(target).toBeTruthy();
    expect(target.merchantEmail).toBe("review-boss@example.com");
    expect(target.reviewStatus).toBe("approved");

    // 先让商家把它标记为已发布，再驳回，验证驳回会清掉发布标记（避免"入库0/已发1"）
    await mutateRecord(jsonRequest("http://localhost/api/publish-records", "POST", { projectId, action: "publish", platform: "douyin" }, merchantCookie));

    // 驳回并带原因
    const rejectRes = await reviewAction(
      jsonRequest("http://localhost/api/admin/review", "PATCH", { recordId: target.recordId, reviewStatus: "rejected", reviewNote: "含广告法违禁词" }, adminCookie)
    );
    expect(rejectRes.status).toBe(200);

    // 商家端记录变为 rejected，带原因，且 approvedAt/publishedAt 已被清（口径统一）
    let merchantRecords = (await (await listMerchantRecords(getRequest("http://localhost/api/publish-records", merchantCookie))).json()).records;
    const rejectedRecord = merchantRecords.find((r: { projectId: string }) => r.projectId === projectId);
    expect(rejectedRecord?.reviewStatus).toBe("rejected");
    expect(rejectedRecord?.reviewNote).toBe("含广告法违禁词");
    expect(rejectedRecord?.approvedAt).toBeNull();
    expect(rejectedRecord?.publishedAt).toBeNull();

    // 按状态过滤
    const rejectedOnly = (await (await listQueue(getRequest("http://localhost/api/admin/review?status=rejected", adminCookie))).json()).records;
    expect(rejectedOnly.some((r: { projectId: string }) => r.projectId === projectId)).toBe(true);
    const approvedOnly = (await (await listQueue(getRequest("http://localhost/api/admin/review?status=approved", adminCookie))).json()).records;
    expect(approvedOnly.some((r: { projectId: string }) => r.projectId === projectId)).toBe(false);

    // 被驳回期间，商家不能通过"移出再入库"洗掉驳回：入库/发布直接 403
    const rewash = await mutateRecord(jsonRequest("http://localhost/api/publish-records", "POST", { projectId, action: "approve" }, merchantCookie));
    expect(rewash.status).toBe(403);
    const publishTry = await mutateRecord(jsonRequest("http://localhost/api/publish-records", "POST", { projectId, action: "publish" }, merchantCookie));
    expect(publishTry.status).toBe(403);
    // 移出库存允许（收起意图），但记录保留且仍是 rejected，不会被删行重建洗白
    const collapse = await mutateRecord(jsonRequest("http://localhost/api/publish-records", "POST", { projectId, action: "unapprove" }, merchantCookie));
    expect(collapse.status).toBe(200);
    const afterCollapse = (await (await listMerchantRecords(getRequest("http://localhost/api/publish-records", merchantCookie))).json()).records;
    const collapsedRecord = afterCollapse.find((r: { projectId: string }) => r.projectId === projectId);
    expect(collapsedRecord?.reviewStatus).toBe("rejected");
    const rewashAfterCollapse = await mutateRecord(jsonRequest("http://localhost/api/publish-records", "POST", { projectId, action: "approve" }, merchantCookie));
    expect(rewashAfterCollapse.status).toBe(403);

    // 恢复通过
    await reviewAction(jsonRequest("http://localhost/api/admin/review", "PATCH", { recordId: target.recordId, reviewStatus: "approved" }, adminCookie));
    merchantRecords = (await (await listMerchantRecords(getRequest("http://localhost/api/publish-records", merchantCookie))).json()).records;
    expect(merchantRecords.find((r: { projectId: string }) => r.projectId === projectId)?.reviewStatus).toBe("approved");

    // 非法状态被拒
    const bad = await reviewAction(jsonRequest("http://localhost/api/admin/review", "PATCH", { recordId: target.recordId, reviewStatus: "nuked" }, adminCookie));
    expect(bad.status).toBe(400);
  });
});
