import { afterEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import {
  ADMIN_SESSION_MAX_AGE_SECONDS,
  createAdminToken,
  resolveAdminAuthConfig,
  verifyAdminToken,
} from "@server/admin/admin-auth";
import { POST as adminLogin } from "@/app/api/admin/auth/route";

function loginRequest(password: string): NextRequest {
  return new Request("http://localhost/api/admin/auth", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  }) as unknown as NextRequest;
}

function productionEnv(overrides: Partial<NodeJS.ProcessEnv> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: "production",
    CLIPFORGE_ADMIN_PASSWORD: "strong-password",
    CLIPFORGE_ADMIN_SESSION_SECRET: "independent-session-secret",
  };
  return Object.assign(env, overrides);
}

describe("administrator authentication", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("disables production admin auth when password or session secret is missing", () => {
    expect(resolveAdminAuthConfig(productionEnv({ CLIPFORGE_ADMIN_PASSWORD: "" })).enabled).toBe(false);
    expect(resolveAdminAuthConfig(productionEnv({ CLIPFORGE_ADMIN_SESSION_SECRET: "" })).enabled).toBe(false);
  });

  it("disables production admin auth when password and session secret are identical", () => {
    const config = resolveAdminAuthConfig(productionEnv({
      CLIPFORGE_ADMIN_PASSWORD: "same-value",
      CLIPFORGE_ADMIN_SESSION_SECRET: "same-value",
    }));

    expect(config.enabled).toBe(false);
  });

  it("allows explicit development defaults without treating them as production configuration", () => {
    const config = resolveAdminAuthConfig({ NODE_ENV: "development" });

    expect(config).toMatchObject({ enabled: true, usesDevelopmentPassword: true });
  });

  it("creates unique signed tokens and rejects tampering or expiry", () => {
    const config = resolveAdminAuthConfig(productionEnv());
    const issuedAt = 1_700_000_000_000;
    const first = createAdminToken({ config, nowMs: issuedAt, nonce: "nonce-a" });
    const second = createAdminToken({ config, nowMs: issuedAt, nonce: "nonce-b" });
    const tampered = `${first.slice(0, -1)}${first.endsWith("a") ? "b" : "a"}`;

    expect(first).not.toBe(second);
    expect(verifyAdminToken(first, { config, nowMs: issuedAt + 1_000 })).toBe(true);
    expect(verifyAdminToken(tampered, { config, nowMs: issuedAt + 1_000 })).toBe(false);
    expect(verifyAdminToken(first, {
      config,
      nowMs: issuedAt + (ADMIN_SESSION_MAX_AGE_SECONDS + 1) * 1_000,
    })).toBe(false);
  });

  it("returns 503 instead of accepting a development password in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("CLIPFORGE_ADMIN_PASSWORD", "");
    vi.stubEnv("ADMIN_PASSWORD", "");
    vi.stubEnv("CLIPFORGE_ADMIN_SESSION_SECRET", "");
    vi.stubEnv("AUTH_SECRET", "");

    const response = await adminLogin(loginRequest("clipforge-admin"));

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ ok: false });
  });

  it("sets a secure finite admin cookie in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("CLIPFORGE_ADMIN_PASSWORD", "strong-password");
    vi.stubEnv("CLIPFORGE_ADMIN_SESSION_SECRET", "independent-session-secret");

    const response = await adminLogin(loginRequest("strong-password"));
    const cookie = response.headers.get("set-cookie") ?? "";

    expect(response.status).toBe(200);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=lax");
    expect(cookie).toContain(`Max-Age=${ADMIN_SESSION_MAX_AGE_SECONDS}`);
    expect(cookie).not.toContain("strong-password");
  });
});
