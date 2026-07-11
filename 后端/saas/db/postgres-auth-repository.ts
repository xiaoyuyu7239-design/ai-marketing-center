import "server-only";

import type {
  CompleteAuthRepository,
  CreateSessionRecord,
  SessionAuthRecord,
  WorkspaceMembershipRecord,
  WorkspaceSummaryRecord,
} from "@server/auth/repository";

export type PgQueryResult<Row> = {
  rows: Row[];
  rowCount: number | null;
};

export interface PgQueryExecutor {
  query<Row>(text: string, values?: readonly unknown[]): Promise<PgQueryResult<Row>>;
}

type SessionRow = {
  session_id: string;
  user_id: string;
  user_status: SessionAuthRecord["userStatus"];
  platform_role: SessionAuthRecord["platformRole"];
  expires_at: Date;
  revoked_at: Date | null;
};

type WorkspaceRow = {
  workspace_id: string;
  workspace_name: string;
  workspace_status: WorkspaceMembershipRecord["workspaceStatus"];
  role: WorkspaceMembershipRecord["role"];
};

type IdRow = { id: string };

const FIND_SESSION_SQL = `
SELECT s.id AS session_id, s.user_id, u.status AS user_status,
       u.platform_role, s.expires_at, s.revoked_at
FROM sessions s
JOIN users u ON u.id = s.user_id
WHERE s.token_digest = $1
LIMIT 1;
`;

const FIND_WORKSPACE_MEMBERSHIP_SQL = `
SELECT w.id AS workspace_id, w.name AS workspace_name,
       w.status AS workspace_status, m.role
FROM memberships m
JOIN workspaces w ON w.id = m.workspace_id
WHERE m.user_id = $1 AND m.workspace_id = $2
LIMIT 1;
`;

const MARK_SESSION_USED_SQL = `
UPDATE sessions
SET last_used_at = $2
WHERE id = $1
  AND revoked_at IS NULL
  AND expires_at > $2
  AND last_used_at < $2 - interval '5 minutes';
`;

const LIST_WORKSPACE_MEMBERSHIPS_SQL = `
SELECT w.id AS workspace_id, w.name AS workspace_name,
       w.status AS workspace_status, m.role
FROM memberships m
JOIN workspaces w ON w.id = m.workspace_id
WHERE m.user_id = $1 AND w.status = 'active'
ORDER BY w.created_at ASC, w.id ASC;
`;

const CREATE_SESSION_SQL = `
INSERT INTO sessions (user_id, token_digest, expires_at, last_used_at, created_at)
VALUES ($1, $2, $3, $4, $4)
RETURNING id;
`;

const REVOKE_SESSION_SQL = `
UPDATE sessions
SET revoked_at = $2
WHERE token_digest = $1 AND revoked_at IS NULL
RETURNING id;
`;

const REVOKE_USER_SESSIONS_SQL = `
UPDATE sessions
SET revoked_at = $2
WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > $2;
`;

function mapWorkspace(row: WorkspaceRow): WorkspaceMembershipRecord {
  return {
    workspaceId: row.workspace_id,
    workspaceName: row.workspace_name,
    workspaceStatus: row.workspace_status,
    role: row.role,
  };
}

export class PostgresAuthRepository implements CompleteAuthRepository {
  constructor(private readonly executor: PgQueryExecutor) {}

  async findSessionByTokenDigest(tokenDigest: string) {
    const result = await this.executor.query<SessionRow>(FIND_SESSION_SQL, [tokenDigest]);
    const row = result.rows[0];
    if (!row) return null;
    return {
      sessionId: row.session_id,
      userId: row.user_id,
      userStatus: row.user_status,
      platformRole: row.platform_role,
      expiresAt: row.expires_at,
      revokedAt: row.revoked_at,
    } satisfies SessionAuthRecord;
  }

  async findWorkspaceMembership(userId: string, workspaceId: string) {
    const result = await this.executor.query<WorkspaceRow>(
      FIND_WORKSPACE_MEMBERSHIP_SQL,
      [userId, workspaceId],
    );
    const row = result.rows[0];
    return row ? mapWorkspace(row) : null;
  }

  async markSessionUsed(sessionId: string, usedAt: Date) {
    await this.executor.query<never>(MARK_SESSION_USED_SQL, [sessionId, usedAt]);
  }

  async listWorkspaceMemberships(userId: string): Promise<WorkspaceSummaryRecord[]> {
    const result = await this.executor.query<WorkspaceRow>(
      LIST_WORKSPACE_MEMBERSHIPS_SQL,
      [userId],
    );
    return result.rows.map(mapWorkspace);
  }

  async createSession(record: CreateSessionRecord) {
    const result = await this.executor.query<IdRow>(CREATE_SESSION_SQL, [
      record.userId,
      record.tokenDigest,
      record.expiresAt,
      record.createdAt,
    ]);
    const row = result.rows[0];
    if (!row) throw new Error("PostgreSQL did not return the created session id");
    return row.id;
  }

  async revokeSessionByTokenDigest(tokenDigest: string, revokedAt: Date) {
    const result = await this.executor.query<IdRow>(REVOKE_SESSION_SQL, [
      tokenDigest,
      revokedAt,
    ]);
    return result.rows.length > 0;
  }

  async revokeSessionsForUser(userId: string, revokedAt: Date) {
    const result = await this.executor.query<never>(REVOKE_USER_SESSIONS_SQL, [
      userId,
      revokedAt,
    ]);
    return result.rowCount ?? 0;
  }
}
