import { sql } from "drizzle-orm";
import {
  char,
  index,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import {
  CONTACT_TYPES,
  INVITATION_STATUSES,
  PLATFORM_ROLES,
  USER_STATUSES,
  WORKSPACE_ROLES,
  WORKSPACE_STATUSES,
} from "@server/auth/model";

export const userStatusEnum = pgEnum("saas_user_status", USER_STATUSES);
export const platformRoleEnum = pgEnum("saas_platform_role", PLATFORM_ROLES);
export const workspaceStatusEnum = pgEnum("saas_workspace_status", WORKSPACE_STATUSES);
export const workspaceRoleEnum = pgEnum("saas_workspace_role", WORKSPACE_ROLES);
export const invitationStatusEnum = pgEnum("saas_invitation_status", INVITATION_STATUSES);
export const contactTypeEnum = pgEnum("saas_contact_type", CONTACT_TYPES);

const timestampColumn = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export const users = pgTable("users", {
  id: uuid("id").defaultRandom().primaryKey(),
  status: userStatusEnum("status").notNull().default("active"),
  platformRole: platformRoleEnum("platform_role").notNull().default("user"),
  displayName: text("display_name"),
  createdAt: timestampColumn("created_at").notNull().defaultNow(),
  updatedAt: timestampColumn("updated_at").notNull().defaultNow(),
});

export const authIdentities = pgTable("auth_identities", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  provider: text("provider").notNull(),
  providerSubject: text("provider_subject").notNull(),
  contactType: contactTypeEnum("contact_type").notNull(),
  verifiedContact: text("verified_contact").notNull(),
  verifiedAt: timestampColumn("verified_at").notNull(),
  createdAt: timestampColumn("created_at").notNull().defaultNow(),
  updatedAt: timestampColumn("updated_at").notNull().defaultNow(),
}, (table) => [
  uniqueIndex("auth_identities_provider_subject_unique").on(table.provider, table.providerSubject),
  index("auth_identities_user_id_index").on(table.userId),
  index("auth_identities_verified_contact_index").on(table.contactType, table.verifiedContact),
]);

export const sessions = pgTable("sessions", {
  id: uuid("id").defaultRandom().primaryKey(),
  tokenDigest: char("token_digest", { length: 64 }).notNull(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  expiresAt: timestampColumn("expires_at").notNull(),
  revokedAt: timestampColumn("revoked_at"),
  lastUsedAt: timestampColumn("last_used_at").notNull().defaultNow(),
  createdAt: timestampColumn("created_at").notNull().defaultNow(),
}, (table) => [
  uniqueIndex("sessions_token_digest_unique").on(table.tokenDigest),
  index("sessions_user_id_index").on(table.userId),
  index("sessions_expires_at_index").on(table.expiresAt),
]);

export const workspaces = pgTable("workspaces", {
  id: uuid("id").defaultRandom().primaryKey(),
  slug: text("slug").notNull(),
  name: text("name").notNull(),
  status: workspaceStatusEnum("status").notNull().default("active"),
  createdByUserId: uuid("created_by_user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  createdAt: timestampColumn("created_at").notNull().defaultNow(),
  updatedAt: timestampColumn("updated_at").notNull().defaultNow(),
}, (table) => [
  uniqueIndex("workspaces_slug_unique").on(table.slug),
  index("workspaces_created_by_user_id_index").on(table.createdByUserId),
]);

export const memberships = pgTable("memberships", {
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  role: workspaceRoleEnum("role").notNull().default("member"),
  createdAt: timestampColumn("created_at").notNull().defaultNow(),
  updatedAt: timestampColumn("updated_at").notNull().defaultNow(),
}, (table) => [
  primaryKey({ name: "memberships_pkey", columns: [table.workspaceId, table.userId] }),
  index("memberships_user_id_index").on(table.userId),
]);

export const workspaceInvitations = pgTable("workspace_invitations", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  targetContact: text("target_contact").notNull(),
  contactType: contactTypeEnum("contact_type").notNull(),
  role: workspaceRoleEnum("role").notNull().default("member"),
  status: invitationStatusEnum("status").notNull().default("pending"),
  invitedByUserId: uuid("invited_by_user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  acceptedByUserId: uuid("accepted_by_user_id").references(() => users.id, { onDelete: "set null" }),
  expiresAt: timestampColumn("expires_at").notNull(),
  acceptedAt: timestampColumn("accepted_at"),
  revokedAt: timestampColumn("revoked_at"),
  createdAt: timestampColumn("created_at").notNull().defaultNow(),
  updatedAt: timestampColumn("updated_at").notNull().defaultNow(),
}, (table) => [
  uniqueIndex("workspace_invitations_pending_contact_unique")
    .on(table.workspaceId, table.contactType, table.targetContact)
    .where(sql`${table.status} = 'pending'`),
  index("workspace_invitations_workspace_id_index").on(table.workspaceId),
  index("workspace_invitations_target_contact_index").on(table.contactType, table.targetContact),
]);
