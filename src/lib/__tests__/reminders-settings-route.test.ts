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

describe("发布提醒设置 /api/reminders/settings", () => {
  let dataDir: string;
  let register: typeof import("@/app/api/auth/register/route").POST;
  let settingsGet: typeof import("@/app/api/reminders/settings/route").GET;
  let settingsPost: typeof import("@/app/api/reminders/settings/route").POST;
  let clampDailyTarget: typeof import("@/app/api/reminders/settings/route").clampDailyTarget;
  let cookie: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "clipforge-reminder-settings-test-"));
    process.env.APP_DATA_DIR = dataDir;
    // 清掉微信环境变量：wechatConfigured 的断言不受本机 env 影响
    delete process.env.WECHAT_APP_ID;
    delete process.env.WECHAT_APP_SECRET;
    delete process.env.WECHAT_CALLBACK_TOKEN;
    delete process.env.WECHAT_TEMPLATE_ID;
    ({ POST: register } = await import("@/app/api/auth/register/route"));
    ({ GET: settingsGet, POST: settingsPost, clampDailyTarget } = await import("@/app/api/reminders/settings/route"));

    const res = await register(
      jsonRequest("http://test.local/api/auth/register", "POST", {
        email: "reminder-settings@test.local",
        password: "pw123456",
        shopName: "提醒设置测试店",
      })
    );
    cookie = extractCookie(res);
  });

  afterAll(() => {
    delete process.env.APP_DATA_DIR;
    rmSync(dataDir, { recursive: true, force: true });
  });

  describe("clampDailyTarget 纯函数", () => {
    it("越界值夹紧到 1-5", () => {
      expect(clampDailyTarget(0)).toBe(1);
      expect(clampDailyTarget(-3)).toBe(1);
      expect(clampDailyTarget(6)).toBe(5);
      expect(clampDailyTarget(999)).toBe(5);
    });

    it("小数四舍五入取整", () => {
      expect(clampDailyTarget(2.4)).toBe(2);
      expect(clampDailyTarget(2.6)).toBe(3);
      expect(clampDailyTarget(5.4)).toBe(5);
      expect(clampDailyTarget(0.9)).toBe(1);
    });

    it("范围内整数原样返回，数字字符串也认", () => {
      expect(clampDailyTarget(1)).toBe(1);
      expect(clampDailyTarget(4)).toBe(4);
      expect(clampDailyTarget("4")).toBe(4);
    });

    it("非数字一律回默认 3", () => {
      expect(clampDailyTarget(NaN)).toBe(3);
      expect(clampDailyTarget(Infinity)).toBe(3);
      expect(clampDailyTarget("abc")).toBe(3);
      expect(clampDailyTarget("")).toBe(3);
      expect(clampDailyTarget(null)).toBe(3);
      expect(clampDailyTarget(undefined)).toBe(3);
      expect(clampDailyTarget({})).toBe(3);
    });
  });

  describe("GET/POST 集成", () => {
    it("未登录 → 401", async () => {
      const anonGet = await settingsGet(getRequest("http://test.local/api/reminders/settings"));
      expect(anonGet.status).toBe(401);
      const anonPost = await settingsPost(
        jsonRequest("http://test.local/api/reminders/settings", "POST", { dailyTarget: 2 })
      );
      expect(anonPost.status).toBe(401);
    });

    it("新商家 GET → 默认开关开、每天 3 条、行业模板时段", async () => {
      const res = await settingsGet(getRequest("http://test.local/api/reminders/settings", cookie));
      expect(res.status).toBe(200);
      const j = await res.json();
      expect(j.enabled).toBe(true);
      expect(j.dailyTarget).toBe(3);
      expect(j.wechatConfigured).toBe(false);
      expect(j.bindingCount).toBe(0);
      // 没建档品类 → 行业通用模板兜底，时段和大白话依据都得给出来
      expect(j.windowSource).toBe("category");
      expect(typeof j.windowBasis).toBe("string");
      expect(j.windows.length).toBeGreaterThan(0);
      expect(j.windows[0].label).toMatch(/^\d{2}:\d{2}-\d{2}:\d{2}$/);
      expect(typeof j.hint).toBe("string");
      expect(j.hint.length).toBeGreaterThan(0);
      expect(j.inventory).toEqual({ approvedUnpublished: 0, publishedToday: 0, remainingToday: 3 });
    });

    it("POST 越界条数被夹紧、开关可关，GET 能读回新值", async () => {
      const post = await settingsPost(
        jsonRequest("http://test.local/api/reminders/settings", "POST", { dailyTarget: 9, enabled: false }, cookie)
      );
      expect(post.status).toBe(200);
      expect((await post.json()).success).toBe(true);

      const res = await settingsGet(getRequest("http://test.local/api/reminders/settings", cookie));
      const j = await res.json();
      expect(j.dailyTarget).toBe(5); // 9 被夹到上限 5
      expect(j.enabled).toBe(false);
    });

    it("部分更新：只改条数不动开关", async () => {
      const post = await settingsPost(
        jsonRequest("http://test.local/api/reminders/settings", "POST", { dailyTarget: 2 }, cookie)
      );
      expect(post.status).toBe(200);

      const res = await settingsGet(getRequest("http://test.local/api/reminders/settings", cookie));
      const j = await res.json();
      expect(j.dailyTarget).toBe(2);
      expect(j.enabled).toBe(false); // 上一个用例关掉的开关不被这次部分更新影响
      expect(j.inventory.remainingToday).toBe(2); // 库存快照按新目标算
    });
  });
});
