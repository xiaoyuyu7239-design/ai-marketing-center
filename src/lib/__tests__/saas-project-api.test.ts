import { describe, expect, it, vi } from "vitest";
import type { SaasProjectRuntime } from "@backend/saas/db/project-runtime";
import {
  handleCreateProject,
  handleListProjects,
} from "@server/projects/api-handlers";
import type {
  CompleteAuthRepository,
  SessionAuthRecord,
  WorkspaceMembershipRecord,
} from "@server/auth/repository";
import { generateSessionToken, hashSessionToken } from "@server/auth/session-token";
import type { ProjectRepository } from "@server/projects/repository";

const NOW = new Date("2030-01-01T00:00:00.000Z");
const TOKEN = generateSessionToken();
const DIGEST = hashSessionToken(TOKEN);
const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";

const SESSION: SessionAuthRecord = {
  sessionId: "session-1",
  userId: "user-1",
  userStatus: "active",
  platformRole: "user",
  expiresAt: new Date("2030-01-02T00:00:00.000Z"),
  revokedAt: null,
};

const MEMBERSHIP: WorkspaceMembershipRecord = {
  workspaceId: WORKSPACE_ID,
  workspaceName: "Workspace A",
  workspaceStatus: "active",
  role: "owner",
};

const PROJECT = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  workspaceId: WORKSPACE_ID,
  name: "Project A",
  status: "draft" as const,
  contentType: "product" as const,
  topic: null,
  productName: "Product A",
  productCategory: null,
  productDescription: null,
  createdAt: NOW,
  updatedAt: NOW,
};

function request(options: {
  token?: string | null;
  workspaceId?: string;
  url?: string;
  body?: unknown;
} = {}) {
  const headers = new Headers();
  const token = options.token === undefined ? TOKEN : options.token;
  if (token !== null) headers.set("cookie", `clipforge_session=${token}`);
  if (options.workspaceId) headers.set("x-clipforge-workspace-id", options.workspaceId);
  if (options.body !== undefined) headers.set("content-type", "application/json");
  return new Request(options.url ?? "http://localhost/api/saas/projects", {
    method: options.body === undefined ? "GET" : "POST",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
}

function authRepository(membership: WorkspaceMembershipRecord | null = MEMBERSHIP): CompleteAuthRepository {
  return {
    findSessionByTokenDigest: vi.fn(async (digest) => digest === DIGEST ? SESSION : null),
    markSessionUsed: vi.fn(async () => undefined),
    findWorkspaceMembership: vi.fn(async (userId, workspaceId) => (
      userId === SESSION.userId && workspaceId === membership?.workspaceId
        ? membership
        : null
    )),
    listWorkspaceMemberships: vi.fn(async () => []),
    createSession: vi.fn(async () => "session-1"),
    revokeSessionByTokenDigest: vi.fn(async () => false),
    revokeSessionsForUser: vi.fn(async () => 0),
  };
}

function projectRepository(): ProjectRepository {
  return {
    listProjects: vi.fn(async () => ({ projects: [PROJECT], nextCursor: null })),
    createProject: vi.fn(async () => PROJECT),
  };
}

function runtime(
  auth: CompleteAuthRepository = authRepository(),
  projects: ProjectRepository = projectRepository(),
): SaasProjectRuntime {
  return {
    enabled: true,
    authRepository: auth,
    projectRepository: projects,
    close: vi.fn(async () => undefined),
  };
}

function dependencies(projectRuntime: SaasProjectRuntime) {
  return {
    runtime: projectRuntime,
    now: () => NOW,
    createRequestId: () => "request-1",
  };
}

describe("SaaS projects API handlers", () => {
  it("returns a stable 503 when PostgreSQL is not configured", async () => {
    const response = await handleListProjects(request(), dependencies({
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

  it("requires a valid session and active workspace membership", async () => {
    const anonymous = await handleListProjects(
      request({ token: null, workspaceId: WORKSPACE_ID }),
      dependencies(runtime()),
    );
    const foreignWorkspace = await handleListProjects(
      request({ workspaceId: "22222222-2222-4222-8222-222222222222" }),
      dependencies(runtime()),
    );
    expect(anonymous.status).toBe(401);
    expect(foreignWorkspace.status).toBe(403);
  });

  it("validates list limit and cursor before calling the repository", async () => {
    const projects = projectRepository();
    const invalidLimit = await handleListProjects(
      request({ workspaceId: WORKSPACE_ID, url: "http://localhost/api/saas/projects?limit=101" }),
      dependencies(runtime(authRepository(), projects)),
    );
    const invalidCursor = await handleListProjects(
      request({ workspaceId: WORKSPACE_ID, url: "http://localhost/api/saas/projects?cursor=bad" }),
      dependencies(runtime(authRepository(), projects)),
    );
    expect(invalidLimit.status).toBe(400);
    expect(invalidCursor.status).toBe(400);
    expect(projects.listProjects).not.toHaveBeenCalled();
  });

  it("lists projects only through the authenticated workspace", async () => {
    const projects = projectRepository();
    const response = await handleListProjects(
      request({ workspaceId: WORKSPACE_ID }),
      dependencies(runtime(authRepository(), projects)),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: { projects: [{ id: PROJECT.id, workspaceId: WORKSPACE_ID }], nextCursor: null },
      requestId: "request-1",
    });
    expect(projects.listProjects).toHaveBeenCalledWith(WORKSPACE_ID, {
      limit: 50,
      cursor: null,
    });
  });

  it("rejects unknown and server-controlled create fields", async () => {
    const projects = projectRepository();
    const response = await handleCreateProject(
      request({ workspaceId: WORKSPACE_ID, body: { name: "A", workspaceId: WORKSPACE_ID } }),
      dependencies(runtime(authRepository(), projects)),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "INVALID_PROJECT_INPUT" } });
    expect(projects.createProject).not.toHaveBeenCalled();
  });

  it("creates a project with normalized allowed input in the authenticated workspace", async () => {
    const projects = projectRepository();
    const response = await handleCreateProject(
      request({
        workspaceId: WORKSPACE_ID,
        body: { name: "  Project A  ", contentType: "product", productName: " Product A " },
      }),
      dependencies(runtime(authRepository(), projects)),
    );
    expect(response.status).toBe(201);
    expect(projects.createProject).toHaveBeenCalledWith(WORKSPACE_ID, {
      name: "Project A",
      contentType: "product",
      productName: "Product A",
    });
  });

  it("sanitizes unexpected database errors", async () => {
    const projects = projectRepository();
    vi.mocked(projects.listProjects).mockRejectedValueOnce(
      new Error("postgresql://app:secret@db/clipforge SELECT * FROM projects"),
    );
    const response = await handleListProjects(
      request({ workspaceId: WORKSPACE_ID }),
      dependencies(runtime(authRepository(), projects)),
    );
    expect(response.status).toBe(500);
    const body = JSON.stringify(await response.json());
    expect(body).toContain("PROJECT_INTERNAL_ERROR");
    expect(body).not.toContain("secret");
    expect(body).not.toContain("SELECT");
  });
});
