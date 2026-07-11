import { describe, expect, it, vi } from "vitest";
import {
  handleDeleteSession,
  handleGetSession,
  handleGetWorkspaces,
} from "@server/auth/api-handlers";
import type { SaasAuthRuntime } from "@backend/saas/db/auth-runtime";
import type {
  CompleteAuthRepository,
  SessionAuthRecord,
  WorkspaceMembershipRecord,
} from "@server/auth/repository";
import { generateSessionToken, hashSessionToken } from "@server/auth/session-token";

const NOW = new Date("2030-01-01T00:00:00.000Z");
const TOKEN = generateSessionToken();
const TOKEN_DIGEST = hashSessionToken(TOKEN);

const ACTIVE_SESSION: SessionAuthRecord = {
  sessionId: "session-1",
  userId: "user-1",
  userStatus: "active",
  platformRole: "user",
  expiresAt: new Date("2030-01-02T00:00:00.000Z"),
  revokedAt: null,
};

const ACTIVE_MEMBERSHIP: WorkspaceMembershipRecord = {
  workspaceId: "workspace-1",
  workspaceName: "Store One",
  workspaceStatus: "active",
  role: "member",
};

function request(options: { token?: string | null; workspaceId?: string } = {}) {
  const headers = new Headers();
  const token = options.token === undefined ? TOKEN : options.token;
  if (token !== null) headers.set("cookie", `clipforge_session=${token}`);
  if (options.workspaceId) headers.set("x-clipforge-workspace-id", options.workspaceId);
  return new Request("http://localhost/api/auth/session", { headers });
}

function repository(): CompleteAuthRepository {
  return {
    findSessionByTokenDigest: vi.fn(async (digest) => (
      digest === TOKEN_DIGEST ? ACTIVE_SESSION : null
    )),
    markSessionUsed: vi.fn(async () => undefined),
    findWorkspaceMembership: vi.fn(async (userId, workspaceId) => (
      userId === "user-1" && workspaceId === "workspace-1"
        ? ACTIVE_MEMBERSHIP
        : null
    )),
    listWorkspaceMemberships: vi.fn(async (userId) => (
      userId === "user-1" ? [ACTIVE_MEMBERSHIP] : []
    )),
    createSession: vi.fn(async () => "session-1"),
    revokeSessionByTokenDigest: vi.fn(async () => true),
    revokeSessionsForUser: vi.fn(async () => 1),
  };
}

function runtime(authRepository: CompleteAuthRepository): SaasAuthRuntime {
  return { enabled: true, repository: authRepository, close: vi.fn(async () => undefined) };
}

function dependencies(authRuntime: SaasAuthRuntime) {
  return {
    runtime: authRuntime,
    now: () => NOW,
    createRequestId: () => "request-1",
  };
}

describe("SaaS auth API handlers", () => {
  it("returns a stable 503 error when PostgreSQL runtime is not configured", async () => {
    const response = await handleGetSession(request({ token: null }), dependencies({
      enabled: false,
      code: "AUTH_RUNTIME_NOT_CONFIGURED",
      reason: "DATABASE_URL is required",
    }));

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({
      error: { code: "AUTH_RUNTIME_NOT_CONFIGURED", requestId: "request-1" },
    });
  });

  it("returns anonymous and authenticated session payloads without exposing the token", async () => {
    const authRepository = repository();
    const anonymous = await handleGetSession(
      request({ token: null }),
      dependencies(runtime(authRepository)),
    );
    const authenticated = await handleGetSession(
      request({ workspaceId: "workspace-1" }),
      dependencies(runtime(authRepository)),
    );

    expect(anonymous.status).toBe(200);
    expect(await anonymous.json()).toMatchObject({
      data: { authenticated: false, user: null, session: null, workspace: null },
    });
    const body = await authenticated.json();
    expect(body).toMatchObject({
      data: {
        authenticated: true,
        user: { id: "user-1", platformRole: "user" },
        session: { id: "session-1", expiresAt: "2030-01-02T00:00:00.000Z" },
        workspace: { id: "workspace-1", name: "Store One", role: "member" },
      },
    });
    expect(JSON.stringify(body)).not.toContain(TOKEN);
  });

  it("requires a user and lists workspaces only for the authenticated user", async () => {
    const authRepository = repository();
    const unauthenticated = await handleGetWorkspaces(
      request({ token: null }),
      dependencies(runtime(authRepository)),
    );
    const authenticated = await handleGetWorkspaces(
      request(),
      dependencies(runtime(authRepository)),
    );

    expect(unauthenticated.status).toBe(401);
    expect(await unauthenticated.json()).toMatchObject({
      error: { code: "AUTH_REQUIRED" },
    });
    expect(authenticated.status).toBe(200);
    expect(await authenticated.json()).toMatchObject({
      data: { workspaces: [{ id: "workspace-1", name: "Store One", role: "member" }] },
    });
    expect(authRepository.listWorkspaceMemberships).toHaveBeenCalledWith("user-1");
  });

  it("revokes by digest and clears the session Cookie on logout", async () => {
    const authRepository = repository();
    const response = await handleDeleteSession(
      request(),
      dependencies(runtime(authRepository)),
    );

    expect(response.status).toBe(204);
    expect(authRepository.revokeSessionByTokenDigest).toHaveBeenCalledWith(
      TOKEN_DIGEST,
      NOW,
    );
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("clipforge_session=");
    expect(cookie).toContain("Max-Age=0");
    expect(cookie).not.toContain(TOKEN);
  });
});
