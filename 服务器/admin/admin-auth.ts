import "server-only";

import { createHash } from "crypto";
import { cookies } from "next/headers";
import type { NextRequest } from "next/server";

export const ADMIN_COOKIE_NAME = "clipforge_admin_auth";

function adminPassword() {
  return process.env.CLIPFORGE_ADMIN_PASSWORD || process.env.ADMIN_PASSWORD || "clipforge-admin";
}

function adminSecret() {
  return process.env.CLIPFORGE_ADMIN_SESSION_SECRET || process.env.AUTH_SECRET || adminPassword();
}

export function isDefaultAdminPassword() {
  return !process.env.CLIPFORGE_ADMIN_PASSWORD && !process.env.ADMIN_PASSWORD;
}

export function createAdminToken() {
  return createHash("sha256").update(`${adminPassword()}::${adminSecret()}`).digest("hex");
}

export function verifyAdminPassword(password: string) {
  return password === adminPassword();
}

export function verifyAdminToken(token?: string | null) {
  return Boolean(token && token === createAdminToken());
}

export async function isAdminSession() {
  const cookieStore = await cookies();
  return verifyAdminToken(cookieStore.get(ADMIN_COOKIE_NAME)?.value);
}

export function isAdminRequest(req: NextRequest) {
  return verifyAdminToken(req.cookies.get(ADMIN_COOKIE_NAME)?.value);
}
