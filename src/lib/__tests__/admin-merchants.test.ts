import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({ runAgentOperation: vi.fn() }));
vi.mock("@backend/core/agent/agent-strategy", () => ({
  runAgentOperation: mocks.runAgentOperation,
}));

function jsonRequest(url: string, method: string, body: unknown, cookie?: string): NextRequest {
  return new NextRequest(url, {
    method,
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

describe("运营后台 · 商家管理", () => {
  let dataDir: string;
  let adminCookie: string;
  let register: typeof import("@/app/api/auth/register/route").POST;
  let listMerchants: typeof import("@/app/api/admin/merchants/route").GET;
  let patchMerchant: typeof import("@/app/api/admin/merchants/route").PATCH;
  let listPlans: typeof import("@/app/api/admin/plans/route").GET;
  let createPlan: typeof import("@/app/api/admin/plans/route").POST;
  let merchantId: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "clipforge-admin-merchants-test-"));
    process.env.APP_DATA_DIR = dataDir;
    const { createAdminToken, ADMIN_COOKIE_NAME } = await import("@server/admin/admin-auth");
    adminCookie = `${ADMIN_COOKIE_NAME}=${createAdminToken()}`;
    ({ POST: register } = await import("@/app/api/auth/register/route"));
    ({ GET: listMerchants, PATCH: patchMerchant } = await import("@/app/api/admin/merchants/route"));
    ({ GET: listPlans, POST: createPlan } = await import("@/app/api/admin/plans/route"));

    const res = await register(jsonRequest("http://localhost/api/auth/register", "POST", { email: "boss@example.com", password: "password-123", shopName: "测试小店" }));
    merchantId = (await res.json()).merchant.id;
  });

  afterAll(() => {
    delete process.env.APP_DATA_DIR;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("未带 admin cookie 一律 401", async () => {
    expect((await listMerchants(jsonRequest("http://localhost/api/admin/merchants", "GET", undefined))).status).toBe(401);
    expect((await patchMerchant(jsonRequest("http://localhost/api/admin/merchants", "PATCH", { merchantId, quotaBonus: 5 }))).status).toBe(401);
    expect((await listPlans(jsonRequest("http://localhost/api/admin/plans", "GET", undefined))).status).toBe(401);
  });

  it("商家列表含套餐与用量信息；调套餐/赠额度生效且非法值被拒", async () => {
    const listRes = await listMerchants(jsonRequest("http://localhost/api/admin/merchants", "GET", undefined, adminCookie));
    expect(listRes.status).toBe(200);
    const { merchants } = await listRes.json();
    const me = merchants.find((m: { id: string }) => m.id === merchantId);
    expect(me).toBeTruthy();
    expect(me.planId).toBe("trial");
    expect(me.monthlyQuota).toBe(20);
    expect(me.usedThisMonth).toBe(0);

    // 非法套餐 → 400
    const badPlan = await patchMerchant(jsonRequest("http://localhost/api/admin/merchants", "PATCH", { merchantId, planId: "not-a-plan" }, adminCookie));
    expect(badPlan.status).toBe(400);
    // 非法赠送额度 → 400
    const badBonus = await patchMerchant(jsonRequest("http://localhost/api/admin/merchants", "PATCH", { merchantId, quotaBonus: -3 }, adminCookie));
    expect(badBonus.status).toBe(400);

    // 赠送 2 次额度
    const ok = await patchMerchant(jsonRequest("http://localhost/api/admin/merchants", "PATCH", { merchantId, quotaBonus: 2 }, adminCookie));
    expect(ok.status).toBe(200);
    const after = await (await listMerchants(jsonRequest("http://localhost/api/admin/merchants", "GET", undefined, adminCookie))).json();
    const meAfter = after.merchants.find((m: { id: string }) => m.id === merchantId);
    expect(meAfter.quotaBonus).toBe(2);
    expect(meAfter.monthlyQuota).toBe(22);
  });

  it("赠送额度进入配额计算：套餐 0 + 赠送 1 时恰好能再生成一次", async () => {
    // 新建 0 额度套餐并把商家切过去
    const created = await createPlan(
      jsonRequest("http://localhost/api/admin/plans", "POST", { id: "zero", name: "零额度", monthlyGenerationQuota: 0 }, adminCookie)
    );
    expect(created.status).toBe(201);
    await patchMerchant(jsonRequest("http://localhost/api/admin/merchants", "PATCH", { merchantId, planId: "zero", quotaBonus: 1 }, adminCookie));

    mocks.runAgentOperation.mockImplementation(async (_agentId, _label, operation) =>
      operation({ provider: "openai-compatible", baseUrl: "https://fake", apiKey: "k", model: "m" }, "prompt", false)
    );
    const { runMeteredAgentOperation, QuotaExceededError } = await import("@backend/core/auth/usage");

    // 赠送的 1 次可用
    await expect(runMeteredAgentOperation(merchantId, "script", "bonus-1", async () => "ok")).resolves.toBe("ok");
    // 第 2 次被配额拦截
    await expect(runMeteredAgentOperation(merchantId, "script", "bonus-2", async () => "no")).rejects.toBeInstanceOf(QuotaExceededError);
  });
});
