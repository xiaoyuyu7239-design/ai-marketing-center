import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { getDb } from "@backend/db";
import { wechatBindings } from "@backend/db/schema";
import { requireMerchant } from "@backend/core/auth/require-merchant";
import { createBindQr, isWechatConfigured } from "@backend/core/notify/wechat";

/**
 * 商家设置页的微信绑定管理：看已绑了谁、生成绑定二维码、解绑。
 * 绑定本身发生在扫码后的回调里（/api/wechat/callback），这里只管发起与查看。
 */

/**
 * GET /api/wechat/bind —— 当前商家的绑定列表。
 * 刻意不返回 openId：它是微信侧的用户标识，页面用不上，泄露出去只有坏处，辨认靠 remark。
 */
export async function GET(req: NextRequest) {
  const auth = await requireMerchant(req);
  if ("error" in auth) return auth.error;
  try {
    const db = getDb();
    const rows = await db
      .select({ id: wechatBindings.id, remark: wechatBindings.remark, createdAt: wechatBindings.createdAt })
      .from(wechatBindings)
      .where(eq(wechatBindings.merchantId, auth.merchant.id));
    return NextResponse.json({
      configured: isWechatConfigured(),
      bindings: rows.map((r) => ({
        id: r.id,
        remark: r.remark,
        createdAt: r.createdAt ? r.createdAt.toISOString() : null,
      })),
    });
  } catch (error) {
    console.error("读取微信绑定列表失败:", error);
    return NextResponse.json({ error: "绑定信息没读出来，刷新一下再试" }, { status: 500 });
  }
}

/**
 * POST /api/wechat/bind —— 生成绑定二维码（带参临时码，商家用微信扫一下就绑上）。
 * 返回 { qrImageUrl, expiresIn }，前端拿 url 直接展示图片并按 expiresIn 提示有效期。
 */
export async function POST(req: NextRequest) {
  const auth = await requireMerchant(req);
  if ("error" in auth) return auth.error;
  try {
    // 服务号是 SaaS 运维侧配置的，商家自己解决不了，提示语指向服务商而不是让老板去查文档
    if (!isWechatConfigured()) {
      return NextResponse.json({ error: "微信提醒还没开通，请联系你的服务商配置" }, { status: 503 });
    }
    const result = await createBindQr(auth.merchant.id);
    if (!result.ok) {
      console.error("生成微信绑定二维码失败:", result.error);
      return NextResponse.json({ error: "二维码没生成出来，稍等几秒再点一次" }, { status: 500 });
    }
    return NextResponse.json({ qrImageUrl: result.qrImageUrl, expiresIn: result.expiresIn });
  } catch (error) {
    console.error("生成微信绑定二维码失败:", error);
    return NextResponse.json({ error: "二维码没生成出来，稍等几秒再点一次" }, { status: 500 });
  }
}

/**
 * DELETE /api/wechat/bind —— 解绑。body: { bindingId }。
 * 删除条件带 merchantId 双重限定：拿到别家 bindingId 也删不动别人的绑定。
 */
export async function DELETE(req: NextRequest) {
  const auth = await requireMerchant(req);
  if ("error" in auth) return auth.error;
  try {
    const body = await req.json().catch(() => ({}));
    const bindingId = typeof body.bindingId === "string" ? body.bindingId : "";
    if (!bindingId) {
      return NextResponse.json({ error: "缺少 bindingId" }, { status: 400 });
    }
    const db = getDb();
    await db
      .delete(wechatBindings)
      .where(and(eq(wechatBindings.id, bindingId), eq(wechatBindings.merchantId, auth.merchant.id)));
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("解绑微信失败:", error);
    return NextResponse.json({ error: "解绑没成功，稍后再试一次" }, { status: 500 });
  }
}
