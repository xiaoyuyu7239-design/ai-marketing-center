import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { PostgresProjectRepository } from "@backend/saas/db/postgres-project-repository";
import {
  withWorkspaceTransaction,
  type WorkspaceTransactionClient,
  type WorkspaceTransactionPool,
} from "@backend/saas/db/workspace-transaction";
import { decodeProjectCursor } from "@server/projects/pagination";

const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_B = "22222222-2222-4222-8222-222222222222";
const WORKSPACE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WORKSPACE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function requireDatabaseUrl() {
  const value = process.env.DATABASE_URL?.trim();
  if (!value) throw new Error("DATABASE_URL is required for project integration tests");
  return value;
}

function workspacePool(pool: Pool): WorkspaceTransactionPool {
  return {
    async connect() {
      const client = await pool.connect();
      return {
        query: client.query.bind(client) as WorkspaceTransactionClient["query"],
        release: () => client.release(),
      };
    },
  };
}

describe("SaaS PostgreSQL projects RLS integration", () => {
  let pool: Pool;
  let scopedPool: WorkspaceTransactionPool;
  let repository: PostgresProjectRepository;

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireDatabaseUrl(), max: 4 });
    scopedPool = workspacePool(pool);
    repository = new PostgresProjectRepository(scopedPool);
    await pool.query(
      `INSERT INTO users (id, display_name)
       VALUES ($1, 'Project User A'), ($2, 'Project User B')
       ON CONFLICT (id) DO NOTHING`,
      [USER_A, USER_B],
    );
    await pool.query(
      `INSERT INTO workspaces (id, slug, name, created_by_user_id)
       VALUES
         ($1, 'phase-1b-workspace-a', 'Workspace A', $2),
         ($3, 'phase-1b-workspace-b', 'Workspace B', $4)
       ON CONFLICT (id) DO NOTHING`,
      [WORKSPACE_A, USER_A, WORKSPACE_B, USER_B],
    );
    await pool.query(
      `INSERT INTO memberships (workspace_id, user_id, role)
       VALUES ($1, $2, 'owner'), ($3, $4, 'owner')
       ON CONFLICT (workspace_id, user_id) DO NOTHING`,
      [WORKSPACE_A, USER_A, WORKSPACE_B, USER_B],
    );
  });

  beforeEach(async () => {
    await withWorkspaceTransaction(scopedPool, WORKSPACE_A, (client) => (
      client.query("DELETE FROM projects WHERE workspace_id = $1", [WORKSPACE_A])
    ));
    await withWorkspaceTransaction(scopedPool, WORKSPACE_B, (client) => (
      client.query("DELETE FROM projects WHERE workspace_id = $1", [WORKSPACE_B])
    ));
  });

  afterAll(async () => {
    if (!pool) return;
    try {
      await withWorkspaceTransaction(scopedPool, WORKSPACE_A, (client) => (
        client.query("DELETE FROM projects WHERE workspace_id = $1", [WORKSPACE_A])
      ));
      await withWorkspaceTransaction(scopedPool, WORKSPACE_B, (client) => (
        client.query("DELETE FROM projects WHERE workspace_id = $1", [WORKSPACE_B])
      ));
    } catch {
      // The RED run happens before the projects migration exists.
    }
    await pool.query(
      "DELETE FROM memberships WHERE workspace_id = ANY($1)",
      [[WORKSPACE_A, WORKSPACE_B]],
    );
    await pool.query(
      "DELETE FROM workspaces WHERE id = ANY($1)",
      [[WORKSPACE_A, WORKSPACE_B]],
    );
    await pool.query("DELETE FROM users WHERE id = ANY($1)", [[USER_A, USER_B]]);
    await pool.end();
  });

  it("owns the RLS-enabled table with the migrator while the app remains restricted", async () => {
    const result = await pool.query<{
      tableowner: string;
      relrowsecurity: boolean;
      policy_count: number;
      can_select: boolean;
      can_insert: boolean;
      can_update: boolean;
      can_delete: boolean;
      can_truncate: boolean;
    }>(
      `SELECT t.tableowner,
              c.relrowsecurity,
              (SELECT count(*)::int FROM pg_policies p
               WHERE p.schemaname = 'public'
                 AND p.tablename = 'projects'
                 AND p.policyname = 'projects_workspace_isolation') AS policy_count,
              has_table_privilege(current_user, 'public.projects', 'SELECT') AS can_select,
              has_table_privilege(current_user, 'public.projects', 'INSERT') AS can_insert,
              has_table_privilege(current_user, 'public.projects', 'UPDATE') AS can_update,
              has_table_privilege(current_user, 'public.projects', 'DELETE') AS can_delete,
              has_table_privilege(current_user, 'public.projects', 'TRUNCATE') AS can_truncate
       FROM pg_tables t
       JOIN pg_class c ON c.relname = t.tablename
       JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = t.schemaname
       WHERE t.schemaname = 'public' AND t.tablename = 'projects'`,
    );
    expect(result.rows[0]).toEqual({
      tableowner: "clipforge_saas_migrator",
      relrowsecurity: true,
      policy_count: 1,
      can_select: true,
      can_insert: true,
      can_update: true,
      can_delete: true,
      can_truncate: false,
    });
  });

  it("shows no projects without a workspace setting and isolates A from B", async () => {
    const projectA = await repository.createProject(WORKSPACE_A, { name: "Project A" });
    const projectB = await repository.createProject(WORKSPACE_B, { name: "Project B" });

    const unscoped = await pool.query("SELECT id FROM projects");
    expect(unscoped.rows).toEqual([]);
    await expect(repository.listProjects(WORKSPACE_A, { limit: 50, cursor: null }))
      .resolves.toMatchObject({ projects: [{ id: projectA.id, workspaceId: WORKSPACE_A }] });
    await expect(repository.listProjects(WORKSPACE_B, { limit: 50, cursor: null }))
      .resolves.toMatchObject({ projects: [{ id: projectB.id, workspaceId: WORKSPACE_B }] });

    const rawA = await withWorkspaceTransaction(scopedPool, WORKSPACE_A, (client) => (
      client.query<{ workspace_id: string }>("SELECT workspace_id FROM projects ORDER BY id")
    ));
    expect(rawA.rows).toEqual([{ workspace_id: WORKSPACE_A }]);
  });

  it("paginates deterministically within one workspace", async () => {
    const first = await repository.createProject(WORKSPACE_A, { name: "Oldest" });
    const second = await repository.createProject(WORKSPACE_A, { name: "Middle" });
    const third = await repository.createProject(WORKSPACE_A, { name: "Newest" });
    await withWorkspaceTransaction(scopedPool, WORKSPACE_A, async (client) => {
      await client.query(
        `UPDATE projects
         SET created_at = CASE id
           WHEN $1 THEN '2030-01-01T00:00:00.000Z'::timestamptz
           WHEN $2 THEN '2030-01-02T00:00:00.000Z'::timestamptz
           WHEN $3 THEN '2030-01-03T00:00:00.000Z'::timestamptz
         END
         WHERE workspace_id = $4`,
        [first.id, second.id, third.id, WORKSPACE_A],
      );
    });

    const pageOne = await repository.listProjects(WORKSPACE_A, { limit: 2, cursor: null });
    expect(pageOne.projects.map((project) => project.name)).toEqual(["Newest", "Middle"]);
    expect(pageOne.nextCursor).not.toBeNull();
    const pageTwo = await repository.listProjects(WORKSPACE_A, {
      limit: 2,
      cursor: decodeProjectCursor(pageOne.nextCursor!),
    });
    expect(pageTwo.projects.map((project) => project.name)).toEqual(["Oldest"]);
    expect(pageTwo.nextCursor).toBeNull();
  });

  it("rejects inserting workspace B ownership inside workspace A context", async () => {
    await expect(withWorkspaceTransaction(scopedPool, WORKSPACE_A, (client) => (
      client.query(
        "INSERT INTO projects (workspace_id, name) VALUES ($1, $2)",
        [WORKSPACE_B, `forbidden-${randomUUID()}`],
      )
    ))).rejects.toMatchObject({ code: "42501" });
  });
});
