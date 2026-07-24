import "server-only";

import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import { cookies } from "next/headers";
import type { NextRequest } from "next/server";
import { deploymentMode, singleUserModeEnabled } from "@backend/core/security/runtime-config";

export const ADMIN_COOKIE_NAME = "clipforge_admin_auth";
const ADMIN_TOKEN_TTL_MS = 8 * 60 * 60 * 1_000;
const DEVELOPMENT_PASSWORD = "clipforge-admin";

function isSaasProduction() {
  return process.env.NODE_ENV === "production" && deploymentMode() === "saas";
}

export function assertAdminConfiguration() {
  if (!isSaasProduction()) return;
  const password = process.env.CLIPFORGE_ADMIN_PASSWORD || process.env.ADMIN_PASSWORD;
  const secret = process.env.CLIPFORGE_ADMIN_SESSION_SECRET || process.env.AUTH_SECRET;
  if (!password || password.length < 16) {
    throw new Error("生产环境必须配置至少 16 位的 CLIPFORGE_ADMIN_PASSWORD");
  }
  if (!secret || secret.length < 32) {
    throw new Error("生产环境必须配置至少 32 位且独立的 CLIPFORGE_ADMIN_SESSION_SECRET");
  }
  if (password === secret) {
    throw new Error("CLIPFORGE_ADMIN_PASSWORD 与 CLIPFORGE_ADMIN_SESSION_SECRET 不得相同");
  }
}

function adminPassword() {
  assertAdminConfiguration();
  return process.env.CLIPFORGE_ADMIN_PASSWORD || process.env.ADMIN_PASSWORD || DEVELOPMENT_PASSWORD;
}

function adminSecret() {
  assertAdminConfiguration();
  return process.env.CLIPFORGE_ADMIN_SESSION_SECRET || process.env.AUTH_SECRET || `${DEVELOPMENT_PASSWORD}-dev-session-secret`;
}

export function isDefaultAdminPassword() {
  return !isSaasProduction() && !process.env.CLIPFORGE_ADMIN_PASSWORD && !process.env.ADMIN_PASSWORD;
}

export function createAdminToken() {
  const issuedAt = Date.now();
  const nonce = randomBytes(16).toString("base64url");
  const payload = `${issuedAt}.${nonce}`;
  const signature = createHmac("sha256", adminSecret()).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

export function verifyAdminPassword(password: string) {
  const expected = Buffer.from(adminPassword());
  const received = Buffer.from(password);
  return expected.length === received.length && timingSafeEqual(expected, received);
}

export function verifyAdminToken(token?: string | null) {
  if (!token) return false;
  const [issuedRaw, nonce, signature] = token.split(".");
  const issuedAt = Number(issuedRaw);
  if (!issuedRaw || !nonce || !signature || !Number.isFinite(issuedAt)) return false;
  if (issuedAt > Date.now() + 60_000 || Date.now() - issuedAt > ADMIN_TOKEN_TTL_MS) return false;
  const payload = `${issuedRaw}.${nonce}`;
  const expected = Buffer.from(createHmac("sha256", adminSecret()).update(payload).digest("base64url"));
  const received = Buffer.from(signature);
  return expected.length === received.length && timingSafeEqual(expected, received);
}

export async function isAdminSession() {
  const cookieStore = await cookies();
  return verifyAdminToken(cookieStore.get(ADMIN_COOKIE_NAME)?.value);
}

export function isAdminRequest(req: NextRequest) {
  return verifyAdminToken(req.cookies.get(ADMIN_COOKIE_NAME)?.value);
}

export function isAdminOrDesktopRequest(req: NextRequest) {
  return singleUserModeEnabled() || isAdminRequest(req);
}
