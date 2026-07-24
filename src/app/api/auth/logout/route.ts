import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, destroySession, clearSessionCookie } from "@backend/core/auth/session";

// 商家登出
export async function POST(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  if (token) {
    await destroySession(token);
  }
  const res = NextResponse.json({ success: true });
  clearSessionCookie(res);
  return res;
}
