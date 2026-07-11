import { sql } from "drizzle-orm";
import {
  check,
  index,
  pgEnum,
  pgPolicy,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import {
  PROJECT_CONTENT_TYPES,
  PROJECT_STATUSES,
} from "@server/projects/model";
import { workspaces } from "./auth-schema";

export const projectStatusEnum = pgEnum(
  "saas_project_status",
  PROJECT_STATUSES,
);
export const projectContentTypeEnum = pgEnum(
  "saas_project_content_type",
  PROJECT_CONTENT_TYPES,
);

const timestampColumn = (name: string) => timestamp(name, {
  withTimezone: true,
  mode: "date",
});

export const projects = pgTable("projects", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "restrict" }),
  name: text("name").notNull(),
  status: projectStatusEnum("status").notNull().default("draft"),
  contentType: projectContentTypeEnum("content_type").notNull().default("product"),
  topic: text("topic"),
  productName: text("product_name"),
  productCategory: text("product_category"),
  productDescription: text("product_description"),
  createdAt: timestampColumn("created_at").notNull().defaultNow(),
  updatedAt: timestampColumn("updated_at").notNull().defaultNow(),
}, (table) => [
  check(
    "projects_name_length_check",
    sql`char_length(btrim(${table.name})) between 1 and 120`,
  ),
  uniqueIndex("projects_workspace_id_id_unique").on(
    table.workspaceId,
    table.id,
  ),
  index("projects_workspace_created_index").on(
    table.workspaceId,
    table.createdAt.desc(),
    table.id.desc(),
  ),
  pgPolicy("projects_workspace_isolation", {
    for: "all",
    to: "public",
    using: sql`${table.workspaceId} = nullif(current_setting('app.workspace_id', true), '')::uuid`,
    withCheck: sql`${table.workspaceId} = nullif(current_setting('app.workspace_id', true), '')::uuid`,
  }),
]).enableRLS();
