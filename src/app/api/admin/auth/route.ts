import { NextRequest, NextResponse } from "next/server";
import {
  ADMIN_COOKIE_NAME,
  createAdminToken,
  isDefaultAdminPassword,
  verifyAdminPassword,
} from "@server/admin/admin-auth";
import {
  consumeRateLimit,
  rateLimitResponse,
  requestClientIp,
} from "@backend/core/security/rate-limit";

export async function POST(req: NextRequest) {
  const ipLimit = consumeRateLimit(`auth:admin:ip:${requestClientIp(req)}`, { limit: 6, windowMs: 15 * 60 * 1_000 });
  if (!ipLimit.allowed) return rateLimitResponse(ipLimit, "管理员登录尝试过于频繁，请稍后再试");

  const body = await req.json().catch(() => ({}));
  const password = typeof body.password === "string" ? body.password : "";

  if (!verifyAdminPassword(password)) {
    // 只对失败口令消耗单实例全局桶：伪造转发 IP 也最多获得有限次猜测，
    // 同时不会因攻击者耗尽全局桶而阻断持有正确口令的管理员登录。
    const globalFailureLimit = consumeRateLimit("auth:admin:global:failed", {
      limit: 60,
      windowMs: 15 * 60 * 1_000,
    });
    if (!globalFailureLimit.allowed) {
      return rateLimitResponse(globalFailureLimit, "管理员登录失败次数过多，请稍后再试");
    }
    return NextResponse.json({ ok: false, error: "管理员口令不正确" }, { status: 401 });
  }

  const res = NextResponse.json({ ok: true, defaultPassword: isDefaultAdminPassword() });
  res.cookies.set({
    name: ADMIN_COOKIE_NAME,
    value: createAdminToken(),
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
    maxAge: 60 * 60 * 8,
  });
  return res;
}

export async function DELETE() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set({
    name: ADMIN_COOKIE_NAME,
    value: "",
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
    maxAge: 0,
  });
  return res;
}
