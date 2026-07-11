import "server-only";

import type { PgQueryExecutor } from "./postgres-auth-repository";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type WorkspaceTransactionClient = PgQueryExecutor & {
  release(): void;
};

export type WorkspaceTransactionPool = {
  connect(): Promise<WorkspaceTransactionClient>;
};

export async function withWorkspaceTransaction<T>(
  pool: WorkspaceTransactionPool,
  workspaceId: string,
  callback: (client: WorkspaceTransactionClient) => Promise<T>,
) {
  if (!UUID_PATTERN.test(workspaceId)) {
    throw new Error("Invalid workspace id");
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    try {
      await client.query(
        "SELECT set_config('app.workspace_id', $1, true)",
        [workspaceId],
      );
      const result = await callback(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Preserve the original query error.
      }
      throw error;
    }
  } finally {
    client.release();
  }
}
