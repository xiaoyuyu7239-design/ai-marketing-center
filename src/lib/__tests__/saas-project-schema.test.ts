import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import {
  projectContentTypeEnum,
  projectStatusEnum,
  projects,
} from "@backend/saas/db/project-schema";
import {
  PROJECT_CONTENT_TYPES,
  PROJECT_STATUSES,
} from "@server/projects/model";

describe("SaaS projects PostgreSQL schema", () => {
  it("uses the approved project vocabularies", () => {
    expect(PROJECT_STATUSES).toEqual([
      "draft",
      "scripting",
      "assets",
      "video",
      "composing",
      "done",
    ]);
    expect(PROJECT_CONTENT_TYPES).toEqual(["product", "topic"]);
    expect(projectStatusEnum.enumValues).toEqual(PROJECT_STATUSES);
    expect(projectContentTypeEnum.enumValues).toEqual(PROJECT_CONTENT_TYPES);
  });

  it("contains only the approved first-slice project fields", () => {
    const config = getTableConfig(projects);
    expect(config.name).toBe("projects");
    expect(config.columns.map((column) => column.name)).toEqual([
      "id",
      "workspace_id",
      "name",
      "status",
      "content_type",
      "topic",
      "product_name",
      "product_category",
      "product_description",
      "created_at",
      "updated_at",
    ]);
    expect(config.columns.find((column) => column.name === "workspace_id")?.notNull)
      .toBe(true);
  });

  it("declares tenant constraints, list index, and row-level security", () => {
    const config = getTableConfig(projects);
    expect(config.indexes.map((index) => index.config.name)).toEqual(
      expect.arrayContaining([
        "projects_workspace_id_id_unique",
        "projects_workspace_created_index",
      ]),
    );
    expect(config.foreignKeys).toHaveLength(1);
    expect(config.policies.map((policy) => policy.name)).toContain(
      "projects_workspace_isolation",
    );
    expect(config.enableRLS).toBe(true);
  });
});
