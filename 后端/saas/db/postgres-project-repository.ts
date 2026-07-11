import "server-only";

import type {
  CreateProjectInput,
  ProjectContentType,
  ProjectStatus,
  ProjectSummary,
} from "@server/projects/model";
import type {
  ListProjectsOptions,
  ProjectRepository,
} from "@server/projects/repository";
import { encodeProjectCursor } from "@server/projects/pagination";
import {
  withWorkspaceTransaction,
  type WorkspaceTransactionPool,
} from "./workspace-transaction";

type ProjectRow = {
  id: string;
  workspace_id: string;
  name: string;
  status: ProjectStatus;
  content_type: ProjectContentType;
  topic: string | null;
  product_name: string | null;
  product_category: string | null;
  product_description: string | null;
  created_at: Date;
  updated_at: Date;
};

const LIST_PROJECTS_SQL = `
SELECT id, workspace_id, name, status, content_type, topic,
       product_name, product_category, product_description,
       created_at, updated_at
FROM projects
WHERE workspace_id = $1
ORDER BY created_at DESC, id DESC
LIMIT $2;
`;

const LIST_PROJECTS_AFTER_CURSOR_SQL = `
SELECT id, workspace_id, name, status, content_type, topic,
       product_name, product_category, product_description,
       created_at, updated_at
FROM projects
WHERE workspace_id = $1
  AND (created_at, id) < ($2, $3)
ORDER BY created_at DESC, id DESC
LIMIT $4;
`;

const CREATE_PROJECT_SQL = `
INSERT INTO projects (
  workspace_id, name, content_type, topic,
  product_name, product_category, product_description
)
VALUES ($1, $2, $3, $4, $5, $6, $7)
RETURNING id, workspace_id, name, status, content_type, topic,
          product_name, product_category, product_description,
          created_at, updated_at;
`;

function mapProject(row: ProjectRow): ProjectSummary {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    status: row.status,
    contentType: row.content_type,
    topic: row.topic,
    productName: row.product_name,
    productCategory: row.product_category,
    productDescription: row.product_description,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function optionalText(value: string | undefined) {
  const normalized = value?.trim() ?? "";
  return normalized || null;
}

function normalizeCreateInput(input: CreateProjectInput) {
  const name = input.name?.trim() || "未命名项目";
  if (name.length > 120) throw new Error("Project name is too long");
  const contentType = input.contentType ?? "product";
  if (contentType !== "product" && contentType !== "topic") {
    throw new Error("Invalid project content type");
  }
  return {
    name,
    contentType,
    topic: optionalText(input.topic),
    productName: optionalText(input.productName),
    productCategory: optionalText(input.productCategory),
    productDescription: optionalText(input.productDescription),
  };
}

export class PostgresProjectRepository implements ProjectRepository {
  constructor(private readonly pool: WorkspaceTransactionPool) {}

  async listProjects(workspaceId: string, options: ListProjectsOptions) {
    if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100) {
      throw new Error("Project list limit must be between 1 and 100");
    }
    return withWorkspaceTransaction(this.pool, workspaceId, async (client) => {
      const queryLimit = options.limit + 1;
      const result = options.cursor
        ? await client.query<ProjectRow>(LIST_PROJECTS_AFTER_CURSOR_SQL, [
            workspaceId,
            options.cursor.createdAt,
            options.cursor.id,
            queryLimit,
          ])
        : await client.query<ProjectRow>(LIST_PROJECTS_SQL, [
            workspaceId,
            queryLimit,
          ]);
      const visibleRows = result.rows.slice(0, options.limit);
      const lastVisibleRow = visibleRows.at(-1);
      return {
        projects: visibleRows.map(mapProject),
        nextCursor: result.rows.length > options.limit && lastVisibleRow
          ? encodeProjectCursor({
              createdAt: lastVisibleRow.created_at,
              id: lastVisibleRow.id,
            })
          : null,
      };
    });
  }

  async createProject(workspaceId: string, input: CreateProjectInput) {
    const normalized = normalizeCreateInput(input);
    return withWorkspaceTransaction(this.pool, workspaceId, async (client) => {
      const result = await client.query<ProjectRow>(CREATE_PROJECT_SQL, [
        workspaceId,
        normalized.name,
        normalized.contentType,
        normalized.topic,
        normalized.productName,
        normalized.productCategory,
        normalized.productDescription,
      ]);
      const row = result.rows[0];
      if (!row) throw new Error("PostgreSQL did not return the created project");
      return mapProject(row);
    });
  }
}
