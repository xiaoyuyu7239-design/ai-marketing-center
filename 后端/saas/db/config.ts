import "server-only";

export type SaasDatabaseConfig =
  | { enabled: true; url: string }
  | {
      enabled: false;
      code: "DATABASE_URL_MISSING" | "DATABASE_URL_INVALID";
      reason: string;
    };

export type SaasDatabaseEnvironment = Readonly<
  Record<string, string | undefined> & {
    DATABASE_URL?: string;
    DATABASE_MIGRATION_URL?: string;
  }
>;

export class SaasDatabaseConfigurationError extends Error {
  constructor(
    public readonly code:
      | "DATABASE_URL_MISSING"
      | "DATABASE_URL_INVALID"
      | "DATABASE_MIGRATION_URL_MISSING"
      | "DATABASE_MIGRATION_URL_INVALID",
    message: string,
  ) {
    super(message);
    this.name = "SaasDatabaseConfigurationError";
  }
}

function isPostgresUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "postgres:" || url.protocol === "postgresql:";
  } catch {
    return false;
  }
}

export function resolveSaasDatabaseConfig(
  env: SaasDatabaseEnvironment = process.env,
): SaasDatabaseConfig {
  const url = env.DATABASE_URL?.trim() ?? "";
  if (!url) {
    return {
      enabled: false,
      code: "DATABASE_URL_MISSING",
      reason: "SaaS PostgreSQL runtime is not configured: DATABASE_URL is required.",
    };
  }
  if (!isPostgresUrl(url)) {
    return {
      enabled: false,
      code: "DATABASE_URL_INVALID",
      reason: "SaaS PostgreSQL runtime requires a postgres:// or postgresql:// DATABASE_URL.",
    };
  }
  return { enabled: true, url };
}

export function requireSaasMigrationUrl(env: SaasDatabaseEnvironment = process.env) {
  const url = env.DATABASE_MIGRATION_URL?.trim() ?? "";
  if (!url) {
    throw new SaasDatabaseConfigurationError(
      "DATABASE_MIGRATION_URL_MISSING",
      "SaaS migrations require DATABASE_MIGRATION_URL; the application DATABASE_URL is never used as a fallback.",
    );
  }
  if (!isPostgresUrl(url)) {
    throw new SaasDatabaseConfigurationError(
      "DATABASE_MIGRATION_URL_INVALID",
      "SaaS migrations require a postgres:// or postgresql:// DATABASE_MIGRATION_URL.",
    );
  }
  return url;
}
