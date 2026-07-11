# Phase 1A PostgreSQL Runtime and Auth API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a vendor-neutral PostgreSQL runtime, isolated SaaS migrations, a persistent auth/session repository, and closed-by-default session/workspace API contracts without claiming a database connection, enabling public login, or opening the existing production business APIs.

**Architecture:** Use `pg` (node-postgres) over the standard PostgreSQL protocol and keep its pool lazy so importing the auth runtime never proves connectivity. Keep SaaS migrations under `后端/saas/db/migrations/` with a separate Drizzle config and require `DATABASE_MIGRATION_URL` for migration application. Implement session persistence and workspace lookup behind the existing repository port, then expose thin Next.js auth routes through injectable handlers; the Phase 0 production proxy gate remains unchanged, so these routes are implementation-ready but not publicly reachable in production yet.

**Tech Stack:** Next.js 16.2.1, TypeScript 5, Vitest 4.1, Node.js 20+, `pg`, Drizzle ORM 0.45.1, Drizzle Kit 0.31.10.

## Global Constraints

- PostgreSQL access must use a standard `postgres://` or `postgresql://` URL and must not depend on a hosting-vendor SDK.
- `DATABASE_URL` is for the restricted application role; `DATABASE_MIGRATION_URL` is for explicit migration execution and must never silently fall back to `DATABASE_URL`.
- Do not modify `后端/db/schema.ts`, `后端/db/index.ts`, `drizzle.config.ts`, existing SQLite migrations, or any SQLite runtime call site.
- Do not add SQLite/PostgreSQL dual writes or a runtime dialect switch.
- Do not add an SMS, email, OAuth, payment, object-storage, or queue integration.
- Do not add a public login, signup, callback, password, phone-code, or magic-link endpoint while no verified identity provider is selected.
- Development identity injection remains allowed only under the existing `NODE_ENV !== "production"` plus `CLIPFORGE_DEV_AUTH_ENABLED=1` rule; production remains fail closed.
- Keep the Phase 0 production business API proxy gate unchanged. `/api/project` and all current business/file/AI routes remain closed in production.
- The new auth route handlers must return `503 AUTH_RUNTIME_NOT_CONFIGURED` when PostgreSQL runtime configuration is unavailable; they must not fall back to an in-memory repository.
- A pool object being constructed is not proof that PostgreSQL accepted a connection. Without a real `DATABASE_URL` and integration run, do not claim connectivity or persistence.
- A generated migration file is not an applied migration. Without `DATABASE_MIGRATION_URL` and a successful migration command, do not claim schema installation.
- Project-list activation is excluded: the existing SQLite `projects` table has no `workspace_id`. `/api/project` stays gated until Phase 1B adds PostgreSQL tenant ownership and cross-tenant integration tests.
- The workspace has no `.git`; preserve intended commit boundaries but do not run or claim commits.
- The checked-out `node_modules/.modules.yaml` records pnpm 11.7.0 while `package.json` still declares pnpm 10.33.0. For this slice, use `corepack pnpm@11.7.0 --pm-on-fail=ignore` only for dependency/lockfile changes; do not silently rewrite the project's package-manager policy.
- Use `npm` for the established verification commands.

## File Map

- `后端/saas/db/config.ts`: parse and validate application and migration PostgreSQL URLs without connecting.
- `后端/saas/db/postgres-client.ts`: create a lazy node-postgres pool from validated application configuration.
- `drizzle.saas.config.ts`: generate PostgreSQL-only SaaS migrations without touching the SQLite Drizzle config.
- `后端/saas/db/migrations/*`: generated SQL and Drizzle migration metadata for the Phase 1A auth schema.
- `scripts/migrate-saas.mjs`: require the privileged migration URL and apply only the isolated SaaS migration folder.
- `服务器/auth/repository.ts`: shared read/write repository contracts for auth context, persistent sessions, and workspace listing.
- `后端/saas/db/postgres-auth-repository.ts`: parameterized PostgreSQL implementation of those contracts.
- `服务器/auth/session-service.ts`: create opaque sessions, persist only token digests, and revoke by digest.
- `后端/saas/db/auth-runtime.ts`: bind the validated pool and PostgreSQL repository without connecting at module import.
- `服务器/auth/api-contracts.ts`: stable JSON success/error/session/workspace response types.
- `服务器/auth/api-handlers.ts`: injectable session and workspace handlers with consistent error mapping.
- `src/app/api/auth/session/route.ts`: thin GET/DELETE session route.
- `src/app/api/auth/workspaces/route.ts`: thin authenticated workspace-list route.
- `docs/saas-postgres-auth-runtime.md`: exact environment, generation, application, and non-claim rules.

---

### Task 1: Add standard PostgreSQL configuration and lazy pool creation

**Files:**
- Create: `后端/saas/db/config.ts`
- Create: `后端/saas/db/postgres-client.ts`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Test: `src/lib/__tests__/saas-postgres-config.test.ts`

**Interfaces:**
- Produces: `resolveSaasDatabaseConfig(env)`, `requireSaasMigrationUrl(env)`, `SaasDatabaseConfigurationError`, `createSaasPool(env, poolFactory)`.
- Consumes: `DATABASE_URL`, `DATABASE_MIGRATION_URL`, and the standard `pg.Pool` constructor.
- The pool factory is injectable so unit tests prove configuration behavior without opening a socket.

- [ ] **Step 1: Write the failing configuration test**

Create `src/lib/__tests__/saas-postgres-config.test.ts`:

```ts
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
    expect(resolveSaasDatabaseConfig({ DATABASE_URL: "postgresql://app:secret@db.example/clipforge" })).toMatchObject({
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
    const pool = { query: vi.fn(), end: vi.fn() };
    const factory = vi.fn(() => pool);

    expect(createSaasPool({ DATABASE_URL: "postgresql://app@db/clipforge" }, factory)).toBe(pool);
    expect(factory).toHaveBeenCalledWith(expect.objectContaining({
      connectionString: "postgresql://app@db/clipforge",
      max: 10,
    }));
    expect(pool.query).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
npm test -- src/lib/__tests__/saas-postgres-config.test.ts
```

Expected: FAIL because `@backend/saas/db/config`, `@backend/saas/db/postgres-client`, and the direct `pg` dependency do not exist.

- [ ] **Step 3: Install the standard PostgreSQL driver with the project package manager**

Run:

```bash
corepack pnpm@11.7.0 --pm-on-fail=ignore add pg
corepack pnpm@11.7.0 --pm-on-fail=ignore add -D @types/pg
```

Expected: `package.json` and `pnpm-lock.yaml` record `pg` plus its TypeScript declarations. No hosting-vendor package is added.

- [ ] **Step 4: Implement URL validation without connecting**

Create `后端/saas/db/config.ts`:

```ts
import "server-only";

export type SaasDatabaseConfig =
  | { enabled: true; url: string }
  | { enabled: false; code: "DATABASE_URL_MISSING" | "DATABASE_URL_INVALID"; reason: string };

export type SaasDatabaseEnvironment = Readonly<
  Record<string, string | undefined> & {
    DATABASE_URL?: string;
    DATABASE_MIGRATION_URL?: string;
  }
>;

export class SaasDatabaseConfigurationError extends Error {
  constructor(
    public readonly code: "DATABASE_URL_MISSING" | "DATABASE_URL_INVALID" | "DATABASE_MIGRATION_URL_MISSING" | "DATABASE_MIGRATION_URL_INVALID",
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

export function resolveSaasDatabaseConfig(env: SaasDatabaseEnvironment = process.env): SaasDatabaseConfig {
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
```

- [ ] **Step 5: Implement injectable lazy pool construction**

Create `后端/saas/db/postgres-client.ts`:

```ts
import "server-only";

import { Pool, type PoolConfig } from "pg";
import {
  resolveSaasDatabaseConfig,
  SaasDatabaseConfigurationError,
} from "./config";

export type SaasPool = Pick<Pool, "query" | "end">;
export type SaasPoolFactory = (config: PoolConfig) => SaasPool;

export function createSaasPool(
  env: SaasDatabaseEnvironment = process.env,
  poolFactory: SaasPoolFactory = (config) => new Pool(config),
) {
  const config = resolveSaasDatabaseConfig(env);
  if (!config.enabled) {
    throw new SaasDatabaseConfigurationError(config.code, config.reason);
  }
  return poolFactory({
    connectionString: config.url,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    allowExitOnIdle: true,
  });
}
```

- [ ] **Step 6: Run focused tests and typecheck**

Run:

```bash
npm test -- src/lib/__tests__/saas-postgres-config.test.ts
npm run typecheck
```

Expected: the focused suite passes and TypeScript exits 0. This proves only offline configuration behavior, not connectivity.

- [ ] **Step 7: Preserve the intended commit boundary**

When Git metadata exists, the intended commit is:

```bash
git add package.json pnpm-lock.yaml 后端/saas/db/config.ts 后端/saas/db/postgres-client.ts src/lib/__tests__/saas-postgres-config.test.ts
git commit -m "feat: add SaaS PostgreSQL runtime config"
```

Do not run these commands in the current ZIP workspace.

### Task 2: Generate isolated SaaS migrations and add a fail-closed migration runner

**Files:**
- Create: `drizzle.saas.config.ts`
- Create: `后端/saas/db/migrations/0000_phase_1a_auth_core.sql`
- Create: `后端/saas/db/migrations/meta/_journal.json`
- Create: `后端/saas/db/migrations/meta/0000_snapshot.json`
- Create: `scripts/migrate-saas.mjs`
- Modify: `package.json`
- Test: `src/lib/__tests__/saas-migrations.test.ts`

**Interfaces:**
- Produces: `npm run db:saas:generate` and `npm run db:saas:migrate`.
- Generation reads only `后端/saas/db/auth-schema.ts`; migration application reads only `DATABASE_MIGRATION_URL`.
- Existing `drizzle.config.ts` and SQLite migrations are not inputs.

- [ ] **Step 1: Write the failing migration contract test**

Create `src/lib/__tests__/saas-migrations.test.ts`:

```ts
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import packageJson from "../../../package.json";

describe("isolated SaaS PostgreSQL migrations", () => {
  it("uses a separate PostgreSQL-only Drizzle config and migration folder", () => {
    const config = readFileSync(resolve(process.cwd(), "drizzle.saas.config.ts"), "utf8");
    const migration = readFileSync(
      resolve(process.cwd(), "后端/saas/db/migrations/0000_phase_1a_auth_core.sql"),
      "utf8",
    );

    expect(config).toContain('dialect: "postgresql"');
    expect(config).toContain('schema: "./后端/saas/db/auth-schema.ts"');
    expect(config).toContain('out: "./后端/saas/db/migrations"');
    expect(migration).toContain('CREATE TABLE "sessions"');
    expect(migration).toContain('"token_digest" char(64) NOT NULL');
    expect(migration).toContain('CREATE TABLE "memberships"');
  });

  it("provides explicit generate and migrate commands", () => {
    expect(packageJson.scripts["db:saas:generate"]).toBe("drizzle-kit generate --config=drizzle.saas.config.ts");
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
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
npm test -- src/lib/__tests__/saas-migrations.test.ts
```

Expected: FAIL because the separate config, migration artifacts, runner, and scripts do not exist.

- [ ] **Step 3: Add the isolated Drizzle generation config**

Create `drizzle.saas.config.ts`:

```ts
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./后端/saas/db/auth-schema.ts",
  out: "./后端/saas/db/migrations",
  strict: true,
  verbose: true,
});
```

- [ ] **Step 4: Generate the first migration from the existing PostgreSQL schema**

Run:

```bash
./node_modules/.bin/drizzle-kit generate --config=drizzle.saas.config.ts --name=phase_1a_auth_core
```

Expected: Drizzle creates `0000_phase_1a_auth_core.sql` and its `meta` files without contacting a database. Inspect the SQL and confirm all six auth tables, enums, foreign keys, indexes, and the partial pending-invitation index are present.

- [ ] **Step 5: Add a migration runner that requires the privileged URL**

Create `scripts/migrate-saas.mjs`:

```js
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
```

- [ ] **Step 6: Add package scripts**

Add these entries beside the existing database/build scripts in `package.json`:

```json
"db:saas:generate": "drizzle-kit generate --config=drizzle.saas.config.ts",
"db:saas:migrate": "node scripts/migrate-saas.mjs"
```

- [ ] **Step 7: Run the focused test and offline migration generation check**

Run:

```bash
npm test -- src/lib/__tests__/saas-migrations.test.ts
npm run db:saas:generate
```

Expected: the focused test passes and Drizzle reports no schema changes after the checked-in migration. Do not run `npm run db:saas:migrate` without a user-provided migration database.

- [ ] **Step 8: Preserve the intended commit boundary**

When Git metadata exists, the intended commit is:

```bash
git add drizzle.saas.config.ts 后端/saas/db/migrations scripts/migrate-saas.mjs package.json src/lib/__tests__/saas-migrations.test.ts
git commit -m "feat: add isolated SaaS auth migrations"
```

Do not run these commands in the current ZIP workspace.

### Task 3: Implement persistent session and workspace repositories

**Files:**
- Create: `服务器/auth/repository.ts`
- Create: `服务器/auth/session-service.ts`
- Create: `后端/saas/db/postgres-auth-repository.ts`
- Modify: `服务器/auth/auth-context.ts`
- Modify: `服务器/auth/index.ts`
- Test: `src/lib/__tests__/saas-postgres-auth-repository.test.ts`
- Test: `src/lib/__tests__/saas-session-service.test.ts`

**Interfaces:**
- Produces: `AuthRepository`, `SessionRepository`, `WorkspaceRepository`, `CompleteAuthRepository`, `PostgresAuthRepository`, `createPersistentSession()`, `revokePersistentSession()`, and `revokeAllPersistentSessions()`.
- The PostgreSQL implementation uses parameterized statements only.
- The session service passes only SHA-256 digests to persistence; raw tokens are returned once to the caller for a future verified-provider callback.

- [ ] **Step 1: Write failing repository and session-service tests**

Create `src/lib/__tests__/saas-postgres-auth-repository.test.ts` with a recording query executor that returns typed rows. Assert:

```ts
expect(executor.calls[0]).toMatchObject({
  values: ["digest-1"],
});
expect(executor.calls[0].text).toContain("WHERE s.token_digest = $1");
expect(executor.calls[1].text).toContain("m.user_id = $1");
expect(executor.calls[1].values).toEqual(["user-1"]);
expect(executor.calls[2].text).toContain("INSERT INTO sessions");
expect(executor.calls[3].text).toContain("UPDATE sessions");
```

Create `src/lib/__tests__/saas-session-service.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { createPersistentSession, revokePersistentSession } from "@server/auth/session-service";

describe("persistent session service", () => {
  it("persists only a digest and returns the raw token once", async () => {
    const repository = { createSession: vi.fn(async () => "session-1"), revokeSessionByTokenDigest: vi.fn() };
    const now = new Date("2030-01-01T00:00:00.000Z");
    const result = await createPersistentSession("user-1", repository, () => now);

    expect(result.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(repository.createSession).toHaveBeenCalledWith(expect.objectContaining({
      userId: "user-1",
      tokenDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      createdAt: now,
    }));
    expect(JSON.stringify(repository.createSession.mock.calls)).not.toContain(result.token);
  });

  it("hashes valid tokens before revocation and ignores malformed tokens", async () => {
    const repository = { createSession: vi.fn(), revokeSessionByTokenDigest: vi.fn(async () => true) };
    await expect(revokePersistentSession("bad-token", repository)).resolves.toBe(false);
    expect(repository.revokeSessionByTokenDigest).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run both tests and verify RED**

Run:

```bash
npm test -- src/lib/__tests__/saas-postgres-auth-repository.test.ts src/lib/__tests__/saas-session-service.test.ts
```

Expected: FAIL because the repository contracts, PostgreSQL implementation, and persistent session service do not exist.

- [ ] **Step 3: Move shared repository types into a focused port**

Create `服务器/auth/repository.ts` with the existing `SessionAuthRecord` and `WorkspaceMembershipRecord`. `AuthRepository` keeps both lookup methods and adds `markSessionUsed(sessionId, usedAt)` so valid requests update the persisted activity time through the five-minute SQL throttle. Add these write/list contracts:

```ts
export type CreateSessionRecord = {
  userId: string;
  tokenDigest: string;
  expiresAt: Date;
  createdAt: Date;
};

export type WorkspaceSummaryRecord = WorkspaceMembershipRecord;

export interface SessionRepository {
  createSession(record: CreateSessionRecord): Promise<string>;
  revokeSessionByTokenDigest(tokenDigest: string, revokedAt: Date): Promise<boolean>;
  revokeSessionsForUser(userId: string, revokedAt: Date): Promise<number>;
}

export interface WorkspaceRepository {
  listWorkspaceMemberships(userId: string): Promise<WorkspaceSummaryRecord[]>;
}

export type CompleteAuthRepository = AuthRepository & SessionRepository & WorkspaceRepository;
```

Modify `服务器/auth/auth-context.ts` to import these types and re-export them for backward compatibility:

```ts
export type {
  AuthRepository,
  SessionAuthRecord,
  WorkspaceMembershipRecord,
} from "./repository";
```

- [ ] **Step 4: Implement parameterized PostgreSQL queries**

Create `后端/saas/db/postgres-auth-repository.ts` with a `PgQueryExecutor` port and a `PostgresAuthRepository` class. The four query shapes must be:

```sql
SELECT s.id AS session_id, s.user_id, u.status AS user_status,
       u.platform_role, s.expires_at, s.revoked_at
FROM sessions s
JOIN users u ON u.id = s.user_id
WHERE s.token_digest = $1
LIMIT 1;
```

```sql
SELECT w.id AS workspace_id, w.name AS workspace_name,
       w.status AS workspace_status, m.role
FROM memberships m
JOIN workspaces w ON w.id = m.workspace_id
WHERE m.user_id = $1 AND m.workspace_id = $2
LIMIT 1;
```

```sql
SELECT w.id AS workspace_id, w.name AS workspace_name,
       w.status AS workspace_status, m.role
FROM memberships m
JOIN workspaces w ON w.id = m.workspace_id
WHERE m.user_id = $1 AND w.status = 'active'
ORDER BY w.created_at ASC, w.id ASC;
```

```sql
INSERT INTO sessions (user_id, token_digest, expires_at, last_used_at, created_at)
VALUES ($1, $2, $3, $4, $4)
RETURNING id;
```

Revocation must use:

```sql
UPDATE sessions
SET revoked_at = $2
WHERE token_digest = $1 AND revoked_at IS NULL
RETURNING id;
```

Valid sessions must update `last_used_at` at most once per five minutes:

```sql
UPDATE sessions
SET last_used_at = $2
WHERE id = $1
  AND revoked_at IS NULL
  AND expires_at > $2
  AND last_used_at < $2 - interval '5 minutes';
```

Password changes, suspension, or an administrator action can revoke all active sessions for one user through:

```sql
UPDATE sessions
SET revoked_at = $2
WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > $2;
```

Map PostgreSQL snake-case rows into the domain records and return `null`, `[]`, or `false` when no row exists.

- [ ] **Step 5: Implement the digest-only session service**

Create `服务器/auth/session-service.ts`:

```ts
import "server-only";

import type { SessionRepository } from "./repository";
import {
  AUTH_SESSION_MAX_AGE_SECONDS,
  generateSessionToken,
  hashSessionToken,
  isValidSessionToken,
} from "./session-token";

export async function createPersistentSession(
  userId: string,
  repository: SessionRepository,
  now: () => Date = () => new Date(),
) {
  const createdAt = now();
  const expiresAt = new Date(createdAt.getTime() + AUTH_SESSION_MAX_AGE_SECONDS * 1_000);
  const token = generateSessionToken();
  const sessionId = await repository.createSession({
    userId,
    tokenDigest: hashSessionToken(token),
    expiresAt,
    createdAt,
  });
  return { sessionId, token, expiresAt };
}

export async function revokePersistentSession(
  token: string,
  repository: SessionRepository,
  now: () => Date = () => new Date(),
) {
  if (!isValidSessionToken(token)) return false;
  return repository.revokeSessionByTokenDigest(hashSessionToken(token), now());
}
```

- [ ] **Step 6: Export the new ports and service**

Add to `服务器/auth/index.ts`:

```ts
export * from "./repository";
export * from "./session-service";
```

- [ ] **Step 7: Run focused tests and existing AuthContext regressions**

Run:

```bash
npm test -- src/lib/__tests__/saas-postgres-auth-repository.test.ts src/lib/__tests__/saas-session-service.test.ts src/lib/__tests__/saas-auth-context.test.ts
npm run typecheck
```

Expected: all focused tests pass and existing imports from `auth-context.ts` remain compatible.

- [ ] **Step 8: Preserve the intended commit boundary**

When Git metadata exists, the intended commit is:

```bash
git add 服务器/auth/repository.ts 服务器/auth/session-service.ts 服务器/auth/auth-context.ts 服务器/auth/index.ts 后端/saas/db/postgres-auth-repository.ts src/lib/__tests__/saas-postgres-auth-repository.test.ts src/lib/__tests__/saas-session-service.test.ts
git commit -m "feat: add persistent PostgreSQL auth repository"
```

Do not run these commands in the current ZIP workspace.

### Task 4: Bind the auth runtime and implement stable session/workspace APIs

**Files:**
- Create: `后端/saas/db/auth-runtime.ts`
- Create: `服务器/auth/api-contracts.ts`
- Create: `服务器/auth/api-handlers.ts`
- Create: `src/app/api/auth/session/route.ts`
- Create: `src/app/api/auth/workspaces/route.ts`
- Modify: `服务器/auth/index.ts`
- Test: `src/lib/__tests__/saas-auth-runtime.test.ts`
- Test: `src/lib/__tests__/saas-auth-api.test.ts`

**Interfaces:**
- Produces: `createSaasAuthRuntime(env, dependencies)`, `getSaasAuthRuntime()`, `handleGetSession()`, `handleDeleteSession()`, and `handleGetWorkspaces()`.
- Success envelope: `{ data, requestId }`.
- Error envelope: `{ error: { code, message, requestId } }`.
- No route creates a user, identity, workspace, membership, or session because no verified login provider exists.

- [ ] **Step 1: Write failing runtime and API contract tests**

Create `src/lib/__tests__/saas-auth-runtime.test.ts` to prove:

```ts
expect(createSaasAuthRuntime({}, dependencies)).toMatchObject({
  enabled: false,
  code: "AUTH_RUNTIME_NOT_CONFIGURED",
});
expect(poolFactory).not.toHaveBeenCalled();
```

With `DATABASE_URL`, assert the injected pool factory is called once, no query runs during construction, and the runtime returns `{ enabled: true, repository, close }`.

Create `src/lib/__tests__/saas-auth-api.test.ts` to cover:

```ts
expect(disabledResponse.status).toBe(503);
expect(await disabledResponse.json()).toMatchObject({
  error: { code: "AUTH_RUNTIME_NOT_CONFIGURED", requestId: "request-1" },
});

expect(anonymousSession.status).toBe(200);
expect(await anonymousSession.json()).toMatchObject({
  data: { authenticated: false, user: null, session: null, workspace: null },
});

expect(unauthenticatedWorkspaces.status).toBe(401);
expect(await unauthenticatedWorkspaces.json()).toMatchObject({
  error: { code: "AUTH_REQUIRED" },
});

expect(listWorkspaceMemberships).toHaveBeenCalledWith("user-1");
expect(revokeSessionByTokenDigest).toHaveBeenCalledWith(expect.stringMatching(/^[a-f0-9]{64}$/), expect.any(Date));
expect(logout.headers.get("set-cookie")).toContain("clipforge_session=;");
```

- [ ] **Step 2: Run both tests and verify RED**

Run:

```bash
npm test -- src/lib/__tests__/saas-auth-runtime.test.ts src/lib/__tests__/saas-auth-api.test.ts
```

Expected: FAIL because the runtime binding, contracts, handlers, and routes do not exist.

- [ ] **Step 3: Implement a non-connecting runtime binding**

Create `后端/saas/db/auth-runtime.ts` as a discriminated union:

```ts
export type SaasAuthRuntime =
  | { enabled: false; code: "AUTH_RUNTIME_NOT_CONFIGURED"; reason: string }
  | { enabled: true; repository: CompleteAuthRepository; close(): Promise<void> };
```

`createSaasAuthRuntime()` must call `assertSafeAuthRuntime(env)`, inspect `resolveSaasDatabaseConfig(env)`, return the disabled union without constructing a pool when configuration is absent/invalid, and otherwise construct one pool plus one `PostgresAuthRepository`. `getSaasAuthRuntime()` may cache this union per process, but must not execute `SELECT 1` or any other query at import time.

- [ ] **Step 4: Define stable JSON contracts**

Create `服务器/auth/api-contracts.ts` with these public shapes:

```ts
export type ApiErrorResponse = {
  error: { code: string; message: string; requestId: string };
};

export type ApiSuccessResponse<T> = {
  data: T;
  requestId: string;
};

export type SessionPayload = {
  authenticated: boolean;
  user: null | { id: string; platformRole: PlatformRole };
  session: null | { id: string; expiresAt: string };
  workspace: null | { id: string; name: string; role: WorkspaceRole };
};

export type WorkspaceListPayload = {
  workspaces: Array<{ id: string; name: string; role: WorkspaceRole }>;
};
```

- [ ] **Step 5: Implement injectable handlers with stable error mapping**

Create `服务器/auth/api-handlers.ts` with dependencies:

```ts
export type AuthApiDependencies = {
  runtime: SaasAuthRuntime;
  now?: () => Date;
  createRequestId?: () => string;
};
```

Required behavior:

- `handleGetSession`: disabled runtime → 503; valid runtime plus no/invalid Cookie → 200 anonymous payload; valid session → serialized user/session/workspace payload.
- `handleGetWorkspaces`: call `requireUser` first; list memberships only with `context.user.id`; return 401 for no valid session.
- `handleDeleteSession`: disabled runtime → 503; otherwise read only `clipforge_session`, revoke its digest if valid, and always clear the browser Cookie after the persistence attempt succeeds.
- `AuthError` maps to its existing 401/403 status and code.
- Unexpected database errors map to `500 AUTH_INTERNAL_ERROR`; response bodies must not include SQL text, URLs, credentials, token values, or stack traces.
- Every response sends `Cache-Control: no-store`.

- [ ] **Step 6: Add thin Next.js routes without a login endpoint**

Create `src/app/api/auth/session/route.ts`:

```ts
import type { NextRequest } from "next/server";
import { handleDeleteSession, handleGetSession } from "@server/auth/api-handlers";
import { getSaasAuthRuntime } from "@backend/saas/db/auth-runtime";

export async function GET(request: NextRequest) {
  return handleGetSession(request, { runtime: getSaasAuthRuntime() });
}

export async function DELETE(request: NextRequest) {
  return handleDeleteSession(request, { runtime: getSaasAuthRuntime() });
}
```

Create `src/app/api/auth/workspaces/route.ts`:

```ts
import type { NextRequest } from "next/server";
import { handleGetWorkspaces } from "@server/auth/api-handlers";
import { getSaasAuthRuntime } from "@backend/saas/db/auth-runtime";

export async function GET(request: NextRequest) {
  return handleGetWorkspaces(request, { runtime: getSaasAuthRuntime() });
}
```

Do not create `/api/auth/login`, `/api/auth/signup`, `/api/auth/callback`, or any development-injection route.

- [ ] **Step 7: Export the new server auth contracts**

Add to `服务器/auth/index.ts`:

```ts
export * from "./api-contracts";
export * from "./api-handlers";
```

- [ ] **Step 8: Run API, runtime, gate, and type checks**

Run:

```bash
npm test -- src/lib/__tests__/saas-auth-runtime.test.ts src/lib/__tests__/saas-auth-api.test.ts src/lib/__tests__/saas-launch-gate.test.ts
npm run typecheck
```

Expected: the new handlers pass, the existing production business API gate remains unchanged, and TypeScript exits 0.

- [ ] **Step 9: Preserve the intended commit boundary**

When Git metadata exists, the intended commit is:

```bash
git add 后端/saas/db/auth-runtime.ts 服务器/auth/api-contracts.ts 服务器/auth/api-handlers.ts 服务器/auth/index.ts src/app/api/auth src/lib/__tests__/saas-auth-runtime.test.ts src/lib/__tests__/saas-auth-api.test.ts
git commit -m "feat: add closed-by-default auth APIs"
```

Do not run these commands in the current ZIP workspace.

### Task 5: Document operation boundaries and verify the complete low-risk slice

**Files:**
- Create: `docs/saas-postgres-auth-runtime.md`
- Verify only: existing Phase 0 and Phase 1A files.

**Interfaces:**
- Produces: copy-pasteable environment and migration commands with explicit claim boundaries.
- Does not contain real credentials or assert that any command was run against a real database.

- [ ] **Step 1: Write the runtime operations document**

Create `docs/saas-postgres-auth-runtime.md` with these sections and exact rules:

```markdown
# SaaS PostgreSQL 认证运行时

## 环境变量

- `DATABASE_URL`：Web 应用受限角色，只用于运行时查询。
- `DATABASE_MIGRATION_URL`：迁移专用高权限角色，只用于显式迁移命令。

两者都必须是标准 `postgres://` 或 `postgresql://` 连接串。代码不绑定托管商，也不会用 `DATABASE_URL` 代替迁移连接串。

## 生成迁移

`npm run db:saas:generate`

生成只读取 PostgreSQL schema，不连接数据库。

## 应用迁移

`DATABASE_MIGRATION_URL='postgresql://...' npm run db:saas:migrate`

只有命令退出 0 并核对目标数据库后，才能说迁移已应用。

## 当前不可宣称

- 未提供真实 `DATABASE_URL`：不能说数据库已连通或会话已持久化。
- 未执行迁移命令：不能说表已创建。
- 未选择登录供应商：不能说用户可以登录。
- Phase 0 生产业务 API 门禁仍在：不能说项目、文件或 AI API 已开放。
- 项目表尚未迁入带 `workspace_id` 的 PostgreSQL schema：不能说项目列表已具备租户隔离。
```

- [ ] **Step 2: Run all unit tests**

Run:

```bash
npm test
```

Expected: 0 failed test files and 0 failed tests. Report the exact file and test counts.

- [ ] **Step 3: Run TypeScript checking**

Run:

```bash
npm run typecheck
```

Expected: exit 0 with no TypeScript errors.

- [ ] **Step 4: Run lint**

Run:

```bash
npm run lint
```

Expected: exit 0. Report the actual warning count and preserve the distinction between warnings and errors.

- [ ] **Step 5: Run the production build**

Run:

```bash
npm run build
```

Expected: exit 0 in a network-capable environment. Report existing NFT tracing, `metadataBase`, font, or other warnings exactly; do not hide them.

- [ ] **Step 6: Re-run the production gate regression**

Run:

```bash
npm test -- src/lib/__tests__/saas-launch-gate.test.ts
```

Expected: `/api/project` remains blocked in production and `/api/admin/*` remains reachable only for its own fail-closed authentication.

- [ ] **Step 7: Verify migration non-application and repository scope**

Inspect and record:

```text
No real DATABASE_URL was used in verification.
No real DATABASE_MIGRATION_URL was used.
No migration application command was run.
No public login/signup/callback route exists.
No SQLite schema, SQLite migration, or drizzle.config.ts changed.
No /api/project production-gate exception was added.
No in-memory repository is used as a runtime fallback.
```

- [ ] **Step 8: Preserve the intended commit boundary**

When Git metadata exists, the intended commit is:

```bash
git add docs/saas-postgres-auth-runtime.md docs/superpowers/plans/2026-07-10-phase-1a-postgres-runtime-auth-api.md
git commit -m "docs: define SaaS auth runtime operations"
```

Do not run these commands in the current ZIP workspace.

## Completion Boundary

This plan completes the offline, low-risk implementation slice only when configuration, migration-generation, repository, session-service, runtime, API, full-test, typecheck, lint, build, and production-gate checks pass. It still does not prove a live PostgreSQL connection, an applied migration, durable sessions in a real database, a working public login, or tenant-safe project listing. Those claims require user-provided PostgreSQL targets, a verified identity provider, Phase 1B project ownership, and database-backed cross-tenant integration tests.
