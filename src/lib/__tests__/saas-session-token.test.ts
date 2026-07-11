import { describe, expect, it } from "vitest";
import {
  AUTH_COOKIE_NAME,
  AUTH_SESSION_MAX_AGE_SECONDS,
  clearedSessionCookieOptions,
  generateSessionToken,
  hashSessionToken,
  isValidSessionToken,
  sessionCookieOptions,
} from "@server/auth/session-token";

if (false) {
  // @ts-expect-error Session-token callers must not provide custom entropy.
  generateSessionToken(Buffer.alloc(32, 7));
}

describe("SaaS session-token primitives", () => {
  it("generates a 256-bit opaque base64url token and stores a SHA-256 digest", () => {
    const token = generateSessionToken();
    const secondToken = generateSessionToken();
    expect(isValidSessionToken(token)).toBe(true);
    expect(token).toHaveLength(43);
    expect(secondToken).not.toBe(token);
    expect(hashSessionToken(token)).toMatch(/^[a-f0-9]{64}$/);
    expect(hashSessionToken(token)).not.toContain(token);
  });

  it("rejects malformed tokens before hashing", () => {
    expect(isValidSessionToken("plain-session-id")).toBe(false);
    expect(() => hashSessionToken("plain-session-id")).toThrow("Invalid session token");
  });

  it("uses an HttpOnly, same-site, finite Cookie and enables Secure in production", () => {
    const expiresAt = new Date("2030-01-01T00:00:00.000Z");
    expect(AUTH_COOKIE_NAME).toBe("clipforge_session");
    expect(AUTH_SESSION_MAX_AGE_SECONDS).toBe(60 * 60 * 24 * 7);
    expect(sessionCookieOptions(expiresAt, "production")).toMatchObject({
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
      maxAge: AUTH_SESSION_MAX_AGE_SECONDS,
      expires: expiresAt,
    });
    expect(sessionCookieOptions(expiresAt, "development").secure).toBe(false);
    expect(clearedSessionCookieOptions("production")).toMatchObject({ maxAge: 0, secure: true });
  });
});
