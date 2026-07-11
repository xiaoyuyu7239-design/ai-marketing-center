# Phase 1B PostgreSQL Projects First Slice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a PostgreSQL-only, workspace-scoped projects schema, RLS-protected repository, and closed-by-default list/create API without changing the legacy SQLite project path or production gate.

**Architecture:** Add projects to the isolated SaaS Drizzle schema and enforce tenant ownership twice: parameterized `workspace_id` filters in the repository plus transaction-local PostgreSQL RLS. A lazy project runtime owns one pool and binds both the existing auth repository and the new project repository; `/api/saas/projects` uses that runtime while `/api/project` remains untouched.

**Tech Stack:** Next.js 16.2.1, TypeScript 5, Vitest 4.1, node-postgres 8.22, Drizzle ORM 0.45.1, Drizzle Kit 0.31.10, PostgreSQL 18.4.

## Global Constraints

- Do not modify `后端/db/schema.ts`, existing SQLite migrations, `drizzle.config.ts`, or any SQLite runtime call site.
- Do not add SQLite/PostgreSQL dual writes or a runtime fallback to SQLite/in-memory storage.
- Do not add a public login, fake login, identity-injection route, or production-gate exception.
- `/api/saas/projects` remains blocked by the existing production gate.
- `workspaceId`, project ID, status, and timestamps are server-controlled and never accepted from the create body.
- The app role must remain a non-owner restricted role; RLS is mandatory in this slice.
- The workspace has no `.git`; preserve intended boundaries but do not run or claim commits.

---

### Task 1: Define the project domain, PostgreSQL schema, and migration

**Files:**
- Create: `服务器/projects/model.ts`
- Create: `服务器/projects/repository.ts`
- Create: `后端/saas/db/project-schema.ts`
- Modify: `drizzle.saas.config.ts`
- Create: `src/lib/__tests__/saas-project-schema.test.ts`
- Modify: `src/lib/__tests__/saas-migrations.test.ts`
- Generate: `后端/saas/db/migrations/0001_*.sql` and migration metadata

**Interfaces:**
- Produces `PROJECT_STATUSES`, `PROJECT_CONTENT_TYPES`, `ProjectSummary`, `CreateProjectInput`, `ProjectCursor`, and `ProjectRepository`.
- Produces PostgreSQL `projects` with workspace FK, composite uniqueness, list index, and `projects_workspace_isolation` RLS policy.

- [x] **Step 1: Write failing schema and migration contract tests**

Assert the project table contains only the approved first-slice fields, `workspace_id` is non-null, the project enums are fixed, the composite unique/index names are stable, and the generated migration enables RLS plus creates the policy.

- [x] **Step 2: Run RED**

Run `npm test -- src/lib/__tests__/saas-project-schema.test.ts src/lib/__tests__/saas-migrations.test.ts`.

Expected: fail because the project domain/schema and `0001` migration do not exist.

- [x] **Step 3: Implement the minimal domain and schema**

Create a UUID project table with `workspace_id`, `name`, status/content type, topic/product text fields, timestamps, `projects_workspace_id_id_unique`, and `projects_workspace_created_index`. Use Drizzle `pgPolicy` with:

```sql
workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
```

for both `USING` and `WITH CHECK`, and call `.enableRLS()`.

- [x] **Step 4: Add both SaaS schema files to Drizzle generation and generate `0001`**

Set `drizzle.saas.config.ts` schema to the auth and project files, then run:

```bash
npm run db:saas:generate -- --name=phase_1b_projects
```

Inspect the generated SQL; it must create the table/enums/FK/indexes, enable RLS, and create the policy without altering the `0000` migration.

- [x] **Step 5: Run GREEN and typecheck**

Run the two focused tests and `npm run typecheck`.

### Task 2: Implement workspace transactions, cursor handling, and PostgreSQL repository

**Files:**
- Modify: `后端/saas/db/postgres-client.ts`
- Create: `后端/saas/db/workspace-transaction.ts`
- Create: `服务器/projects/pagination.ts`
- Create: `后端/saas/db/postgres-project-repository.ts`
- Create: `src/lib/__tests__/saas-workspace-transaction.test.ts`
- Create: `src/lib/__tests__/saas-project-pagination.test.ts`
- Create: `src/lib/__tests__/saas-postgres-project-repository.test.ts`
- Modify: `src/lib/__tests__/saas-postgres-config.test.ts`
- Modify: `src/lib/__tests__/saas-auth-runtime.test.ts`

**Interfaces:**
- `withWorkspaceTransaction(pool, workspaceId, callback)` obtains one client, begins, calls parameterized `set_config`, commits/rolls back, and releases.
- `encodeProjectCursor()`/`decodeProjectCursor()` use base64url JSON containing ISO `createdAt` and UUID `id`.
- `PostgresProjectRepository` implements `listProjects(workspaceId, options)` and `createProject(workspaceId, input)`.

- [x] **Step 1: Write failing transaction, pagination, and repository tests**

The transaction test records exact `BEGIN → set_config → callback → COMMIT → release` order and rollback on error. Repository tests assert every SQL statement has explicit workspace parameters, list uses keyset ordering/`limit + 1`, and create never reads workspace from input.

- [x] **Step 2: Run RED**

Run the three focused test files; expect missing modules.

- [x] **Step 3: Expand the pool port with `connect` and update existing fakes**

`SaasPool` becomes `Pick<Pool, "query" | "connect" | "end">`. Add inert `connect` fakes to the two existing pool tests without changing lazy-connect assertions.

- [x] **Step 4: Implement transaction and cursor primitives**

Validate workspace IDs and cursor UUID/timestamp shapes before opening SQL. Use `SELECT set_config('app.workspace_id', $1, true)`; never interpolate a workspace ID into SQL text.

- [x] **Step 5: Implement the repository**

List uses `(workspace_id, created_at, id)` filtering/order and returns a bounded next cursor. Create trims/defaults name, fixes status to `draft`, and returns a mapped `ProjectSummary`.

- [x] **Step 6: Run GREEN, existing auth runtime regressions, and typecheck**

### Task 3: Bind the project runtime and stable HTTP API

**Files:**
- Create: `后端/saas/db/project-runtime.ts`
- Create: `服务器/projects/api-contracts.ts`
- Create: `服务器/projects/api-handlers.ts`
- Create: `服务器/projects/index.ts`
- Create: `src/app/api/saas/projects/route.ts`
- Create: `src/lib/__tests__/saas-project-runtime.test.ts`
- Create: `src/lib/__tests__/saas-project-api.test.ts`

**Interfaces:**
- `SaasProjectRuntime` disabled form returns `AUTH_RUNTIME_NOT_CONFIGURED`; enabled form exposes `authRepository`, `projectRepository`, and `close()`.
- `handleListProjects()` and `handleCreateProject()` require `requireWorkspace`, use only `context.workspace.id`, return `{ data, requestId }`, and set `Cache-Control: no-store`.

- [x] **Step 1: Write failing runtime and API tests**

Cover disabled 503, anonymous 401, missing/foreign workspace 403, invalid limit/cursor/body 400, unknown or server-controlled create fields 400, list 200, create 201, and sanitized 500 errors.

- [x] **Step 2: Run RED**

Run both focused tests and verify missing modules/routes cause the failures.

- [x] **Step 3: Implement the lazy project runtime**

Use one `createSaasPool()` result, bind `PostgresAuthRepository` through `pool.query`, bind `PostgresProjectRepository` through `pool.connect`, and execute no query at construction.

- [x] **Step 4: Implement strict API validation and handlers**

Allow only `name`, `contentType`, `topic`, `productName`, `productCategory`, and `productDescription`; enforce documented lengths/types; reject all unknown fields including `workspaceId`.

- [x] **Step 5: Add the thin route**

`GET` and `POST` delegate to handlers with `getSaasProjectRuntime()`. Do not modify `src/proxy.ts` or the launch gate.

- [x] **Step 6: Run GREEN, gate regression, and typecheck**

### Task 4: Apply `0001` and prove RLS plus A/B isolation against real PostgreSQL

**Files:**
- Create: `src/lib/__tests__/saas-postgres-projects.integration.test.ts`
- Verify: `.env.saas.local`, migration artifacts, catalog state

**Interfaces:**
- Integration tests use only restricted `DATABASE_URL` for application behavior.
- Migration application uses only `DATABASE_MIGRATION_URL` through the existing runner.

- [x] **Step 1: Write the real-database integration test before applying `0001`**

Cover: missing workspace setting sees zero projects; A/B create/list isolation; stable pagination; a raw query without workspace WHERE still cannot see B under A context; A-context insert with B workspace is rejected by RLS.

- [x] **Step 2: Run RED against the current database**

Run `npm run test:saas:integration`; expect the new project integration file to fail because `projects` is not yet migrated.

- [x] **Step 3: Apply the migration**

Run `node --env-file=.env.saas.local scripts/migrate-saas.mjs`. Require exit 0.

- [x] **Step 4: Verify catalog and privileges**

Confirm table owner is the migrator, RLS is enabled, the policy exists, expected FK/unique/indexes exist, and the app role has DML but no DDL/ownership.

- [x] **Step 5: Run GREEN**

Run the complete integration suite and report exact file/test counts.

### Task 5: Full regression, documentation, and scope audit

**Files:**
- Modify: `docs/saas-postgres-auth-runtime.md`
- Modify: this plan checkbox state

- [x] **Step 1: Document the project migration/API/RLS commands and verified local boundary**

Do not include credentials or claim public login/production availability.

- [x] **Step 2: Run full verification**

Run:

```bash
npm run test:saas:integration
npm test
npm run typecheck
npm run lint
npm run build
npm test -- src/lib/__tests__/saas-launch-gate.test.ts
```

Report exact counts, errors, warnings, and build warnings.

- [x] **Step 3: Audit forbidden scope**

Confirm no secret exists outside ignored env files; no SQLite schema/migration/config changed; no `/api/project` edit; no fake/public login route; no production-gate exception; no in-memory/SQLite fallback.

## Completion Boundary

Phase 1B first slice is complete only when `0001` exits 0, catalog verification proves RLS and ownership, restricted-role A/B integration tests pass, list/create handler contracts pass, full regressions pass, and the production gate remains closed. It does not mean project detail/updates, legacy import, frontend cutover, public login, or production deployment is complete.
