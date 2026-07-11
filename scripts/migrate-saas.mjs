import { resolve } from "node:path";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";

const migrationUrl = process.env.DATABASE_MIGRATION_URL?.trim() ?? "";

function isPostgresUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "postgres:" || url.protocol === "postgresql:";
  } catch {
    return false;
  }
}

if (!migrationUrl) {
  console.error("DATABASE_MIGRATION_URL is required; DATABASE_URL is never used as a fallback.");
  process.exitCode = 1;
} else if (!isPostgresUrl(migrationUrl)) {
  console.error("DATABASE_MIGRATION_URL must use postgres:// or postgresql://.");
  process.exitCode = 1;
} else {
  const pool = new pg.Pool({ connectionString: migrationUrl, max: 1 });
  try {
    await migrate(drizzle(pool), {
      migrationsFolder: resolve(process.cwd(), "后端/saas/db/migrations"),
    });
    console.log("SaaS PostgreSQL migrations applied.");
  } finally {
    await pool.end();
  }
}
