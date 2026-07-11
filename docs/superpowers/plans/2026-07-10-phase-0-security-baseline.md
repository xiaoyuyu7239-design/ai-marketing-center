# Phase 0 Security Baseline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore a trustworthy test/CI baseline, make admin authentication fail closed, and prevent unfinished unauthenticated SaaS APIs from being accidentally exposed in production.

**Architecture:** Keep this phase independent from the later PostgreSQL migration. Repair stale tests without changing production behavior, replace the fixed admin token with an expiring signed token, add a production-only API launch gate through Next.js 16 `proxy.ts`, and centralize security headers in `next.config.ts`. All new behavior is driven by pure functions with focused Vitest coverage.

**Tech Stack:** Next.js 16.2.1, TypeScript 5, Vitest 4.1, Node.js crypto, GitHub Actions.

## Global Constraints

- Do not modify or overwrite `audit/2026-07-10-product-readiness/`.
- Do not bind an SMS, email, OAuth, payment, PostgreSQL hosting, storage, or queue vendor.
- Development remains usable locally; production fails closed when required authentication configuration is missing.
- `CLIPFORGE_ADMIN_PASSWORD` and `CLIPFORGE_ADMIN_SESSION_SECRET` are both required in production and must not be identical.
- The Phase 0 production business API gate has no environment-variable bypass; Phase 1 replaces it route-by-route with real authentication.
- Do not add more background work to Route Handlers.
- The workspace has no `.git`; preserve task-sized change boundaries and intended commit messages, but do not claim commits were created.
- Use `npm` for local verification because the current shell does not expose `pnpm`; CI remains pnpm-based as declared by `packageManager`.

---

### Task 1: Repair the three stale test suites

**Files:**
- Modify: `src/lib/__tests__/image-file.test.ts`
- Modify: `src/lib/stores/__tests__/stores.test.ts`
- Modify: `src/lib/__tests__/agent-generation-routes.test.ts`

**Interfaces:**
- Consumes: existing aliases `@frontend/*`, `@backend/*`, and the real route imports.
- Produces: tests that load the current directory layout and intercept the actual `@backend/providers` dependency.

- [ ] **Step 1: Re-run the three failing suites to preserve the red baseline**

Run:

```bash
npm test -- src/lib/__tests__/image-file.test.ts src/lib/stores/__tests__/stores.test.ts src/lib/__tests__/agent-generation-routes.test.ts
```

Expected: FAIL. The first two suites cannot resolve old relative imports; the Agent route suite makes real Atlas provider calls because it mocks `@/lib/providers` instead of `@backend/providers`.

- [ ] **Step 2: Replace only the stale imports and mock target**

Use these exact import blocks:

```ts
// src/lib/__tests__/image-file.test.ts
import { describe, expect, it } from "vitest";
import { isSupportedImageFile } from "@backend/shared/image-file";
```

```ts
// src/lib/stores/__tests__/stores.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { useProductLibraryStore } from "@frontend/stores/product-library-store";
import { useTemplateStore } from "@frontend/stores/template-store";
import { useBrandStore } from "@frontend/stores/brand-store";
import { useCharacterStore, useProjectStore } from "@frontend/stores/project-store";
import type { ProductItem } from "@frontend/stores/product-library-store";
import type { ScriptTemplate } from "@frontend/stores/template-store";
import type { Character } from "@frontend/stores/project-store";
import type { Shot } from "@backend/db/schema";
```

```ts
// src/lib/__tests__/agent-generation-routes.test.ts
vi.mock("@backend/providers", () => ({
  createProvider: mocks.createProvider,
}));
```

Do not change the production routes or test assertions in this task.

- [ ] **Step 3: Run the repaired suites**

Run:

```bash
npm test -- src/lib/__tests__/image-file.test.ts src/lib/stores/__tests__/stores.test.ts src/lib/__tests__/agent-generation-routes.test.ts
```

Expected: PASS. The Agent route tests must not log a real provider network failure.

- [ ] **Step 4: Run the complete unit suite**

Run:

```bash
npm test
```

Expected: 46 test files pass and 421 tests pass.

- [ ] **Step 5: Preserve the intended commit boundary**

The current ZIP workspace has no Git metadata. Once Git is restored, the intended commit is:

```bash
git add src/lib/__tests__/image-file.test.ts src/lib/stores/__tests__/stores.test.ts src/lib/__tests__/agent-generation-routes.test.ts
git commit -m "test: repair moved module imports"
```

### Task 2: Make administrator authentication fail closed

**Files:**
- Create: `src/lib/__tests__/admin-auth.test.ts`
- Modify: `服务器/admin/admin-auth.ts`
- Modify: `src/app/api/admin/auth/route.ts`
- Modify: `src/app/admin/layout.tsx`
- Modify: `前端/components/admin/admin-login.tsx`

**Interfaces:**
- Produces: `resolveAdminAuthConfig(env)`, `adminAuthConfigurationError()`, `createAdminToken(options)`, `verifyAdminToken(token, options)`, `verifyAdminPassword(password)`, and `ADMIN_SESSION_MAX_AGE_SECONDS`.
- Consumes: `CLIPFORGE_ADMIN_PASSWORD`, `ADMIN_PASSWORD`, `CLIPFORGE_ADMIN_SESSION_SECRET`, `AUTH_SECRET`, and `NODE_ENV`.

- [ ] **Step 1: Add failing tests for production configuration and signed token behavior**

Create `src/lib/__tests__/admin-auth.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the new test and verify the expected red state**

Run:

```bash
npm test -- src/lib/__tests__/admin-auth.test.ts
```

Expected: FAIL because the new configuration resolver, expiring token API, 503 behavior, and secure Cookie are not implemented.

- [ ] **Step 3: Replace the fixed-token implementation with fail-closed configuration and HMAC tokens**

Replace `服务器/admin/admin-auth.ts` with:

```ts
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
```

- [ ] **Step 4: Make the admin route and page expose a configuration error instead of a default production password**

Update `src/app/api/admin/auth/route.ts` to check configuration before password verification and set the production Cookie flag:

```ts
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
```

Update `src/app/admin/layout.tsx`:

```tsx
import type { Metadata } from "next";
import { AdminLogin } from "@frontend/components/admin/admin-login";
import { AdminShell } from "@frontend/components/admin/admin-shell";
import {
  adminAuthConfigurationError,
  isAdminSession,
  isDefaultAdminPassword,
} from "@server/admin/admin-auth";

export const metadata: Metadata = {
  title: "工作人员后台 | ClipForge",
};

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const configurationError = adminAuthConfigurationError();
  if (configurationError) {
    return <AdminLogin defaultPassword={false} configurationError={configurationError} />;
  }

  const authed = await isAdminSession();
  if (!authed) {
    return <AdminLogin defaultPassword={isDefaultAdminPassword()} />;
  }

  return <AdminShell>{children}</AdminShell>;
}
```

Replace `前端/components/admin/admin-login.tsx` with:

```tsx
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { LockKeyhole, LogIn } from "lucide-react";
import { Button } from "@frontend/components/ui/button";
import { Input } from "@frontend/components/ui/input";

export function AdminLogin({
  defaultPassword,
  configurationError,
}: {
  defaultPassword: boolean;
  configurationError?: string;
}) {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const login = async (event: React.FormEvent) => {
    event.preventDefault();
    setLoading(true);
    setError("");
    const res = await fetch("/api/admin/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    const data = await res.json().catch(() => ({}));
    setLoading(false);
    if (!res.ok) {
      setError(data.error || "登录失败");
      return;
    }
    router.refresh();
  };

  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6">
        <div className="mb-5 flex items-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <LockKeyhole className="size-5" />
          </div>
          <div>
            <h1 className="text-xl font-semibold">工作人员后台</h1>
            <p className="text-sm text-muted-foreground">
              {configurationError ? "后台认证配置不完整" : "请输入管理员口令继续"}
            </p>
          </div>
        </div>

        {configurationError ? (
          <div role="alert" className="rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
            <p className="font-semibold">后台未启用</p>
            <p className="mt-1">{configurationError}</p>
          </div>
        ) : (
          <form onSubmit={login} className="rounded-lg border border-border bg-card p-5 shadow-sm">
            <label className="text-xs text-muted-foreground" htmlFor="admin-password">
              管理员口令
            </label>
            <Input
              id="admin-password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="mt-1.5"
              autoFocus
            />
            {defaultPassword ? (
              <p className="mt-2 text-xs text-amber-400">
                当前未设置环境变量，开发默认口令为 clipforge-admin。
              </p>
            ) : null}
            {error ? <p className="mt-2 text-xs text-destructive">{error}</p> : null}
            <Button className="mt-4 w-full" disabled={!password.trim() || loading}>
              <LogIn className="size-4" />
              {loading ? "验证中" : "进入后台"}
            </Button>
          </form>
        )}
      </div>
    </main>
  );
}
```

- [ ] **Step 5: Run focused and full tests**

Run:

```bash
npm test -- src/lib/__tests__/admin-auth.test.ts
npm test
```

Expected: the focused suite passes, followed by all unit suites passing.

- [ ] **Step 6: Preserve the intended commit boundary**

```bash
git add src/lib/__tests__/admin-auth.test.ts 服务器/admin/admin-auth.ts src/app/api/admin/auth/route.ts src/app/admin/layout.tsx 前端/components/admin/admin-login.tsx
git commit -m "fix: make admin authentication fail closed"
```

Do not run these commands until Git metadata is restored.

### Task 3: Add the temporary production SaaS API launch gate

**Files:**
- Create: `服务器/security/saas-launch-gate.ts`
- Create: `src/proxy.ts`
- Create: `src/lib/__tests__/saas-launch-gate.test.ts`

**Interfaces:**
- Produces: `shouldBlockSaasApi(input)` and Next.js 16 named `proxy(request)`.
- Consumes: `NODE_ENV` and request pathname.

- [ ] **Step 1: Write failing unit and proxy-level tests**

Create `src/lib/__tests__/saas-launch-gate.test.ts`:

```ts
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

  it("blocks production business APIs until real user auth is ready", () => {
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
```

- [ ] **Step 2: Run the test and verify it fails because the gate does not exist**

Run:

```bash
npm test -- src/lib/__tests__/saas-launch-gate.test.ts
```

Expected: FAIL with unresolved imports for `@server/security/saas-launch-gate` and `@/proxy`.

- [ ] **Step 3: Implement the pure decision function**

Create `服务器/security/saas-launch-gate.ts`:

```ts
export type SaasLaunchGateInput = {
  nodeEnv: string | undefined;
  pathname: string;
};

export function shouldBlockSaasApi({ nodeEnv, pathname }: SaasLaunchGateInput) {
  if (nodeEnv !== "production") return false;
  if (!pathname.startsWith("/api/")) return false;
  return !pathname.startsWith("/api/admin/");
}
```

- [ ] **Step 4: Implement the Next.js 16 proxy**

Create `src/proxy.ts`:

```ts
import { NextRequest, NextResponse } from "next/server";
import { shouldBlockSaasApi } from "@server/security/saas-launch-gate";

export function proxy(request: NextRequest) {
  const blocked = shouldBlockSaasApi({
    nodeEnv: process.env.NODE_ENV,
    pathname: request.nextUrl.pathname,
  });

  if (blocked) {
    return NextResponse.json(
      {
        error: "服务端真实用户认证尚未启用，业务 API 已安全关闭。",
        code: "SAAS_AUTH_NOT_READY",
      },
      {
        status: 503,
        headers: { "Cache-Control": "no-store" },
      }
    );
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/api/:path*"],
};
```

- [ ] **Step 5: Run focused tests and the production build**

Run:

```bash
npm test -- src/lib/__tests__/saas-launch-gate.test.ts
npm run build
```

Expected: the focused suite passes and Next.js recognizes `src/proxy.ts` without the deprecated middleware warning.

- [ ] **Step 6: Preserve the intended commit boundary**

```bash
git add 服务器/security/saas-launch-gate.ts src/proxy.ts src/lib/__tests__/saas-launch-gate.test.ts
git commit -m "fix: close unfinished SaaS APIs in production"
```

Do not run these commands until Git metadata is restored.

### Task 4: Add production security response headers

**Files:**
- Create: `src/lib/__tests__/security-headers.test.ts`
- Modify: `next.config.ts`

**Interfaces:**
- Produces: exported `buildSecurityHeaders(nodeEnv)` and Next.js `headers()` configuration.
- Consumes: `NODE_ENV` only.

- [ ] **Step 1: Write failing tests for baseline and production-only headers**

Create `src/lib/__tests__/security-headers.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the test and verify the expected red state**

Run:

```bash
npm test -- src/lib/__tests__/security-headers.test.ts
```

Expected: FAIL because `buildSecurityHeaders` does not exist.

- [ ] **Step 3: Export the header builder and attach it to every Next.js response**

Replace `next.config.ts` with:

```ts
import type { NextConfig } from "next";

type SecurityHeader = { key: string; value: string };

export function buildSecurityHeaders(nodeEnv = process.env.NODE_ENV): SecurityHeader[] {
  const headers: SecurityHeader[] = [
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "X-Frame-Options", value: "DENY" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    {
      key: "Permissions-Policy",
      value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    },
  ];

  if (nodeEnv === "production") {
    headers.push(
      {
        key: "Strict-Transport-Security",
        value: "max-age=31536000; includeSubDomains",
      },
      {
        key: "Content-Security-Policy-Report-Only",
        value: [
          "default-src 'self'",
          "base-uri 'self'",
          "form-action 'self'",
          "frame-ancestors 'none'",
          "img-src 'self' data: blob: https:",
          "media-src 'self' blob: https:",
          "font-src 'self' data: https:",
          "style-src 'self' 'unsafe-inline' https:",
          "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
          "connect-src 'self' https: wss:",
        ].join("; "),
      }
    );
  }

  return headers;
}

const nextConfig: NextConfig = {
  output: "standalone",
  serverExternalPackages: ["better-sqlite3"],
  async headers() {
    return [{ source: "/:path*", headers: buildSecurityHeaders() }];
  },
};

export default nextConfig;
```

- [ ] **Step 4: Run focused tests and build**

Run:

```bash
npm test -- src/lib/__tests__/security-headers.test.ts
npm run build
```

Expected: the test passes and the build exits 0. CSP remains report-only; do not claim it is enforced.

- [ ] **Step 5: Preserve the intended commit boundary**

```bash
git add next.config.ts src/lib/__tests__/security-headers.test.ts
git commit -m "fix: add production security headers"
```

Do not run these commands until Git metadata is restored.

### Task 5: Add type checking to the local and CI baseline

**Files:**
- Create: `src/lib/__tests__/ci-baseline.test.ts`
- Modify: `package.json`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Produces: `npm run typecheck` locally and `pnpm typecheck` in CI.
- Consumes: the existing TypeScript configuration without emitting files.

- [ ] **Step 1: Write a failing configuration test**

Create `src/lib/__tests__/ci-baseline.test.ts`:

```ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, expect, it } from "vitest";
import packageJson from "../../../package.json";

describe("CI baseline", () => {
  it("defines typecheck locally and runs it in GitHub Actions", () => {
    const workflow = readFileSync(resolve(process.cwd(), ".github/workflows/ci.yml"), "utf8");

    expect(packageJson.scripts.typecheck).toBe("tsc --noEmit");
    expect(workflow).toContain("run: pnpm typecheck");
  });
});
```

- [ ] **Step 2: Run the test and verify it fails on both missing entries**

Run:

```bash
npm test -- src/lib/__tests__/ci-baseline.test.ts
```

Expected: FAIL because `package.json` has no `typecheck` script and CI does not call it.

- [ ] **Step 3: Add the script and workflow step**

Add this package script next to `lint` and `test`:

```json
"typecheck": "tsc --noEmit"
```

Add this CI step after lint and before unit tests:

```yaml
      - name: TypeScript 类型检查
        run: pnpm typecheck
```

- [ ] **Step 4: Run the configuration test and actual type checker**

Run:

```bash
npm test -- src/lib/__tests__/ci-baseline.test.ts
npm run typecheck
```

Expected: both commands exit 0. If type checking reveals existing errors, report the exact errors and create a separate root-cause task rather than weakening `strict` or adding broad exclusions.

- [ ] **Step 5: Preserve the intended commit boundary**

```bash
git add package.json .github/workflows/ci.yml src/lib/__tests__/ci-baseline.test.ts
git commit -m "ci: add explicit TypeScript checking"
```

Do not run these commands until Git metadata is restored.

### Task 6: Verify the complete Phase 0 baseline

**Files:**
- Verify only; do not add unrelated changes.

**Interfaces:**
- Consumes: every deliverable from Tasks 1-5.
- Produces: fresh evidence for unit tests, typecheck, lint, build, and the actual change inventory.

- [ ] **Step 1: Run all unit tests**

Run:

```bash
npm test
```

Expected: 0 failed test files and 0 failed tests.

- [ ] **Step 2: Run TypeScript checking**

Run:

```bash
npm run typecheck
```

Expected: exit 0 with no TypeScript errors.

- [ ] **Step 3: Run lint**

Run:

```bash
npm run lint
```

Expected: exit 0. Report the actual warning count; do not describe warnings as clean output.

- [ ] **Step 4: Run the production build**

Run:

```bash
npm run build
```

Expected: exit 0. Report any Next.js tracing, font, metadata, or proxy warnings verbatim.

- [ ] **Step 5: Review scope and launch claims**

Confirm all of the following by inspecting the final files:

```text
Audit directory unchanged.
No external vendor dependency added.
No business schema or SQLite migration changed.
Production admin auth has no default password fallback.
Production business APIs return 503 with no environment-variable bypass.
CSP is report-only, not enforced.
No claim is made that Phase 0 provides real user authentication or tenant isolation.
```

- [ ] **Step 6: Record the change inventory**

Because Git is unavailable, use exact file listing and checksums in the handoff. Once Git is restored, the intended aggregate commit command is:

```bash
git add src/lib/__tests__ src/lib/stores/__tests__/stores.test.ts 服务器/admin/admin-auth.ts 服务器/security/saas-launch-gate.ts src/app/api/admin/auth/route.ts src/app/admin/layout.tsx 前端/components/admin/admin-login.tsx src/proxy.ts next.config.ts package.json .github/workflows/ci.yml docs/superpowers
git commit -m "fix: establish phase zero SaaS security baseline"
```
