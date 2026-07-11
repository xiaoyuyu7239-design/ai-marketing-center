import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { shouldBlockSaasApi } from "@server/security/saas-launch-gate";
import { proxy } from "@/proxy";

describe("SaaS production launch gate", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("allows development API traffic", () => {
    expect(shouldBlockSaasApi({
      nodeEnv: "development",
      pathname: "/api/project",
    })).toBe(false);
  });

  it("blocks production business APIs until real user auth replaces the gate", () => {
    expect(shouldBlockSaasApi({
      nodeEnv: "production",
      pathname: "/api/project",
    })).toBe(true);
  });

  it("keeps fail-closed admin authentication reachable", () => {
    expect(shouldBlockSaasApi({
      nodeEnv: "production",
      pathname: "/api/admin/auth",
    })).toBe(false);
  });

  it("keeps the new user auth routes behind the production gate until database integration", () => {
    expect(shouldBlockSaasApi({
      nodeEnv: "production",
      pathname: "/api/auth/session",
    })).toBe(true);
    expect(shouldBlockSaasApi({
      nodeEnv: "production",
      pathname: "/api/auth/workspaces",
    })).toBe(true);
  });

  it("does not block non-API pages", () => {
    expect(shouldBlockSaasApi({
      nodeEnv: "production",
      pathname: "/start",
    })).toBe(false);
  });

  it("returns a non-cacheable 503 JSON response for blocked APIs", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const response = proxy(new NextRequest("http://localhost/api/project"));

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ code: "SAAS_AUTH_NOT_READY" });
  });
});
