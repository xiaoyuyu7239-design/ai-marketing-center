export const USER_STATUSES = ["active", "suspended", "deleted"] as const;
export const PLATFORM_ROLES = ["user", "admin"] as const;
export const WORKSPACE_STATUSES = ["active", "suspended", "archived"] as const;
export const WORKSPACE_ROLES = ["owner", "admin", "member"] as const;
export const INVITATION_STATUSES = ["pending", "accepted", "revoked", "expired"] as const;
export const CONTACT_TYPES = ["email", "phone", "external"] as const;

export type UserStatus = (typeof USER_STATUSES)[number];
export type PlatformRole = (typeof PLATFORM_ROLES)[number];
export type WorkspaceStatus = (typeof WORKSPACE_STATUSES)[number];
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];
export type InvitationStatus = (typeof INVITATION_STATUSES)[number];
export type ContactType = (typeof CONTACT_TYPES)[number];
