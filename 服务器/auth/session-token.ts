import "server-only";

import { createHash, randomBytes } from "crypto";

export const AUTH_COOKIE_NAME = "clipforge_session";
export const AUTH_SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;
const SESSION_TOKEN_BYTES = 32;
const SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export type SessionCookieOptions = {
  httpOnly: true;
  secure: boolean;
  sameSite: "lax";
  path: "/";
  maxAge: number;
  expires?: Date;
};

export function generateSessionToken() {
  return randomBytes(SESSION_TOKEN_BYTES).toString("base64url");
}

export function isValidSessionToken(token: string) {
  return SESSION_TOKEN_PATTERN.test(token);
}

export function hashSessionToken(token: string) {
  if (!isValidSessionToken(token)) throw new Error("Invalid session token");
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function readSessionToken(request: Request) {
  const cookieHeader = request.headers.get("cookie");
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === AUTH_COOKIE_NAME) {
      return part.slice(separator + 1).trim();
    }
  }
  return null;
}

export function sessionCookieOptions(expires: Date, nodeEnv = process.env.NODE_ENV): SessionCookieOptions {
  return {
    httpOnly: true,
    secure: nodeEnv === "production",
    sameSite: "lax",
    path: "/",
    maxAge: AUTH_SESSION_MAX_AGE_SECONDS,
    expires,
  };
}

export function clearedSessionCookieOptions(nodeEnv = process.env.NODE_ENV): SessionCookieOptions {
  return {
    httpOnly: true,
    secure: nodeEnv === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  };
}
