import { describe, expect, it, vi } from "vitest";
import { withWorkspaceTransaction } from "@backend/saas/db/workspace-transaction";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";

function fixture() {
  const events: string[] = [];
  const client = {
    async query(text: string, values: readonly unknown[] = []) {
      if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") {
        events.push(text);
      } else if (text.includes("set_config")) {
        events.push(`set_config:${String(values[0])}`);
      } else {
        events.push("query");
      }
      return { rows: [], rowCount: 0 };
    },
    release: vi.fn(() => events.push("release")),
  };
  const pool = {
    connect: vi.fn(async () => {
      events.push("connect");
      return client;
    }),
  };
  return { events, client, pool };
}

describe("workspace PostgreSQL transactions", () => {
  it("sets a transaction-local workspace before executing the callback", async () => {
    const { events, pool } = fixture();

    await expect(withWorkspaceTransaction(pool, WORKSPACE_ID, async (client) => {
      await client.query("SELECT 1");
      return "ok";
    })).resolves.toBe("ok");

    expect(events).toEqual([
      "connect",
      "BEGIN",
      `set_config:${WORKSPACE_ID}`,
      "query",
      "COMMIT",
      "release",
    ]);
  });

  it("rolls back and releases the client when the callback fails", async () => {
    const { events, pool } = fixture();

    await expect(withWorkspaceTransaction(pool, WORKSPACE_ID, async () => {
      throw new Error("project query failed");
    })).rejects.toThrow("project query failed");

    expect(events).toEqual([
      "connect",
      "BEGIN",
      `set_config:${WORKSPACE_ID}`,
      "ROLLBACK",
      "release",
    ]);
  });

  it("rejects malformed workspace IDs before taking a connection", async () => {
    const { pool } = fixture();
    await expect(withWorkspaceTransaction(pool, "workspace-a", async () => null))
      .rejects.toThrow("Invalid workspace id");
    expect(pool.connect).not.toHaveBeenCalled();
  });
});
