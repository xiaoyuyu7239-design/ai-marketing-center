import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import packageJson from "../../../package.json";

describe("isolated SaaS PostgreSQL migrations", () => {
  it("uses a separate PostgreSQL-only Drizzle config and migration folder", () => {
    const config = readFileSync(resolve(process.cwd(), "drizzle.saas.config.ts"), "utf8");
    const authMigration = readFileSync(
      resolve(process.cwd(), "后端/saas/db/migrations/0000_phase_1a_auth_core.sql"),
      "utf8",
    );
    const projectMigration = readFileSync(
      resolve(process.cwd(), "后端/saas/db/migrations/0001_phase_1b_projects.sql"),
      "utf8",
    );

    expect(config).toContain('dialect: "postgresql"');
    expect(config).toContain('"./后端/saas/db/auth-schema.ts"');
    expect(config).toContain('"./后端/saas/db/project-schema.ts"');
    expect(config).toContain('out: "./后端/saas/db/migrations"');
    expect(authMigration).toContain('CREATE TABLE "sessions"');
    expect(authMigration).toContain('"token_digest" char(64) NOT NULL');
    expect(authMigration).toContain('CREATE TABLE "memberships"');
    expect(projectMigration).toContain('CREATE TABLE "projects"');
    expect(projectMigration).toContain('ALTER TABLE "projects" ENABLE ROW LEVEL SECURITY');
    expect(projectMigration).toContain('CREATE POLICY "projects_workspace_isolation"');
  });

  it("provides explicit generate and migrate commands", () => {
    expect(packageJson.scripts["db:saas:generate"]).toBe(
      "drizzle-kit generate --config=drizzle.saas.config.ts",
    );
    expect(packageJson.scripts["db:saas:migrate"]).toBe("node scripts/migrate-saas.mjs");
  });

  it("refuses to migrate without DATABASE_MIGRATION_URL before opening a connection", () => {
    const result = spawnSync(process.execPath, ["scripts/migrate-saas.mjs"], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_MIGRATION_URL: "" },
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("DATABASE_MIGRATION_URL is required");
    expect(result.stderr).not.toContain("DATABASE_URL=");
  });
});
