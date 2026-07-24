import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NextRequest } from "next/server";

import {
  consumeExpensiveRouteRateLimit,
  EXPENSIVE_RATE_LIMIT_PRESETS,
  rateLimitResponse,
  requestClientIp,
  resetRateLimitsForTests,
} from "@backend/core/security/rate-limit";

function request(url: string, body: unknown, ip: string): NextRequest {
  return new NextRequest(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-real-ip": ip,
    },
    body: JSON.stringify(body),
  });
}

describe("高成本入口统一 merchant/IP 双窗口限流", () => {
  beforeEach(() => {
    process.env.HUIMAI_RATE_LIMIT_TESTS = "1";
    process.env.HUIMAI_TRUST_PROXY = "1";
    process.env.HUIMAI_CLIENT_IP_HEADER = "x-real-ip";
    resetRateLimitsForTests();
  });

  afterAll(() => {
    delete process.env.HUIMAI_RATE_LIMIT_TESTS;
    delete process.env.HUIMAI_TRUST_PROXY;
    delete process.env.HUIMAI_CLIENT_IP_HEADER;
  });

  it("只信任受控 X-Real-IP，忽略客户端伪造的 CF/XFF", () => {
    const trusted = new NextRequest("http://test.local/x", {
      headers: {
        "x-real-ip": "203.0.113.10",
        "cf-connecting-ip": "198.51.100.99",
        "x-forwarded-for": "192.0.2.44, 192.0.2.45",
      },
    });
    expect(requestClientIp(trusted)).toBe("203.0.113.10");

    const invalid = new NextRequest("http://test.local/x", {
      headers: { "x-real-ip": "attacker-controlled" },
    });
    expect(requestClientIp(invalid)).toBe("unknown");

    delete process.env.HUIMAI_TRUST_PROXY;
    expect(requestClientIp(trusted)).toBe("untrusted-proxy");
    process.env.HUIMAI_TRUST_PROXY = "1";
  });

  it("更换 IP 不能绕过同一商户桶，429 带 Retry-After", () => {
    const options = { merchantBurst: 2, ipBurst: 100, merchantSustained: 100, ipSustained: 100 };
    expect(consumeExpensiveRouteRateLimit(request("http://test.local/x", {}, "203.0.113.1"), "merchant-a", "test", options).allowed).toBe(true);
    expect(consumeExpensiveRouteRateLimit(request("http://test.local/x", {}, "203.0.113.2"), "merchant-a", "test", options).allowed).toBe(true);
    const denied = consumeExpensiveRouteRateLimit(request("http://test.local/x", {}, "203.0.113.3"), "merchant-a", "test", options);
    expect(denied.allowed).toBe(false);
    const response = rateLimitResponse(denied);
    expect(response.status).toBe(429);
    expect(Number(response.headers.get("Retry-After"))).toBeGreaterThan(0);
  });

  it("更换商户不能绕过同一来源 IP 桶", () => {
    const options = { merchantBurst: 100, ipBurst: 2, merchantSustained: 100, ipSustained: 100 };
    expect(consumeExpensiveRouteRateLimit(request("http://test.local/x", {}, "203.0.113.9"), "merchant-a", "test", options).allowed).toBe(true);
    expect(consumeExpensiveRouteRateLimit(request("http://test.local/x", {}, "203.0.113.9"), "merchant-b", "test", options).allowed).toBe(true);
    expect(consumeExpensiveRouteRateLimit(request("http://test.local/x", {}, "203.0.113.9"), "merchant-c", "test", options).allowed).toBe(false);
  });

  it("单商户一次 9 镜视频批量不被误伤，第 13 次才触发分钟突发限制", () => {
    for (let index = 0; index < 12; index += 1) {
      expect(consumeExpensiveRouteRateLimit(
        request("http://test.local/api/ai/video", {}, "203.0.113.20"),
        "merchant-video-batch",
        "video-batch-boundary",
        EXPENSIVE_RATE_LIMIT_PRESETS.video,
      ).allowed).toBe(true);
    }

    expect(consumeExpensiveRouteRateLimit(
      request("http://test.local/api/ai/video", {}, "203.0.113.20"),
      "merchant-video-batch",
      "video-batch-boundary",
      EXPENSIVE_RATE_LIMIT_PRESETS.video,
    ).allowed).toBe(false);
  });

  it.each([
    ["image", EXPENSIVE_RATE_LIMIT_PRESETS.image],
    ["video", EXPENSIVE_RATE_LIMIT_PRESETS.video],
  ] as const)("10 个商户共享出口 IP 时 %s 合法突发不被聚合桶误伤", (_kind, options) => {
    for (let merchantIndex = 0; merchantIndex < 10; merchantIndex += 1) {
      for (let requestIndex = 0; requestIndex < options.merchantBurst; requestIndex += 1) {
        expect(consumeExpensiveRouteRateLimit(
          request("http://test.local/api/ai/shared-nat", {}, "198.51.100.20"),
          `merchant-shared-nat-${merchantIndex}`,
          `shared-nat-${_kind}`,
          options,
        ).allowed).toBe(true);
      }
    }
  });

  it.each(Object.entries(EXPENSIVE_RATE_LIMIT_PRESETS))(
    "%s 的共享 IP 双窗口至少容纳 10 个商户各自完整额度",
    (_kind, options) => {
      expect(options.ipBurst).toBeGreaterThanOrEqual(options.merchantBurst * 10);
      expect(options.ipSustained).toBeGreaterThanOrEqual(options.merchantSustained * 10);
    },
  );
});

describe("登录防撞库限流", () => {
  let dataDir: string;
  let login: typeof import("@/app/api/auth/login/route").POST;
  let adminLogin: typeof import("@/app/api/admin/auth/route").POST;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "huimai-rate-limit-auth-"));
    process.env.APP_DATA_DIR = dataDir;
    process.env.HUIMAI_RATE_LIMIT_TESTS = "1";
    process.env.HUIMAI_TRUST_PROXY = "1";
    process.env.HUIMAI_CLIENT_IP_HEADER = "x-real-ip";
    process.env.CLIPFORGE_ADMIN_PASSWORD = "test-admin-password-strong";
    process.env.CLIPFORGE_ADMIN_SESSION_SECRET = "test-admin-session-secret-that-is-long-enough";
    ({ POST: login } = await import("@/app/api/auth/login/route"));
    ({ POST: adminLogin } = await import("@/app/api/admin/auth/route"));
  });

  beforeEach(() => resetRateLimitsForTests());

  afterAll(() => {
    delete process.env.APP_DATA_DIR;
    delete process.env.HUIMAI_RATE_LIMIT_TESTS;
    delete process.env.HUIMAI_TRUST_PROXY;
    delete process.env.HUIMAI_CLIENT_IP_HEADER;
    delete process.env.CLIPFORGE_ADMIN_PASSWORD;
    delete process.env.CLIPFORGE_ADMIN_SESSION_SECRET;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("伪造不同转发 IP 仍会耗尽同一邮箱的独立 bucket", async () => {
    let response!: Response;
    for (let index = 0; index < 11; index += 1) {
      response = await login(request(
        "http://test.local/api/auth/login",
        { email: "victim@example.com", password: "wrong-password" },
        `203.0.113.${index + 1}`,
      ));
    }
    expect(response.status).toBe(429);
    expect(Number(response.headers.get("Retry-After"))).toBeGreaterThan(0);
  });

  it("管理员伪造 IP 仍受全局失败桶限制，正确口令不被该桶 DoS", async () => {
    let response!: Response;
    for (let index = 0; index < 61; index += 1) {
      response = await adminLogin(request(
        "http://test.local/api/admin/auth",
        { password: "wrong-password" },
        `198.51.100.${index + 1}`,
      ));
    }
    expect(response.status).toBe(429);
    expect(Number(response.headers.get("Retry-After"))).toBeGreaterThan(0);

    const valid = await adminLogin(request(
      "http://test.local/api/admin/auth",
      { password: "test-admin-password-strong" },
      "203.0.113.250",
    ));
    expect(valid.status).toBe(200);
  });
});

describe("高成本 HTTP 入口审计清单", () => {
  it("所有商户模型、付费与高 CPU POST 都调用统一双维度 helper", () => {
    const routes = [
      "src/app/api/ai/image/route.ts",
      "src/app/api/ai/video/route.ts",
      "src/app/api/tts/free/route.ts",
      "src/app/api/llm/script/route.ts",
      "src/app/api/topic/script/route.ts",
      "src/app/api/llm/publish/route.ts",
      "src/app/api/llm/publish-ranker/route.ts",
      "src/app/api/ingest/product/route.ts",
      "src/app/api/generation/operations/route.ts",
      "src/app/api/insights/weekly-report/route.ts",
      "src/app/api/project/[id]/diagnose/route.ts",
      "src/app/api/project/[id]/retro/route.ts",
      "src/app/api/project/[id]/image-pack/route.ts",
      "src/app/api/project/[id]/metrics/ocr/route.ts",
      "src/app/api/project/[id]/dub/route.ts",
      "src/app/api/project/[id]/compose/route.ts",
      "src/app/api/project/[id]/cover/route.ts",
      "src/app/api/project/[id]/preview-gif/route.ts",
      "src/app/api/project/[id]/carousel/route.ts",
      "src/app/api/project/[id]/end-card/route.ts",
      "src/app/api/project/[id]/export-platform/route.ts",
      "src/app/api/project/[id]/clean-images/route.ts",
      "src/app/api/upload/route.ts",
      "src/app/api/products/upload/route.ts",
      "src/app/api/project/[id]/materials/route.ts",
      "src/app/api/project/[id]/bgm/route.ts",
    ];
    for (const route of routes) {
      expect(readFileSync(join(process.cwd(), route), "utf8"), route).toContain("consumeExpensiveRouteRateLimit");
    }
  });

  it("后台/桌面旧供应商入口调用认证后 IP 双窗口 helper", () => {
    const routes = [
      "src/app/api/tts/route.ts",
      "src/app/api/llm/test/route.ts",
      "src/app/api/ai/test-provider/route.ts",
      "src/app/api/ai/models/route.ts",
      "src/app/api/ai/status/route.ts",
    ];
    for (const route of routes) {
      expect(readFileSync(join(process.cwd(), route), "utf8"), route).toContain("consumeAuthenticatedIpRateLimit");
    }
  });
});
