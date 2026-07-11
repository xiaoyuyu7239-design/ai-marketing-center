import { describe, expect, it, vi } from "vitest";
import {
  requireSaasMigrationUrl,
  resolveSaasDatabaseConfig,
  SaasDatabaseConfigurationError,
} from "@backend/saas/db/config";
import { createSaasPool } from "@backend/saas/db/postgres-client";

describe("SaaS PostgreSQL runtime configuration", () => {
  it("stays disabled without DATABASE_URL", () => {
    expect(resolveSaasDatabaseConfig({ NODE_ENV: "development" })).toMatchObject({
      enabled: false,
      code: "DATABASE_URL_MISSING",
    });
  });

  it("accepts only standard PostgreSQL URLs", () => {
    expect(resolveSaasDatabaseConfig({
      DATABASE_URL: "postgresql://app:secret@db.example/clipforge",
    })).toMatchObject({
      enabled: true,
      url: "postgresql://app:secret@db.example/clipforge",
    });
    expect(resolveSaasDatabaseConfig({ DATABASE_URL: "file:./data/sqlite.db" })).toMatchObject({
      enabled: false,
      code: "DATABASE_URL_INVALID",
    });
  });

  it("requires an independent migration URL without falling back to the app URL", () => {
    expect(() => requireSaasMigrationUrl({ DATABASE_URL: "postgresql://app@db/clipforge" }))
      .toThrow(SaasDatabaseConfigurationError);
    expect(requireSaasMigrationUrl({ DATABASE_MIGRATION_URL: "postgres://migrator@db/clipforge" }))
      .toBe("postgres://migrator@db/clipforge");
  });

  it("constructs a pool lazily and does not execute a query", () => {
    const pool = { query: vi.fn(), connect: vi.fn(), end: vi.fn() };
    const factory = vi.fn(() => pool);

    expect(createSaasPool({ DATABASE_URL: "postgresql://app@db/clipforge" }, factory)).toBe(pool);
    expect(factory).toHaveBeenCalledWith(expect.objectContaining({
      connectionString: "postgresql://app@db/clipforge",
      max: 10,
    }));
    expect(pool.query).not.toHaveBeenCalled();
  });
});
