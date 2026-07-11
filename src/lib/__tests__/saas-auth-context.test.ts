import { describe, expect, it, vi } from "vitest";
import {
  getOptionalAuthContext,
  requirePlatformAdmin,
  requireUser,
  requireWorkspace,
  requireWorkspaceRole,
  type AuthRepository,
  type SessionAuthRecord,
  type WorkspaceMembershipRecord,
} from "@server/auth/auth-context";
import { generateSessionToken, hashSessionToken } from "@server/auth/session-token";

const NOW = new Date("2030-01-01T00:00:00.000Z");
const TOKEN = generateSessionToken();
const TOKEN_DIGEST = hashSessionToken(TOKEN);

const activeSession: SessionAuthRecord = {
  sessionId: "session-1",
  userId: "user-1",
  userStatus: "active",
  platformRole: "user",
  expiresAt: new Date("2030-01-02T00:00:00.000Z"),
  revokedAt: null,
};

const activeMembership: WorkspaceMembershipRecord = {
  workspaceId: "workspace-1",
  workspaceName: "Store One",
  workspaceStatus: "active",
  role: "member",
};

function repository(
  session: SessionAuthRecord | null = activeSession,
  membership: WorkspaceMembershipRecord | null = activeMembership,
): AuthRepository {
  return {
    async findSessionByTokenDigest(tokenDigest) {
      return tokenDigest === TOKEN_DIGEST ? session : null;
    },
    async markSessionUsed() {},
    async findWorkspaceMembership(userId, workspaceId) {
      return userId === session?.userId && workspaceId === membership?.workspaceId ? membership : null;
    },
  };
}

function request(options: { token?: string | null; workspaceId?: string } = {}) {
  const headers = new Headers();
  const token = options.token === undefined ? TOKEN : options.token;
  if (token !== null) headers.set("cookie", `clipforge_session=${token}`);
  if (options.workspaceId) headers.set("x-clipforge-workspace-id", options.workspaceId);
  return new Request("http://localhost/api/project", { headers });
}

function dependencies(authRepository: AuthRepository) {
  return {
    repository: authRepository,
    now: () => NOW,
    createRequestId: () => "request-1",
  };
}

describe("SaaS AuthContext", () => {
  it("throttles persistent last-used tracking through the repository", async () => {
    const markSessionUsed = vi.fn(async () => undefined);
    const authRepository = { ...repository(), markSessionUsed };

    await getOptionalAuthContext(request(), dependencies(authRepository as AuthRepository));

    expect(markSessionUsed).toHaveBeenCalledWith("session-1", NOW);
  });

  it("returns null for absent, malformed, expired, revoked, or suspended sessions", async () => {
    await expect(getOptionalAuthContext(request({ token: null }), dependencies(repository()))).resolves.toBeNull();
    await expect(getOptionalAuthContext(request({ token: "plain-session-id" }), dependencies(repository()))).resolves.toBeNull();
    await expect(getOptionalAuthContext(request(), dependencies(repository({
      ...activeSession,
      expiresAt: NOW,
    })))).resolves.toBeNull();
    await expect(getOptionalAuthContext(request(), dependencies(repository({
      ...activeSession,
      revokedAt: new Date("2029-12-31T23:00:00.000Z"),
    })))).resolves.toBeNull();
    await expect(getOptionalAuthContext(request(), dependencies(repository({
      ...activeSession,
      userStatus: "suspended",
    })))).resolves.toBeNull();
  });

  it("returns a user context without a workspace when no workspace header is present", async () => {
    await expect(getOptionalAuthContext(request(), dependencies(repository()))).resolves.toMatchObject({
      requestId: "request-1",
      user: { id: "user-1", platformRole: "user" },
      session: { id: "session-1" },
      workspace: null,
    });
  });

  it("requires an authenticated user with AUTH_REQUIRED/401", async () => {
    await expect(requireUser(request({ token: null }), dependencies(repository()))).rejects.toMatchObject({
      status: 401,
      code: "AUTH_REQUIRED",
    });
  });

  it("requires an active workspace membership with WORKSPACE_FORBIDDEN/403", async () => {
    await expect(requireWorkspace(
      request({ workspaceId: "workspace-2" }),
      dependencies(repository(activeSession, null)),
    )).rejects.toMatchObject({ status: 403, code: "WORKSPACE_FORBIDDEN" });
  });

  it("accepts only explicitly allowed workspace roles", async () => {
    await expect(requireWorkspaceRole(
      request({ workspaceId: "workspace-1" }),
      ["owner"],
      dependencies(repository()),
    )).rejects.toMatchObject({ status: 403, code: "INSUFFICIENT_WORKSPACE_ROLE" });
    await expect(requireWorkspaceRole(
      request({ workspaceId: "workspace-1" }),
      ["member"],
      dependencies(repository()),
    )).resolves.toMatchObject({ workspace: { role: "member" } });
  });

  it("does not treat a workspace owner as a platform administrator", async () => {
    await expect(requirePlatformAdmin(
      request({ workspaceId: "workspace-1" }),
      dependencies(repository(activeSession, { ...activeMembership, role: "owner" })),
    )).rejects.toMatchObject({ status: 403, code: "PLATFORM_ADMIN_REQUIRED" });
  });

  it("allows a platform admin without granting an unrelated workspace membership", async () => {
    const adminSession = { ...activeSession, platformRole: "admin" } as const;
    await expect(requirePlatformAdmin(request(), dependencies(repository(adminSession, null))))
      .resolves.toMatchObject({ user: { platformRole: "admin" } });
    await expect(requireWorkspace(
      request({ workspaceId: "workspace-2" }),
      dependencies(repository(adminSession, null)),
    )).rejects.toMatchObject({ status: 403, code: "WORKSPACE_FORBIDDEN" });
  });
});
