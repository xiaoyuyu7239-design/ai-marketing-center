import { describe, expect, it } from "vitest";
import { buildSecurityHeaders } from "../../../next.config";

function asRecord(headers: Array<{ key: string; value: string }>) {
  return Object.fromEntries(headers.map(({ key, value }) => [key, value]));
}

describe("security headers", () => {
  it("sets browser hardening headers in every environment", () => {
    const headers = asRecord(buildSecurityHeaders("development"));

    expect(headers["X-Content-Type-Options"]).toBe("nosniff");
    expect(headers["X-Frame-Options"]).toBe("DENY");
    expect(headers["Referrer-Policy"]).toBe("strict-origin-when-cross-origin");
    expect(headers["Permissions-Policy"]).toContain("camera=()");
  });

  it("adds HSTS and report-only CSP in production", () => {
    const headers = asRecord(buildSecurityHeaders("production"));

    expect(headers["Strict-Transport-Security"]).toContain("max-age=31536000");
    expect(headers["Content-Security-Policy-Report-Only"]).toContain("frame-ancestors 'none'");
  });

  it("does not send HSTS from local development", () => {
    const headers = asRecord(buildSecurityHeaders("development"));

    expect(headers["Strict-Transport-Security"]).toBeUndefined();
  });
});
