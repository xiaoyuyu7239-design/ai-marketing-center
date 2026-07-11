import { describe, expect, it } from "vitest";
import { getTableConfig } from "drizzle-orm/pg-core";
import {
  authIdentities,
  contactTypeEnum,
  invitationStatusEnum,
  memberships,
  platformRoleEnum,
  sessions,
  users,
  userStatusEnum,
  workspaceInvitations,
  workspaceRoleEnum,
  workspaces,
  workspaceStatusEnum,
} from "@backend/saas/db/auth-schema";

function columnNames(table: Parameters<typeof getTableConfig>[0]) {
  return getTableConfig(table).columns.map((column) => column.name);
}

describe("SaaS auth PostgreSQL schema", () => {
  it("defines the fixed status and role vocabularies", () => {
    expect(userStatusEnum.enumValues).toEqual(["active", "suspended", "deleted"]);
    expect(platformRoleEnum.enumValues).toEqual(["user", "admin"]);
    expect(workspaceStatusEnum.enumValues).toEqual(["active", "suspended", "archived"]);
    expect(workspaceRoleEnum.enumValues).toEqual(["owner", "admin", "member"]);
    expect(invitationStatusEnum.enumValues).toEqual(["pending", "accepted", "revoked", "expired"]);
    expect(contactTypeEnum.enumValues).toEqual(["email", "phone", "external"]);
  });

  it("stores only an opaque session-token digest", () => {
    const columns = columnNames(sessions);
    expect(columns).toContain("token_digest");
    expect(columns).not.toContain("token");
    expect(columns).toEqual(expect.arrayContaining([
      "user_id",
      "expires_at",
      "revoked_at",
      "last_used_at",
    ]));
  });

  it("models identities, tenant membership, and invitations independently", () => {
    expect(getTableConfig(users).name).toBe("users");
    expect(columnNames(authIdentities)).toEqual(expect.arrayContaining([
      "provider",
      "provider_subject",
      "verified_contact",
      "verified_at",
    ]));
    expect(columnNames(workspaces)).toEqual(expect.arrayContaining(["slug", "name", "status"]));
    expect(columnNames(memberships)).toEqual(expect.arrayContaining(["workspace_id", "user_id", "role"]));
    expect(columnNames(workspaceInvitations)).toEqual(expect.arrayContaining([
      "workspace_id",
      "target_contact",
      "contact_type",
      "role",
      "status",
      "invited_by_user_id",
    ]));
  });

  it("declares database uniqueness for external subjects and session digests", () => {
    const identityIndexes = getTableConfig(authIdentities).indexes.map((index) => index.config.name);
    const sessionIndexes = getTableConfig(sessions).indexes.map((index) => index.config.name);
    expect(identityIndexes).toContain("auth_identities_provider_subject_unique");
    expect(sessionIndexes).toContain("sessions_token_digest_unique");
  });
});
