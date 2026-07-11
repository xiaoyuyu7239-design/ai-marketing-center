import { NextRequest, NextResponse } from "next/server";
import {
  ADMIN_COOKIE_NAME,
  ADMIN_SESSION_MAX_AGE_SECONDS,
  adminAuthConfigurationError,
  createAdminToken,
  isDefaultAdminPassword,
  verifyAdminPassword,
} from "@server/admin/admin-auth";

export async function POST(req: NextRequest) {
  const configurationError = adminAuthConfigurationError();
  if (configurationError) {
    return NextResponse.json({ ok: false, error: configurationError }, { status: 503 });
  }

  const body = await req.json().catch(() => ({}));
  const password = typeof body.password === "string" ? body.password : "";

  if (!verifyAdminPassword(password)) {
    return NextResponse.json({ ok: false, error: "管理员口令不正确" }, { status: 401 });
  }

  const res = NextResponse.json({ ok: true, defaultPassword: isDefaultAdminPassword() });
  res.cookies.set({
    name: ADMIN_COOKIE_NAME,
    value: createAdminToken(),
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: ADMIN_SESSION_MAX_AGE_SECONDS,
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
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
  return res;
}
