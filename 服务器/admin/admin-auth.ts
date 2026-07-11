import "server-only";

import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import { cookies } from "next/headers";
import type { NextRequest } from "next/server";

export const ADMIN_COOKIE_NAME = "clipforge_admin_auth";
export const ADMIN_SESSION_MAX_AGE_SECONDS = 60 * 60 * 8;

const DEV_ADMIN_PASSWORD = "clipforge-admin";
const DEV_ADMIN_SESSION_SECRET = "clipforge-admin-development-session-secret";

export type AdminAuthConfig =
  | {
      enabled: true;
      password: string;
      sessionSecret: string;
      usesDevelopmentPassword: boolean;
    }
  | {
      enabled: false;
      reason: string;
      usesDevelopmentPassword: false;
    };

type AdminTokenPayload = {
  version: 1;
  issuedAt: number;
  expiresAt: number;
  nonce: string;
};

type TokenOptions = {
  config?: AdminAuthConfig;
  nowMs?: number;
  nonce?: string;
};

function configuredValue(...values: Array<string | undefined>) {
  return values.find((value) => value?.trim())?.trim() ?? "";
}

function safeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export function resolveAdminAuthConfig(env: NodeJS.ProcessEnv = process.env): AdminAuthConfig {
  const production = env.NODE_ENV === "production";
  const password = configuredValue(env.CLIPFORGE_ADMIN_PASSWORD, env.ADMIN_PASSWORD);
  const sessionSecret = configuredValue(env.CLIPFORGE_ADMIN_SESSION_SECRET, env.AUTH_SECRET);

  if (production && (!password || !sessionSecret)) {
    return {
      enabled: false,
      reason: "后台认证未配置：生产环境必须同时设置管理员口令和独立 session secret。",
      usesDevelopmentPassword: false,
    };
  }

  if (production && password === sessionSecret) {
    return {
      enabled: false,
      reason: "后台认证配置无效：管理员口令和 session secret 不能相同。",
      usesDevelopmentPassword: false,
    };
  }

  return {
    enabled: true,
    password: password || DEV_ADMIN_PASSWORD,
    sessionSecret: sessionSecret || DEV_ADMIN_SESSION_SECRET,
    usesDevelopmentPassword: !password,
  };
}

export function adminAuthConfigurationError() {
  const config = resolveAdminAuthConfig();
  return config.enabled ? null : config.reason;
}

export function isDefaultAdminPassword() {
  const config = resolveAdminAuthConfig();
  return config.enabled && config.usesDevelopmentPassword;
}

function signPayload(encodedPayload: string, secret: string) {
  return createHmac("sha256", secret).update(encodedPayload).digest("base64url");
}

export function createAdminToken(options: TokenOptions = {}) {
  const config = options.config ?? resolveAdminAuthConfig();
  if (!config.enabled) throw new Error(config.reason);

  const issuedAt = Math.floor((options.nowMs ?? Date.now()) / 1_000);
  const payload: AdminTokenPayload = {
    version: 1,
    issuedAt,
    expiresAt: issuedAt + ADMIN_SESSION_MAX_AGE_SECONDS,
    nonce: options.nonce ?? randomBytes(16).toString("base64url"),
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = signPayload(encodedPayload, config.sessionSecret);
  return `v1.${encodedPayload}.${signature}`;
}

export function verifyAdminPassword(password: string) {
  const config = resolveAdminAuthConfig();
  return config.enabled && safeEqual(password, config.password);
}

export function verifyAdminToken(token?: string | null, options: TokenOptions = {}) {
  if (!token) return false;
  const config = options.config ?? resolveAdminAuthConfig();
  if (!config.enabled) return false;

  const [version, encodedPayload, signature, extra] = token.split(".");
  if (version !== "v1" || !encodedPayload || !signature || extra) return false;
  const expectedSignature = signPayload(encodedPayload, config.sessionSecret);
  if (!safeEqual(signature, expectedSignature)) return false;

  try {
    const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as AdminTokenPayload;
    const now = Math.floor((options.nowMs ?? Date.now()) / 1_000);
    return payload.version === 1
      && typeof payload.nonce === "string"
      && payload.nonce.length > 0
      && Number.isInteger(payload.issuedAt)
      && Number.isInteger(payload.expiresAt)
      && payload.issuedAt <= now + 60
      && payload.expiresAt > now
      && payload.expiresAt - payload.issuedAt === ADMIN_SESSION_MAX_AGE_SECONDS;
  } catch {
    return false;
  }
}

export async function isAdminSession() {
  const cookieStore = await cookies();
  return verifyAdminToken(cookieStore.get(ADMIN_COOKIE_NAME)?.value);
}

export function isAdminRequest(req: NextRequest) {
  return verifyAdminToken(req.cookies.get(ADMIN_COOKIE_NAME)?.value);
}
