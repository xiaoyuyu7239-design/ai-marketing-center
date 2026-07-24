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

describe("商家建档 /api/auth/me PATCH", () => {
  let dataDir: string;
  let register: typeof import("@/app/api/auth/register/route").POST;
  let me: typeof import("@/app/api/auth/me/route").GET;
  let patchMe: typeof import("@/app/api/auth/me/route").PATCH;
  let cookie: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "clipforge-profile-test-"));
    process.env.APP_DATA_DIR = dataDir;
    ({ POST: register } = await import("@/app/api/auth/register/route"));
    ({ GET: me, PATCH: patchMe } = await import("@/app/api/auth/me/route"));
    const res = await register(jsonRequest("http://localhost/api/auth/register", "POST", { email: "profile@example.com", password: "password-123" }));
    cookie = res.headers.get("set-cookie")!.split(";")[0];
  });

  afterAll(() => {
    delete process.env.APP_DATA_DIR;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("建档画像可保存并在 GET /me 返回；敏感字段不可被 PATCH 篡改", async () => {
    const patchRes = await patchMe(
      jsonRequest("http://localhost/api/auth/me", "PATCH", {
        shopName: "云柔纸品旗舰店",
        category: "home",
        region: "杭州",
        targetAudience: "25-35岁宝妈",
        priceRange: "30-80元",
        platforms: "douyin,xiaohongshu",
        // 恶意字段：应被白名单丢弃
        planId: "unlimited",
        email: "hacked@example.com",
        passwordHash: "x",
      }, cookie)
    );
    expect(patchRes.status).toBe(200);

    const meRes = await me(getRequest("http://localhost/api/auth/me", cookie));
    const { merchant } = await meRes.json();
    expect(merchant.shopName).toBe("云柔纸品旗舰店");
    expect(merchant.category).toBe("home");
    expect(merchant.region).toBe("杭州");
    expect(merchant.targetAudience).toBe("25-35岁宝妈");
    expect(merchant.priceRange).toBe("30-80元");
    expect(merchant.platforms).toBe("douyin,xiaohongshu");
    // 白名单外字段不生效
    expect(merchant.planId).toBe("trial");
    expect(merchant.email).toBe("profile@example.com");
    expect(merchant).not.toHaveProperty("passwordHash");
  });

  it("非法品类被拒收(置空)，空串字段归 null", async () => {
    await patchMe(jsonRequest("http://localhost/api/auth/me", "PATCH", { category: "not-a-category", region: "  " }, cookie));
    const meRes = await me(getRequest("http://localhost/api/auth/me", cookie));
    const { merchant } = await meRes.json();
    expect(merchant.category).toBeNull();
    expect(merchant.region).toBeNull();
  });

  it("主投平台只保留支持的枚举并去重", async () => {
    await patchMe(jsonRequest("http://localhost/api/auth/me", "PATCH", {
      platforms: "douyin,unknown，xiaohongshu douyin",
    }, cookie));
    const { merchant } = await (await me(getRequest("http://localhost/api/auth/me", cookie))).json();
    expect(merchant.platforms).toBe("douyin,xiaohongshu");
  });

  it("本地门店画像可保存：门店类型/商圈/地址/绑定标签（标签归一化去 # 去重）", async () => {
    const res = await patchMe(
      jsonRequest("http://localhost/api/auth/me", "PATCH", {
        storeType: "local",
        landmark: "武林商圈",
        storeAddress: "文三路 259 号 1 层",
        customTags: "#杭州美甲, 滨江探店、#杭州美甲",
      }, cookie)
    );
    expect(res.status).toBe(200);
    const meRes = await me(getRequest("http://localhost/api/auth/me", cookie));
    const { merchant } = await meRes.json();
    expect(merchant.storeType).toBe("local");
    expect(merchant.landmark).toBe("武林商圈");
    expect(merchant.storeAddress).toBe("文三路 259 号 1 层");
    expect(merchant.customTags).toBe("杭州美甲,滨江探店");
  });

  it("非法门店类型被拒收(置空)", async () => {
    await patchMe(jsonRequest("http://localhost/api/auth/me", "PATCH", { storeType: "franchise" }, cookie));
    const meRes = await me(getRequest("http://localhost/api/auth/me", cookie));
    const { merchant } = await meRes.json();
    expect(merchant.storeType).toBeNull();
  });

  it("未登录 PATCH 返回 401", async () => {
    const res = await patchMe(jsonRequest("http://localhost/api/auth/me", "PATCH", { shopName: "x" }));
    expect(res.status).toBe(401);
  });
});
