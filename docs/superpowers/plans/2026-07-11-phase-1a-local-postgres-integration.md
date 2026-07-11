# Phase 1A Local PostgreSQL Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provision a real project-local PostgreSQL 18 test target, apply and verify the isolated Phase 1A auth migration, and prove the auth/session/workspace contracts against the real database before designing Phase 1B.

**Architecture:** Use one dedicated local database with two login roles: `clipforge_saas_migrator` owns migrated objects and is used only by explicit migration commands; `clipforge_saas_app` receives only connect, schema usage, and auth-table DML privileges. Store both connection URLs only in ignored `.env.saas.local`; run Vitest integration tests in a separate Node-environment config so the ordinary unit suite never connects to PostgreSQL.

**Tech Stack:** Postgres.app PostgreSQL 18.4, `psql`, node-postgres `pg`, Drizzle migrations, Vitest 4.1, TypeScript 5.

## Global Constraints

- Do not modify the SQLite schema, SQLite migrations, `drizzle.config.ts`, or add dual writes.
- Do not add a public login provider, fake login, production identity injection, or production-gate exception.
- `DATABASE_MIGRATION_URL` is used only for explicit migrations; `DATABASE_URL` is the restricted runtime/test role.
- Never print, document, or commit either database password or complete connection URL.
- A successful socket connection alone does not prove migration application; require migration exit 0 plus catalog verification.
- The workspace has no `.git`; preserve intended change boundaries but do not claim commits.

---

### Task 1: Provision the isolated local database and roles

**Files:**
- Create locally and keep ignored: `.env.saas.local`
- No tracked source file changes.

**Interfaces:**
- Produces: `DATABASE_URL` for `clipforge_saas_app`; `DATABASE_MIGRATION_URL` for `clipforge_saas_migrator`.
- Produces database: `clipforge_saas_test` on `127.0.0.1:5432`.

- [x] **Step 1: Start Postgres.app and verify readiness**

Run `open -a Postgres` and then `/Applications/Postgres.app/Contents/Versions/latest/bin/pg_isready -h 127.0.0.1 -p 5432`.

Expected: `accepting connections`. Do not proceed from only a running GUI process.

- [x] **Step 2: Generate two independent random passwords and write the ignored env file without printing them**

The file must contain exactly the two standard PostgreSQL URLs and use `127.0.0.1`, the dedicated roles, and `clipforge_saas_test`. Confirm `.gitignore` matches `.env*`; inspect only variable names, never values.

- [x] **Step 3: Create or harden the roles and database idempotently**

As the local Postgres.app administrator, ensure both roles are `LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION`; make the migrator own the database and `public` schema; revoke database and schema creation from `PUBLIC`; grant the app role only database connect and schema usage.

- [x] **Step 4: Prove role separation**

Using the env file, verify both roles can connect over TCP. Verify the app role cannot create a table in `public`. The negative DDL check must fail and must not leave an object behind.

### Task 2: Apply and verify the Phase 1A migration

**Files:**
- Verify: `后端/saas/db/migrations/0000_phase_1a_auth_core.sql`
- Verify: `scripts/migrate-saas.mjs`

**Interfaces:**
- Consumes: `DATABASE_MIGRATION_URL` from `.env.saas.local`.
- Produces: six auth tables, six enums, foreign keys, uniqueness constraints, and indexes owned by the migration role.

- [x] **Step 1: Apply the isolated migration through the existing runner**

Run `node --env-file=.env.saas.local scripts/migrate-saas.mjs`.

Expected: exit 0 and `SaaS PostgreSQL migrations applied.` Do not claim application before this succeeds.

- [x] **Step 2: Grant the restricted app role DML on current and future migrator-owned auth objects**

Grant `SELECT, INSERT, UPDATE, DELETE` on all current tables, sequence usage where present, and equivalent migrator default privileges. Do not grant schema/database creation or object ownership.

- [x] **Step 3: Verify catalog state with the migration role**

Check that `users`, `auth_identities`, `sessions`, `workspaces`, `memberships`, and `workspace_invitations` exist; verify all expected foreign keys, primary/unique constraints, and named indexes including `workspace_invitations_pending_contact_unique`.

- [x] **Step 4: Verify runtime privileges with the app role**

Confirm representative auth-table DML succeeds inside a rolled-back transaction, while `CREATE TABLE` and `ALTER TABLE` remain denied.

### Task 3: Add database-backed integration tests using TDD

**Files:**
- Create: `vitest.integration.config.ts`
- Create: `src/lib/__tests__/saas-postgres-auth.integration.test.ts`
- Modify: `vitest.config.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `DATABASE_URL` only; integration tests must not read `DATABASE_MIGRATION_URL`.
- Produces: `npm run test:saas:integration` loading `.env.saas.local` and running only `*.integration.test.ts` with one worker in Node.

- [x] **Step 1: Add the isolated integration runner and a failing connectivity/catalog test**

Configure aliases identically to the unit config, set `environment: "node"`, include only `src/lib/__tests__/**/*.integration.test.ts`, and use one worker. Exclude the same pattern from ordinary `vitest.config.ts`. Add package script:

```json
"test:saas:integration": "node --env-file=.env.saas.local ./node_modules/vitest/vitest.mjs run --config vitest.integration.config.ts"
```

The first test must connect with `DATABASE_URL`, assert `current_user = 'clipforge_saas_app'`, and assert all six tables are visible.

- [x] **Step 2: Run the focused test and verify RED for missing test implementation/config**

Run `npm run test:saas:integration` before adding the full fixtures/assertions.

Expected: the new runner reaches the intended test file; any failure must not include the connection URL.

- [x] **Step 3: Implement transaction-scoped real-database fixtures**

Use one `pg.Client` per test, `BEGIN` in setup and `ROLLBACK` in teardown. Insert randomized UUID users/workspaces/memberships through the app role so tests also exercise restricted DML privileges. Instantiate `PostgresAuthRepository` with that same client.

- [x] **Step 4: Cover session lifecycle and invalidation**

Assert: `createPersistentSession` stores only the SHA-256 digest; a valid token reads a context; expired and revoked sessions are anonymous; a suspended user invalidates an otherwise-live session; user-wide revocation invalidates all active sessions; `last_used_at` advances once and remains unchanged inside the five-minute throttle window.

- [x] **Step 5: Cover workspace state, role changes, and A/B isolation**

Assert: an active membership resolves; changing `member` to `admin` is observed on the next read; suspending the workspace removes workspace context and list visibility; a user in workspace A cannot resolve workspace B from its header and `requireWorkspace` returns `WORKSPACE_FORBIDDEN`; listing for A never returns B.

- [x] **Step 6: Run the integration suite to GREEN**

Run `npm run test:saas:integration`.

Expected: every integration test passes against `clipforge_saas_app`; no test output contains a credential or URL.

### Task 4: Regress the offline slice and document verified local operation

**Files:**
- Modify: `docs/saas-postgres-auth-runtime.md`
- Verify: Phase 0 and Phase 1A implementation files.

**Interfaces:**
- Produces: credential-free local-operation guidance and exact verified boundaries.

- [x] **Step 1: Document the ignored env filename, role split, migration command, catalog check, and integration command**

Do not include real credentials or claim public login/API availability. Keep the production gate warning explicit.

- [x] **Step 2: Run focused and full verification**

Run `npm run test:saas:integration`, `npm test`, `npm run typecheck`, `npm run lint`, and the relevant production-gate regression. Report exact test counts and lint warnings/errors.

- [x] **Step 3: Self-review scope**

Confirm no SQLite schema/migration/config changed, no public auth route was added, no production-gate exception exists, and no secret appears in tracked files or test output.

### Task 5: Design, but do not implement, the Phase 1B first slice

**Files:**
- Create: `docs/superpowers/specs/2026-07-11-phase-1b-projects-first-slice-design.md`

**Interfaces:**
- Consumes: only the proven PostgreSQL auth/runtime contracts and green integration evidence.
- Produces design for PostgreSQL `projects`, a required-`workspaceId` repository, and workspace-scoped list/create APIs.

- [x] **Step 1: Gate on real integration success**

Do not write the Phase 1B design unless Task 3 is green against the real database.

- [x] **Step 2: Compare schema/repository/API approaches and choose the smallest tenant-safe slice**

The design must specify `workspace_id`, cross-tenant 404 behavior, app filtering plus future RLS boundary, list/create validation, error mapping, migration ownership, and A/B integration tests. It must not open the production gate or migrate unrelated project children.

- [x] **Step 3: Write and self-review the design**

Scan for placeholders, contradictions, ambiguous ownership rules, or any claim that a login provider exists. Stop after the design and request review before implementation.

## Completion Boundary

This plan is complete only when Postgres.app accepts real role-authenticated connections, the migration exits 0, catalog verification proves the six auth tables/constraints/indexes, the restricted app role passes all integration tests, and the ordinary regression suite remains green. It does not mean public login works, production business APIs are open, or Phase 1B is implemented.
