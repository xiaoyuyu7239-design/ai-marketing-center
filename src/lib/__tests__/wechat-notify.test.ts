import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { NextRequest } from "next/server";
import {
  buildTemplatePayload,
  parseWechatEventXml,
  verifyWechatSignature,
} from "@backend/core/notify/wechat";

const TOKEN = "unit-test-token";

/** 按微信规则自算合法签名：sha1(sort(token, timestamp, nonce)) */
function sign(timestamp: string, nonce: string, token = TOKEN): string {
  return createHash("sha1").update([token, timestamp, nonce].sort().join("")).digest("hex");
}

describe("verifyWechatSignature 签名校验", () => {
  it("合法签名 → true", () => {
    const timestamp = "1700000000";
    const nonce = "abc123";
    expect(verifyWechatSignature({ signature: sign(timestamp, nonce), timestamp, nonce }, TOKEN)).toBe(true);
  });

  it("签名错误 / 用错 token → false", () => {
    const timestamp = "1700000000";
    const nonce = "abc123";
    expect(verifyWechatSignature({ signature: "deadbeef", timestamp, nonce }, TOKEN)).toBe(false);
    expect(verifyWechatSignature({ signature: sign(timestamp, nonce, "other-token"), timestamp, nonce }, TOKEN)).toBe(false);
  });

  it("缺任一参数 → false", () => {
    expect(verifyWechatSignature({ signature: null, timestamp: "1", nonce: "n" }, TOKEN)).toBe(false);
    expect(verifyWechatSignature({ signature: "s", timestamp: null, nonce: "n" }, TOKEN)).toBe(false);
    expect(verifyWechatSignature({ signature: "s", timestamp: "1", nonce: null }, TOKEN)).toBe(false);
  });
});

describe("parseWechatEventXml 事件解析", () => {
  it("subscribe（CDATA）：剥掉 qrscene_ 前缀拿到 scene", () => {
    const xml =
      "<xml><ToUserName><![CDATA[gh_abc]]></ToUserName>" +
      "<FromUserName><![CDATA[openid-1]]></FromUserName>" +
      "<MsgType><![CDATA[event]]></MsgType>" +
      "<Event><![CDATA[subscribe]]></Event>" +
      "<EventKey><![CDATA[qrscene_bind:m-001]]></EventKey></xml>";
    expect(parseWechatEventXml(xml)).toEqual({ openId: "openid-1", event: "subscribe", sceneKey: "bind:m-001" });
  });

  it("SCAN（已关注再扫，非 CDATA）：EventKey 不带 qrscene_ 前缀，原样返回", () => {
    const xml =
      "<xml><FromUserName>openid-2</FromUserName>" +
      "<MsgType>event</MsgType>" +
      "<Event>SCAN</Event>" +
      "<EventKey>bind:m-002</EventKey></xml>";
    expect(parseWechatEventXml(xml)).toEqual({ openId: "openid-2", event: "SCAN", sceneKey: "bind:m-002" });
  });

  it("unsubscribe：没有 EventKey → sceneKey 为 null", () => {
    const xml =
      "<xml><FromUserName><![CDATA[openid-3]]></FromUserName>" +
      "<MsgType><![CDATA[event]]></MsgType>" +
      "<Event><![CDATA[unsubscribe]]></Event>" +
      "<EventKey><![CDATA[]]></EventKey></xml>";
    expect(parseWechatEventXml(xml)).toEqual({ openId: "openid-3", event: "unsubscribe", sceneKey: null });
  });

  it("非事件消息（普通文本）→ null", () => {
    const xml =
      "<xml><FromUserName><![CDATA[openid-4]]></FromUserName>" +
      "<MsgType><![CDATA[text]]></MsgType>" +
      "<Content><![CDATA[你好]]></Content></xml>";
    expect(parseWechatEventXml(xml)).toBeNull();
  });

  it("事件但缺 openid → null（残缺回调不往下走）", () => {
    const xml = "<xml><MsgType><![CDATA[event]]></MsgType><Event><![CDATA[subscribe]]></Event></xml>";
    expect(parseWechatEventXml(xml)).toBeNull();
  });
});

describe("buildTemplatePayload 模板消息组装", () => {
  const push = { title: "该发视频啦", body: "现在是你家客人最活跃的点，今天还差 2 条", date: "07-12 17:00-19:00" };

  it("默认字段映射：first/keyword1/keyword2/remark，remark 有兜底文案", () => {
    delete process.env.WECHAT_TEMPLATE_FIELDS;
    const payload = buildTemplatePayload("openid-1", push, { templateId: "TPL-1", linkBase: null }) as {
      touser: string;
      template_id: string;
      url?: string;
      data: Record<string, { value: string }>;
    };
    expect(payload.touser).toBe("openid-1");
    expect(payload.template_id).toBe("TPL-1");
    expect(payload.url).toBeUndefined(); // 没配 linkBase 就不带链接
    expect(payload.data.first.value).toBe(push.title);
    expect(payload.data.keyword1.value).toBe(push.body);
    expect(payload.data.keyword2.value).toBe(push.date);
    expect(payload.data.remark.value).toBe("点开看看今天发哪条");
  });

  it("WECHAT_TEMPLATE_FIELDS 覆盖部分字段名，未覆盖的沿用默认", () => {
    process.env.WECHAT_TEMPLATE_FIELDS = JSON.stringify({ title: "thing1", body: "thing2" });
    try {
      const payload = buildTemplatePayload("openid-1", push, { templateId: "TPL-1", linkBase: null }) as {
        data: Record<string, { value: string }>;
      };
      expect(payload.data.thing1.value).toBe(push.title);
      expect(payload.data.thing2.value).toBe(push.body);
      expect(payload.data.keyword2.value).toBe(push.date); // date 没覆盖 → 默认字段
    } finally {
      delete process.env.WECHAT_TEMPLATE_FIELDS;
    }
  });

  it("配了 linkBase → 带 url 指向站内待发布页", () => {
    delete process.env.WECHAT_TEMPLATE_FIELDS;
    const payload = buildTemplatePayload("openid-1", { ...push, remark: "点开挑一条发出去" }, {
      templateId: "TPL-1",
      linkBase: "https://demo.example.com",
    }) as { url?: string; data: Record<string, { value: string }> };
    expect(payload.url).toBe("https://demo.example.com/products");
    expect(payload.data.remark.value).toBe("点开挑一条发出去");
  });
});

describe("微信回调路由 /api/wechat/callback", () => {
  let dataDir: string;
  let callbackGet: typeof import("@/app/api/wechat/callback/route").GET;
  let callbackPost: typeof import("@/app/api/wechat/callback/route").POST;
  let merchantId: string;
  let merchantIdB: string;

  const callbackUrl = (extra = "") => {
    const timestamp = "1700000000";
    const nonce = "cb-nonce";
    return `http://test.local/api/wechat/callback?signature=${sign(timestamp, nonce)}&timestamp=${timestamp}&nonce=${nonce}${extra}`;
  };

  const postXml = (xml: string, url = callbackUrl()) =>
    callbackPost(new NextRequest(url, { method: "POST", headers: { "Content-Type": "text/xml" }, body: xml }));

  const subscribeXml = (openId: string, sceneKey: string, event = "subscribe") =>
    `<xml><FromUserName><![CDATA[${openId}]]></FromUserName><MsgType><![CDATA[event]]></MsgType><Event><![CDATA[${event}]]></Event><EventKey><![CDATA[${sceneKey}]]></EventKey></xml>`;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "clipforge-wechat-test-"));
    process.env.APP_DATA_DIR = dataDir;
    // 配齐服务号环境变量，getWechatConfig() 才不为 null；回调本身不出网，无需干跑开关
    process.env.WECHAT_APP_ID = "wx-test-appid";
    process.env.WECHAT_APP_SECRET = "wx-test-secret";
    process.env.WECHAT_CALLBACK_TOKEN = TOKEN;
    process.env.WECHAT_TEMPLATE_ID = "TPL-1";

    ({ GET: callbackGet, POST: callbackPost } = await import("@/app/api/wechat/callback/route"));
    const { POST: register } = await import("@/app/api/auth/register/route");

    const registerReq = (email: string) =>
      new NextRequest("http://test.local/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password: "pw123456" }),
      });
    ({ merchant: { id: merchantId } } = await (await register(registerReq("wechat-a@test.local"))).json());
    ({ merchant: { id: merchantIdB } } = await (await register(registerReq("wechat-b@test.local"))).json());
  });

  afterAll(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("GET 验签通过 → 原样返回 echostr 纯文本", async () => {
    const res = await callbackGet(new NextRequest(callbackUrl("&echostr=hello-wechat")));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("hello-wechat");
  });

  it("GET 验签失败 → 403", async () => {
    const res = await callbackGet(
      new NextRequest("http://test.local/api/wechat/callback?signature=bad&timestamp=1700000000&nonce=cb-nonce&echostr=x")
    );
    expect(res.status).toBe(403);
  });

  it("GET 未配置服务号 → 403", async () => {
    const saved = process.env.WECHAT_CALLBACK_TOKEN;
    delete process.env.WECHAT_CALLBACK_TOKEN;
    try {
      const res = await callbackGet(new NextRequest(callbackUrl("&echostr=x")));
      expect(res.status).toBe(403);
    } finally {
      process.env.WECHAT_CALLBACK_TOKEN = saved;
    }
  });

  it("POST subscribe + bind scene → 写入绑定，remark 默认'微信提醒'", async () => {
    const res = await postXml(subscribeXml("openid-boss", `qrscene_bind:${merchantId}`));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("success");

    const { getDb } = await import("@backend/db");
    const { wechatBindings } = await import("@backend/db/schema");
    const { eq } = await import("drizzle-orm");
    const rows = await getDb().select().from(wechatBindings).where(eq(wechatBindings.openId, "openid-boss"));
    expect(rows).toHaveLength(1);
    expect(rows[0].merchantId).toBe(merchantId);
    expect(rows[0].remark).toBe("微信提醒");
  });

  it("同一个微信 SCAN 另一家店的码 → 换绑（不新增行）", async () => {
    const res = await postXml(subscribeXml("openid-boss", `bind:${merchantIdB}`, "SCAN"));
    expect(await res.text()).toBe("success");

    const { getDb } = await import("@backend/db");
    const { wechatBindings } = await import("@backend/db/schema");
    const { eq } = await import("drizzle-orm");
    const rows = await getDb().select().from(wechatBindings).where(eq(wechatBindings.openId, "openid-boss"));
    expect(rows).toHaveLength(1);
    expect(rows[0].merchantId).toBe(merchantIdB);
  });

  it("scene 指向不存在的商家 → 不写入，但对微信仍回 success", async () => {
    const res = await postXml(subscribeXml("openid-ghost", "qrscene_bind:no-such-merchant"));
    expect(await res.text()).toBe("success");

    const { getDb } = await import("@backend/db");
    const { wechatBindings } = await import("@backend/db/schema");
    const { eq } = await import("drizzle-orm");
    const rows = await getDb().select().from(wechatBindings).where(eq(wechatBindings.openId, "openid-ghost"));
    expect(rows).toHaveLength(0);
  });

  it("POST unsubscribe → 删除绑定（取关即停止提醒）", async () => {
    const xml =
      "<xml><FromUserName><![CDATA[openid-boss]]></FromUserName><MsgType><![CDATA[event]]></MsgType><Event><![CDATA[unsubscribe]]></Event></xml>";
    const res = await postXml(xml);
    expect(await res.text()).toBe("success");

    const { getDb } = await import("@backend/db");
    const { wechatBindings } = await import("@backend/db/schema");
    const { eq } = await import("drizzle-orm");
    const rows = await getDb().select().from(wechatBindings).where(eq(wechatBindings.openId, "openid-boss"));
    expect(rows).toHaveLength(0);
  });

  it("POST 验签失败 → 403，不碰数据库", async () => {
    const res = await postXml(
      subscribeXml("openid-evil", `qrscene_bind:${merchantId}`),
      "http://test.local/api/wechat/callback?signature=bad&timestamp=1&nonce=n"
    );
    expect(res.status).toBe(403);
  });

  it("POST 乱码 body（解析不出事件）→ 仍回 success，不抛错", async () => {
    const res = await postXml("not-xml-at-all");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("success");
  });
});
