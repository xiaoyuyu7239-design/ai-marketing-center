import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getDb } from "@backend/db";
import { merchants, wechatBindings } from "@backend/db/schema";
import {
  BIND_SCENE_PREFIX,
  getWechatConfig,
  parseWechatEventXml,
  verifyWechatSignature,
  type WechatEvent,
} from "@backend/core/notify/wechat";

/**
 * 微信服务号"服务器配置"的回调端点 —— 这是微信服务器调过来的，没有商家登录态，
 * 鉴权只靠回调签名（Token 与服务号后台配置一致）。
 *
 * - GET：微信验证服务器地址用（保存配置时会调一次），验签通过原样回 echostr。
 * - POST：事件推送。目前只关心带参二维码的绑定（subscribe/SCAN + "bind:" scene）和取关。
 */

/** 验签失败/未配置统一 403：不是微信来的请求，直接拒之门外 */
function checkSignature(req: NextRequest): boolean {
  const config = getWechatConfig();
  if (!config) return false;
  const sp = req.nextUrl.searchParams;
  return verifyWechatSignature(
    { signature: sp.get("signature"), timestamp: sp.get("timestamp"), nonce: sp.get("nonce") },
    config.callbackToken
  );
}

function plainText(body: string, status = 200): NextResponse {
  return new NextResponse(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });
}

export async function GET(req: NextRequest) {
  if (!checkSignature(req)) return plainText("forbidden", 403);
  // 微信要求原样返回 echostr 纯文本，包一层 JSON 都会导致验证失败
  return plainText(req.nextUrl.searchParams.get("echostr") ?? "");
}

export async function POST(req: NextRequest) {
  if (!checkSignature(req)) return plainText("forbidden", 403);
  try {
    const xml = await req.text();
    const event = parseWechatEventXml(xml);
    if (event) await handleEvent(event);
  } catch (error) {
    // 微信要求 5 秒内应答，返回非 "success" 会触发它重试三次（等于把失败放大三倍），
    // 所以处理失败只记日志，对微信永远说 success
    console.error("处理微信回调事件失败:", error);
  }
  return plainText("success");
}

async function handleEvent(event: WechatEvent): Promise<void> {
  const db = getDb();
  const eventName = event.event.toLowerCase();

  // 取关即停止提醒：绑定关系直接删掉，之后调度器自然不会再给这个 openid 推
  if (eventName === "unsubscribe") {
    await db.delete(wechatBindings).where(eq(wechatBindings.openId, event.openId));
    return;
  }

  // subscribe=扫码顺带关注 / SCAN=已关注再扫，两条路径都算绑定动作
  if (eventName !== "subscribe" && eventName !== "scan") return;
  if (!event.sceneKey?.startsWith(BIND_SCENE_PREFIX)) return;
  const merchantId = event.sceneKey.slice(BIND_SCENE_PREFIX.length);
  if (!merchantId) return;

  // scene 是外部可伪造的字符串，必须先确认商家真实存在，防止往库里塞悬空外键
  const [merchant] = await db.select({ id: merchants.id }).from(merchants).where(eq(merchants.id, merchantId));
  if (!merchant) {
    console.error(`微信绑定回调携带了不存在的商家 id（可能是二维码过期后商家已注销）: ${merchantId}`);
    return;
  }

  const [existing] = await db.select().from(wechatBindings).where(eq(wechatBindings.openId, event.openId));
  if (!existing) {
    await db.insert(wechatBindings).values({ merchantId, openId: event.openId, remark: "微信提醒" });
    return;
  }
  // 同一个微信改扫另一家店的码视为换绑（一个 openid 只归属一个商家）；
  // 旧备注是上一家店起的名字，跟着换绑一起重置，免得新店看到莫名其妙的备注
  if (existing.merchantId !== merchantId) {
    await db
      .update(wechatBindings)
      .set({ merchantId, remark: "微信提醒" })
      .where(eq(wechatBindings.openId, event.openId));
  }
  // 同一家店重复扫码：已绑定，保留原备注不动
}
