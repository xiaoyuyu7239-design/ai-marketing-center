import { describe, expect, it } from "vitest";
import { PostgresProjectRepository } from "@backend/saas/db/postgres-project-repository";
import { decodeProjectCursor } from "@server/projects/pagination";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";

type QueryCall = { text: string; values: readonly unknown[] };

const rows = [
  {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    workspace_id: WORKSPACE_ID,
    name: "Newest",
    status: "draft",
    content_type: "product",
    topic: null,
    product_name: "A",
    product_category: null,
    product_description: null,
    created_at: new Date("2030-01-03T00:00:00.000Z"),
    updated_at: new Date("2030-01-03T00:00:00.000Z"),
  },
  {
    id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    workspace_id: WORKSPACE_ID,
    name: "Older",
    status: "draft",
    content_type: "topic",
    topic: "Topic",
    product_name: null,
    product_category: null,
    product_description: null,
    created_at: new Date("2030-01-02T00:00:00.000Z"),
    updated_at: new Date("2030-01-02T00:00:00.000Z"),
  },
  {
    id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    workspace_id: WORKSPACE_ID,
    name: "Extra",
    status: "draft",
    content_type: "product",
    topic: null,
    product_name: null,
    product_category: null,
    product_description: null,
    created_at: new Date("2030-01-01T00:00:00.000Z"),
    updated_at: new Date("2030-01-01T00:00:00.000Z"),
  },
] as const;

function fixture(projectRows: readonly Record<string, unknown>[]) {
  const calls: QueryCall[] = [];
  const client = {
    async query<Row>(text: string, values: readonly unknown[] = []) {
      calls.push({ text, values });
      if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK" || text.includes("set_config")) {
        return { rows: [] as Row[], rowCount: 0 };
      }
      return { rows: [...projectRows] as Row[], rowCount: projectRows.length };
    },
    release() {},
  };
  const pool = { connect: async () => client };
  return { calls, repository: new PostgresProjectRepository(pool) };
}

describe("PostgresProjectRepository", () => {
  it("lists only the requested workspace with bounded keyset pagination", async () => {
    const { calls, repository } = fixture(rows);
    const result = await repository.listProjects(WORKSPACE_ID, {
      limit: 2,
      cursor: null,
    });

    expect(result.projects.map((project) => project.name)).toEqual(["Newest", "Older"]);
    expect(result.nextCursor).not.toBeNull();
    expect(decodeProjectCursor(result.nextCursor!)).toEqual({
      createdAt: rows[1].created_at,
      id: rows[1].id,
    });
    const query = calls.find((call) => call.text.includes("FROM projects"));
    expect(query?.text).toContain("workspace_id = $1");
    expect(query?.text).toContain("ORDER BY created_at DESC, id DESC");
    expect(query?.values).toEqual([WORKSPACE_ID, 3]);
  });

  it("uses cursor values and workspace ID as separate parameters", async () => {
    const { calls, repository } = fixture([]);
    const cursor = {
      createdAt: new Date("2030-01-02T00:00:00.000Z"),
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    };
    await repository.listProjects(WORKSPACE_ID, { limit: 10, cursor });

    const query = calls.find((call) => call.text.includes("FROM projects"));
    expect(query?.text).toContain("(created_at, id) < ($2, $3)");
    expect(query?.values).toEqual([WORKSPACE_ID, cursor.createdAt, cursor.id, 11]);
  });

  it("creates a draft in the authenticated workspace and ignores injected ownership", async () => {
    const created = [{ ...rows[0], name: "Created" }];
    const { calls, repository } = fixture(created);
    const project = await repository.createProject(WORKSPACE_ID, {
      name: "  Created  ",
      contentType: "product",
      workspaceId: OTHER_WORKSPACE_ID,
      status: "done",
    } as never);

    expect(project.name).toBe("Created");
    const query = calls.find((call) => call.text.includes("INSERT INTO projects"));
    expect(query?.text).toContain("workspace_id");
    expect(query?.text.split("VALUES")[0]).not.toContain("status");
    expect(query?.values[0]).toBe(WORKSPACE_ID);
    expect(query?.values).not.toContain(OTHER_WORKSPACE_ID);
  });
});
