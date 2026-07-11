import { describe, expect, it } from "vitest";
import {
  PostgresAuthRepository,
  type PgQueryExecutor,
  type PgQueryResult,
} from "@backend/saas/db/postgres-auth-repository";

type QueryCall = { text: string; values: readonly unknown[] };

class RecordingExecutor implements PgQueryExecutor {
  readonly calls: QueryCall[] = [];

  constructor(private readonly results: Array<PgQueryResult<Record<string, unknown>>>) {}

  async query<Row>(text: string, values: readonly unknown[] = []): Promise<PgQueryResult<Row>> {
    this.calls.push({ text, values });
    const result = this.results.shift();
    if (!result) throw new Error("Missing query result fixture");
    return result as PgQueryResult<Row>;
  }
}

describe("PostgresAuthRepository", () => {
  it("maps auth records and scopes workspace reads to the authenticated user", async () => {
    const expiresAt = new Date("2030-01-02T00:00:00.000Z");
    const executor = new RecordingExecutor([
      {
        rows: [{
          session_id: "session-1",
          user_id: "user-1",
          user_status: "active",
          platform_role: "user",
          expires_at: expiresAt,
          revoked_at: null,
        }],
        rowCount: 1,
      },
      {
        rows: [{
          workspace_id: "workspace-1",
          workspace_name: "Store One",
          workspace_status: "active",
          role: "member",
        }],
        rowCount: 1,
      },
      {
        rows: [{
          workspace_id: "workspace-1",
          workspace_name: "Store One",
          workspace_status: "active",
          role: "member",
        }],
        rowCount: 1,
      },
    ]);
    const repository = new PostgresAuthRepository(executor);

    await expect(repository.findSessionByTokenDigest("digest-1")).resolves.toMatchObject({
      sessionId: "session-1",
      userId: "user-1",
      expiresAt,
    });
    await expect(repository.findWorkspaceMembership("user-1", "workspace-1")).resolves.toEqual({
      workspaceId: "workspace-1",
      workspaceName: "Store One",
      workspaceStatus: "active",
      role: "member",
    });
    await expect(repository.listWorkspaceMemberships("user-1")).resolves.toHaveLength(1);

    expect(executor.calls[0]).toMatchObject({ values: ["digest-1"] });
    expect(executor.calls[0].text).toContain("WHERE s.token_digest = $1");
    expect(executor.calls[1].text).toContain("m.user_id = $1");
    expect(executor.calls[1].text).toContain("m.workspace_id = $2");
    expect(executor.calls[1].values).toEqual(["user-1", "workspace-1"]);
    expect(executor.calls[2].text).toContain("m.user_id = $1");
    expect(executor.calls[2].text).toContain("w.status = 'active'");
    expect(executor.calls[2].values).toEqual(["user-1"]);
  });

  it("creates and revokes sessions with parameterized statements", async () => {
    const createdAt = new Date("2030-01-01T00:00:00.000Z");
    const expiresAt = new Date("2030-01-08T00:00:00.000Z");
    const executor = new RecordingExecutor([
      { rows: [{ id: "session-1" }], rowCount: 1 },
      { rows: [{ id: "session-1" }], rowCount: 1 },
      { rows: [], rowCount: 1 },
      { rows: [], rowCount: 2 },
    ]);
    const repository = new PostgresAuthRepository(executor);

    await expect(repository.createSession({
      userId: "user-1",
      tokenDigest: "a".repeat(64),
      expiresAt,
      createdAt,
    })).resolves.toBe("session-1");
    await expect(repository.revokeSessionByTokenDigest("a".repeat(64), createdAt)).resolves.toBe(true);
    await expect(repository.markSessionUsed("session-1", createdAt)).resolves.toBeUndefined();
    await expect(repository.revokeSessionsForUser("user-1", createdAt)).resolves.toBe(2);

    expect(executor.calls[0].text).toContain("INSERT INTO sessions");
    expect(executor.calls[0].values).toEqual(["user-1", "a".repeat(64), expiresAt, createdAt]);
    expect(executor.calls[1].text).toContain("UPDATE sessions");
    expect(executor.calls[1].text).toContain("revoked_at IS NULL");
    expect(executor.calls[1].values).toEqual(["a".repeat(64), createdAt]);
    expect(executor.calls[2].text).toContain("last_used_at < $2 - interval '5 minutes'");
    expect(executor.calls[2].values).toEqual(["session-1", createdAt]);
    expect(executor.calls[3].text).toContain("WHERE user_id = $1 AND revoked_at IS NULL");
    expect(executor.calls[3].values).toEqual(["user-1", createdAt]);
  });

  it("returns empty values when PostgreSQL returns no row", async () => {
    const executor = new RecordingExecutor([
      { rows: [], rowCount: 0 },
      { rows: [], rowCount: 0 },
      { rows: [], rowCount: 0 },
      { rows: [], rowCount: 0 },
    ]);
    const repository = new PostgresAuthRepository(executor);

    await expect(repository.findSessionByTokenDigest("digest-1")).resolves.toBeNull();
    await expect(repository.findWorkspaceMembership("user-1", "workspace-1")).resolves.toBeNull();
    await expect(repository.listWorkspaceMemberships("user-1")).resolves.toEqual([]);
    await expect(repository.revokeSessionByTokenDigest("digest-1", new Date())).resolves.toBe(false);
  });
});
