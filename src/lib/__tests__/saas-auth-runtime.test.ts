import { describe, expect, it, vi } from "vitest";
import { createSaasAuthRuntime } from "@backend/saas/db/auth-runtime";
import type { CompleteAuthRepository } from "@server/auth/repository";

function repository(): CompleteAuthRepository {
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

describe("SaaS auth runtime", () => {
  it("stays disabled and does not construct a pool without DATABASE_URL", () => {
    const poolFactory = vi.fn();

    expect(createSaasAuthRuntime({}, { poolFactory })).toMatchObject({
      enabled: false,
      code: "AUTH_RUNTIME_NOT_CONFIGURED",
    });
    expect(poolFactory).not.toHaveBeenCalled();
  });

  it("binds a lazy pool and repository without executing a query", async () => {
    const pool = {
      query: vi.fn(),
      connect: vi.fn(),
      end: vi.fn(async () => undefined),
    };
    const authRepository = repository();
    const poolFactory = vi.fn(() => pool);
    const repositoryFactory = vi.fn(() => authRepository);

    const runtime = createSaasAuthRuntime(
      { DATABASE_URL: "postgresql://app@db/clipforge" },
      { poolFactory, repositoryFactory },
    );

    expect(runtime).toMatchObject({ enabled: true, repository: authRepository });
    expect(poolFactory).toHaveBeenCalledTimes(1);
    expect(repositoryFactory).toHaveBeenCalledTimes(1);
    expect(pool.query).not.toHaveBeenCalled();
    if (runtime.enabled) await runtime.close();
    expect(pool.end).toHaveBeenCalledTimes(1);
  });

  it("keeps development identity injection fail closed in production", () => {
    expect(() => createSaasAuthRuntime({
      NODE_ENV: "production",
      CLIPFORGE_DEV_AUTH_ENABLED: "1",
      DATABASE_URL: "postgresql://app@db/clipforge",
    })).toThrow("Development identity injection cannot be enabled in production");
  });
});
