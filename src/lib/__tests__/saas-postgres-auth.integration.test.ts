import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  PostgresAuthRepository,
  type PgQueryExecutor,
} from "@backend/saas/db/postgres-auth-repository";
import {
  getOptionalAuthContext,
  requireWorkspace,
} from "@server/auth/auth-context";
import {
  createPersistentSession,
  revokeAllPersistentSessions,
  revokePersistentSession,
} from "@server/auth/session-service";
import {
  generateSessionToken,
  hashSessionToken,
} from "@server/auth/session-token";

const AUTH_TABLES = [
  "auth_identities",
  "memberships",
  "sessions",
  "users",
  "workspace_invitations",
  "workspaces",
] as const;

function requireDatabaseUrl() {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for SaaS PostgreSQL integration tests");
  }
  return databaseUrl;
}

const BASE_TIME = new Date("2030-01-01T00:00:00.000Z");

function executorFor(client: Client): PgQueryExecutor {
  return {
    async query<Row>(text: string, values: readonly unknown[] = []) {
      const result = await client.query(text, [...values]);
      return {
        rows: result.rows as Row[],
        rowCount: result.rowCount,
      };
    },
  };
}

function requestFor(token: string, workspaceId?: string) {
  const headers = new Headers({
    cookie: `clipforge_session=${token}`,
  });
  if (workspaceId) {
    headers.set("x-clipforge-workspace-id", workspaceId);
  }
  return new Request("http://localhost/api/auth/session", { headers });
}

async function insertUser(client: Client, displayName: string) {
  const userId = randomUUID();
  await client.query(
    "INSERT INTO users (id, display_name) VALUES ($1, $2)",
    [userId, displayName],
  );
  return userId;
}

async function insertWorkspace(
  client: Client,
  createdByUserId: string,
  name: string,
) {
  const workspaceId = randomUUID();
  await client.query(
    `INSERT INTO workspaces (id, slug, name, created_by_user_id)
     VALUES ($1, $2, $3, $4)`,
    [workspaceId, `test-${randomUUID()}`, name, createdByUserId],
  );
  return workspaceId;
}

async function addMembership(
  client: Client,
  workspaceId: string,
  userId: string,
  role: "owner" | "admin" | "member" = "member",
) {
  await client.query(
    `INSERT INTO memberships (workspace_id, user_id, role)
     VALUES ($1, $2, $3)`,
    [workspaceId, userId, role],
  );
}

describe("SaaS PostgreSQL auth integration", () => {
  let client: Client;
  let repository: PostgresAuthRepository;

  beforeEach(async () => {
    client = new Client({ connectionString: requireDatabaseUrl() });
    await client.connect();
    await client.query("BEGIN");
    repository = new PostgresAuthRepository(executorFor(client));
  });

  afterEach(async () => {
    await client.query("ROLLBACK");
    await client.end();
  });

  it("connects as the restricted application role and sees all auth tables", async () => {
    const identity = await client.query<{
      current_user: string;
      current_database: string;
    }>("SELECT current_user, current_database()");
    const tables = await client.query<{ table_name: string }>(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = ANY($1)
       ORDER BY table_name`,
      [[...AUTH_TABLES]],
    );

    expect(identity.rows[0]).toEqual({
      current_user: "clipforge_saas_app",
      current_database: "clipforge_saas_test",
    });
    expect(tables.rows.map((row) => row.table_name)).toEqual(
      [...AUTH_TABLES].sort(),
    );
  });

  it("stores only a session digest, reads it, and throttles last-used writes", async () => {
    const userId = await insertUser(client, "Session User");
    const session = await createPersistentSession(
      userId,
      repository,
      () => BASE_TIME,
    );

    const stored = await client.query<{
      token_digest: string;
      last_used_at: Date;
    }>(
      "SELECT token_digest, last_used_at FROM sessions WHERE id = $1",
      [session.sessionId],
    );
    expect(stored.rows[0].token_digest).toBe(hashSessionToken(session.token));
    expect(stored.rows[0].token_digest).not.toContain(session.token);

    const firstUse = new Date(BASE_TIME.getTime() + 6 * 60 * 1_000);
    await expect(getOptionalAuthContext(requestFor(session.token), {
      repository,
      now: () => firstUse,
      createRequestId: () => "request-first-use",
    })).resolves.toMatchObject({
      user: { id: userId },
      session: { id: session.sessionId },
    });

    const afterFirstUse = await client.query<{ last_used_at: Date }>(
      "SELECT last_used_at FROM sessions WHERE id = $1",
      [session.sessionId],
    );
    expect(afterFirstUse.rows[0].last_used_at).toEqual(firstUse);

    const throttledUse = new Date(firstUse.getTime() + 60 * 1_000);
    await getOptionalAuthContext(requestFor(session.token), {
      repository,
      now: () => throttledUse,
    });
    const afterThrottledUse = await client.query<{ last_used_at: Date }>(
      "SELECT last_used_at FROM sessions WHERE id = $1",
      [session.sessionId],
    );
    expect(afterThrottledUse.rows[0].last_used_at).toEqual(firstUse);
  });

  it("rejects expired and revoked sessions", async () => {
    const userId = await insertUser(client, "Expiry User");
    const expiredToken = generateSessionToken();
    await repository.createSession({
      userId,
      tokenDigest: hashSessionToken(expiredToken),
      createdAt: new Date(BASE_TIME.getTime() - 8 * 24 * 60 * 60 * 1_000),
      expiresAt: new Date(BASE_TIME.getTime() - 1),
    });
    await expect(getOptionalAuthContext(requestFor(expiredToken), {
      repository,
      now: () => BASE_TIME,
    })).resolves.toBeNull();

    const active = await createPersistentSession(
      userId,
      repository,
      () => BASE_TIME,
    );
    await expect(revokePersistentSession(
      active.token,
      repository,
      () => new Date(BASE_TIME.getTime() + 1_000),
    )).resolves.toBe(true);
    await expect(getOptionalAuthContext(requestFor(active.token), {
      repository,
      now: () => new Date(BASE_TIME.getTime() + 2_000),
    })).resolves.toBeNull();
  });

  it("invalidates suspended users and supports user-wide revocation", async () => {
    const userId = await insertUser(client, "Suspended User");
    const first = await createPersistentSession(
      userId,
      repository,
      () => BASE_TIME,
    );
    const second = await createPersistentSession(
      userId,
      repository,
      () => new Date(BASE_TIME.getTime() + 1_000),
    );

    await client.query("UPDATE users SET status = 'suspended' WHERE id = $1", [
      userId,
    ]);
    await expect(getOptionalAuthContext(requestFor(first.token), {
      repository,
      now: () => new Date(BASE_TIME.getTime() + 2_000),
    })).resolves.toBeNull();

    await client.query("UPDATE users SET status = 'active' WHERE id = $1", [
      userId,
    ]);
    await expect(revokeAllPersistentSessions(
      userId,
      repository,
      () => new Date(BASE_TIME.getTime() + 3_000),
    )).resolves.toBe(2);
    await expect(getOptionalAuthContext(requestFor(first.token), {
      repository,
      now: () => new Date(BASE_TIME.getTime() + 4_000),
    })).resolves.toBeNull();
    await expect(getOptionalAuthContext(requestFor(second.token), {
      repository,
      now: () => new Date(BASE_TIME.getTime() + 4_000),
    })).resolves.toBeNull();
  });

  it("observes workspace role changes and removes suspended workspaces", async () => {
    const userId = await insertUser(client, "Workspace User");
    const workspaceId = await insertWorkspace(client, userId, "Workspace A");
    await addMembership(client, workspaceId, userId);
    const session = await createPersistentSession(
      userId,
      repository,
      () => BASE_TIME,
    );

    await expect(getOptionalAuthContext(
      requestFor(session.token, workspaceId),
      { repository, now: () => new Date(BASE_TIME.getTime() + 1_000) },
    )).resolves.toMatchObject({ workspace: { id: workspaceId, role: "member" } });

    await client.query(
      "UPDATE memberships SET role = 'admin' WHERE workspace_id = $1 AND user_id = $2",
      [workspaceId, userId],
    );
    await expect(getOptionalAuthContext(
      requestFor(session.token, workspaceId),
      { repository, now: () => new Date(BASE_TIME.getTime() + 2_000) },
    )).resolves.toMatchObject({ workspace: { id: workspaceId, role: "admin" } });

    await expect(repository.listWorkspaceMemberships(userId)).resolves.toEqual([
      expect.objectContaining({ workspaceId, role: "admin" }),
    ]);
    await client.query("UPDATE workspaces SET status = 'suspended' WHERE id = $1", [
      workspaceId,
    ]);
    await expect(getOptionalAuthContext(
      requestFor(session.token, workspaceId),
      { repository, now: () => new Date(BASE_TIME.getTime() + 3_000) },
    )).resolves.toMatchObject({ user: { id: userId }, workspace: null });
    await expect(repository.listWorkspaceMemberships(userId)).resolves.toEqual([]);
  });

  it("keeps workspace A membership isolated from workspace B", async () => {
    const userA = await insertUser(client, "User A");
    const userB = await insertUser(client, "User B");
    const workspaceA = await insertWorkspace(client, userA, "Workspace A");
    const workspaceB = await insertWorkspace(client, userB, "Workspace B");
    await addMembership(client, workspaceA, userA, "owner");
    await addMembership(client, workspaceB, userB, "owner");
    const sessionA = await createPersistentSession(
      userA,
      repository,
      () => BASE_TIME,
    );
    const crossTenantRequest = requestFor(sessionA.token, workspaceB);

    await expect(getOptionalAuthContext(crossTenantRequest, {
      repository,
      now: () => new Date(BASE_TIME.getTime() + 1_000),
    })).resolves.toMatchObject({ user: { id: userA }, workspace: null });
    await expect(requireWorkspace(crossTenantRequest, {
      repository,
      now: () => new Date(BASE_TIME.getTime() + 1_000),
    })).rejects.toMatchObject({
      status: 403,
      code: "WORKSPACE_FORBIDDEN",
    });
    await expect(repository.listWorkspaceMemberships(userA)).resolves.toEqual([
      expect.objectContaining({ workspaceId: workspaceA }),
    ]);
    await expect(repository.findWorkspaceMembership(userA, workspaceB))
      .resolves.toBeNull();
  });
});
