import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { NextRequest } from "next/server";
import { CURRENT_LEGAL_CONSENT } from "@backend/shared/legal-documents";

const AGREED = { accepted: true, ...CURRENT_LEGAL_CONSENT };

// 要用真正的 NextRequest（而非 new Request(...) 强转），.cookies 是 Next.js 在其上追加的能力，
// 普通 Request 没有这个属性，涉及 cookie 读取的路由测试不能用其它测试文件里那种轻量 jsonRequest 写法。
function jsonRequest(url: string, body: unknown, cookie?: string): NextRequest {
  return new NextRequest(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}

function getRequest(url: string, cookie?: string): NextRequest {
  return new NextRequest(url, {
    headers: cookie ? { Cookie: cookie } : {},
  });
}

/** 从 Set-Cookie 响应头里取出可以直接回填到下一个请求 Cookie 头的 "name=value" 片段 */
function extractCookie(res: Response): string | undefined {
  const setCookie = res.headers.get("set-cookie");
  if (!setCookie) return undefined;
  return setCookie.split(";")[0];
}

describe("商家账号体系 /api/auth", () => {
  let dataDir: string;
  let register: typeof import("@/app/api/auth/register/route").POST;
  let login: typeof import("@/app/api/auth/login/route").POST;
  let logout: typeof import("@/app/api/auth/logout/route").POST;
  let me: typeof import("@/app/api/auth/me/route").GET;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "clipforge-auth-test-"));
    process.env.APP_DATA_DIR = dataDir;
    process.env.HUIMAI_LEGAL_CONSENT_TESTS = "1";
    ({ POST: register } = await import("@/app/api/auth/register/route"));
    ({ POST: login } = await import("@/app/api/auth/login/route"));
    ({ POST: logout } = await import("@/app/api/auth/logout/route"));
    ({ GET: me } = await import("@/app/api/auth/me/route"));
  });

  afterAll(() => {
    delete process.env.APP_DATA_DIR;
    delete process.env.HUIMAI_LEGAL_CONSENT_TESTS;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("拒绝不合法的邮箱和过短的密码", async () => {
    const badEmail = await register(jsonRequest("http://localhost/api/auth/register", { email: "not-an-email", password: "longenough123" }));
    expect(badEmail.status).toBe(400);

    const shortPassword = await register(jsonRequest("http://localhost/api/auth/register", { email: "a@example.com", password: "short" }));
    expect(shortPassword.status).toBe(400);
  });

  it("拒绝未同意或提交旧版本协议", async () => {
    const missing = await register(jsonRequest("http://localhost/api/auth/register", {
      email: "missing-consent@example.com",
      password: "longenough123",
    }));
    expect(missing.status).toBe(400);

    const stale = await register(jsonRequest("http://localhost/api/auth/register", {
      email: "stale-consent@example.com",
      password: "longenough123",
      legalConsent: { ...AGREED, termsVersion: "terms-old" },
    }));
    expect(stale.status).toBe(409);
  });

  it("邀请内测开启首登建档门禁时拒绝空画像", async () => {
    process.env.HUIMAI_REQUIRE_ONBOARDING_PROFILE = "1";
    try {
      const response = await register(jsonRequest("http://localhost/api/auth/register", {
        email: "missing-profile@example.com",
        password: "longenough123",
        legalConsent: AGREED,
      }));
      expect(response.status).toBe(400);
      expect((await response.json()).error).toContain("店铺名");
    } finally {
      delete process.env.HUIMAI_REQUIRE_ONBOARDING_PROFILE;
    }
  });

  it("注册 → 登录 → /me → 登出 的完整会话闭环", async () => {
    const registerRes = await register(
      jsonRequest("http://localhost/api/auth/register", {
        email: "owner@example.com",
        password: "correct-horse-battery",
        shopName: "云柔纸品旗舰店",
        legalConsent: { ...AGREED, acceptedAt: "1999-01-01T00:00:00.000Z" },
      })
    );
    expect(registerRes.status).toBe(201);
    const registerCookie = extractCookie(registerRes);
    expect(registerCookie).toBeTruthy();

    // 用注册时下发的 cookie 直接能查到自己
    const meAfterRegister = await me(getRequest("http://localhost/api/auth/me", registerCookie));
    expect(meAfterRegister.status).toBe(200);
    const meData = await meAfterRegister.json();
    expect(meData.merchant.email).toBe("owner@example.com");
    expect(meData.merchant.shopName).toBe("云柔纸品旗舰店");
    expect(meData.merchant).not.toHaveProperty("passwordHash");

    // 重复邮箱注册应被拒绝
    const dupRes = await register(jsonRequest("http://localhost/api/auth/register", {
      email: "owner@example.com",
      password: "another-password-1",
      legalConsent: AGREED,
    }));
    expect(dupRes.status).toBe(409);

    // 错误密码登录应被拒绝
    const wrongLogin = await login(jsonRequest("http://localhost/api/auth/login", { email: "owner@example.com", password: "wrong-password" }));
    expect(wrongLogin.status).toBe(401);

    // 正确密码登录，应换发一个新 session
    const loginRes = await login(jsonRequest("http://localhost/api/auth/login", { email: "owner@example.com", password: "correct-horse-battery" }));
    expect(loginRes.status).toBe(200);
    const loginCookie = extractCookie(loginRes);
    expect(loginCookie).toBeTruthy();
    expect(loginCookie).not.toBe(registerCookie);

    const { getDb } = await import("@backend/db");
    const { legalConsentEvents } = await import("@backend/db/schema");
    const consentRows = await getDb().select().from(legalConsentEvents);
    expect(consentRows).toHaveLength(1);
    expect(consentRows[0]).toMatchObject(CURRENT_LEGAL_CONSENT);
    expect(consentRows[0].acceptedAt.getFullYear()).not.toBe(1999);

    // 登出后，旧 session 立即失效
    const logoutRes = await logout(jsonRequest("http://localhost/api/auth/logout", {}, loginCookie));
    expect(logoutRes.status).toBe(200);
    const meAfterLogout = await me(getRequest("http://localhost/api/auth/me", loginCookie));
    expect(meAfterLogout.status).toBe(401);
  });

  it("没有 session cookie 时 /me 返回 401", async () => {
    const res = await me(getRequest("http://localhost/api/auth/me"));
    expect(res.status).toBe(401);
  });
});
