import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getDb } from "@backend/db";
import { merchants } from "@backend/db/schema";
import { verifyPassword } from "@backend/core/auth/password";
import { createSession, setSessionCookie } from "@backend/core/auth/session";
import {
  consumeRateLimit,
  rateLimitResponse,
  requestClientIp,
} from "@backend/core/security/rate-limit";

// 商家登录
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");

    // IP 与邮箱必须是两个独立桶。若拼成 ip+email，攻击者可伪造转发 IP，
    // 对同一邮箱获得无限次撞库机会。
    const ipLimit = consumeRateLimit(`auth:login:ip:${requestClientIp(req)}`, {
      limit: 20,
      windowMs: 15 * 60 * 1_000,
    });
    const emailLimit = consumeRateLimit(`auth:login:email:${email}`, {
      limit: 10,
      windowMs: 15 * 60 * 1_000,
    });
    if (!ipLimit.allowed) return rateLimitResponse(ipLimit, "登录尝试过于频繁，请 15 分钟后再试");
    if (!emailLimit.allowed) return rateLimitResponse(emailLimit, "该邮箱登录尝试过于频繁，请 15 分钟后再试");

    const db = getDb();
    const rows = await db.select().from(merchants).where(eq(merchants.email, email));
    const merchant = rows[0];

    // 邮箱不存在和密码错误统一返回同一条提示，不透露"这个邮箱有没有注册过"
    if (!merchant || !(await verifyPassword(password, merchant.passwordHash))) {
      return NextResponse.json({ error: "邮箱或密码不正确" }, { status: 401 });
    }

    const { token, expiresAt } = await createSession(merchant.id);
    const res = NextResponse.json({
      merchant: { id: merchant.id, email: merchant.email, shopName: merchant.shopName, planId: merchant.planId },
    });
    setSessionCookie(res, token, expiresAt);
    return res;
  } catch (error) {
    console.error("商家登录失败:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "登录失败" },
      { status: 500 }
    );
  }
}
