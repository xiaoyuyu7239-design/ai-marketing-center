import { describe, expect, it, vi } from "vitest";
import { createSaasProjectRuntime } from "@backend/saas/db/project-runtime";
import type { CompleteAuthRepository } from "@server/auth/repository";
import type { ProjectRepository } from "@server/projects/repository";

function authRepository(): CompleteAuthRepository {
  return {
    findSessionByTokenDigest: vi.fn(async () => null),
    markSessionUsed: vi.fn(async () => undefined),
    findWorkspaceMembership: vi.fn(async () => null),
    listWorkspaceMemberships: vi.fn(async () => []),
    createSession: vi.fn(async () => "session-1"),
    revokeSessionByTokenDigest: vi.fn(async () => false),
    revokeSessionsForUser: vi.fn(async () => 0),
  };
}

function projectRepository(): ProjectRepository {
  return {
    listProjects: vi.fn(async () => ({ projects: [], nextCursor: null })),
    createProject: vi.fn(async () => { throw new Error("unused"); }),
  };
}

describe("SaaS project runtime", () => {
  it("stays disabled without constructing a pool when DATABASE_URL is absent", () => {
    const poolFactory = vi.fn();
    expect(createSaasProjectRuntime({}, { poolFactory })).toMatchObject({
      enabled: false,
      code: "AUTH_RUNTIME_NOT_CONFIGURED",
    });
    expect(poolFactory).not.toHaveBeenCalled();
  });

  it("binds auth and project repositories to one lazy pool", async () => {
    const pool = {
      query: vi.fn(),
      connect: vi.fn(),
      end: vi.fn(async () => undefined),
    };
    const auth = authRepository();
    const projects = projectRepository();
    const poolFactory = vi.fn(() => pool);
    const authRepositoryFactory = vi.fn(() => auth);
    const projectRepositoryFactory = vi.fn(() => projects);

    const runtime = createSaasProjectRuntime(
      { DATABASE_URL: "postgresql://app@db/clipforge" },
      { poolFactory, authRepositoryFactory, projectRepositoryFactory },
    );

    expect(runtime).toMatchObject({
      enabled: true,
      authRepository: auth,
      projectRepository: projects,
    });
    expect(poolFactory).toHaveBeenCalledTimes(1);
    expect(pool.query).not.toHaveBeenCalled();
    expect(pool.connect).not.toHaveBeenCalled();
    if (runtime.enabled) await runtime.close();
    expect(pool.end).toHaveBeenCalledTimes(1);
  });
});
