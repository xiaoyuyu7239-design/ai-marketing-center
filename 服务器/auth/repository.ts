import type {
  PlatformRole,
  UserStatus,
  WorkspaceRole,
  WorkspaceStatus,
} from "./model";

export type SessionAuthRecord = {
  sessionId: string;
  userId: string;
  userStatus: UserStatus;
  platformRole: PlatformRole;
  expiresAt: Date;
  revokedAt: Date | null;
};

export type WorkspaceMembershipRecord = {
  workspaceId: string;
  workspaceName: string;
  workspaceStatus: WorkspaceStatus;
  role: WorkspaceRole;
};

export interface AuthRepository {
  findSessionByTokenDigest(tokenDigest: string): Promise<SessionAuthRecord | null>;
  markSessionUsed(sessionId: string, usedAt: Date): Promise<void>;
  findWorkspaceMembership(
    userId: string,
    workspaceId: string,
  ): Promise<WorkspaceMembershipRecord | null>;
}

export type CreateSessionRecord = {
  userId: string;
  tokenDigest: string;
  expiresAt: Date;
  createdAt: Date;
};

export type WorkspaceSummaryRecord = WorkspaceMembershipRecord;

export interface SessionRepository {
  createSession(record: CreateSessionRecord): Promise<string>;
  revokeSessionByTokenDigest(tokenDigest: string, revokedAt: Date): Promise<boolean>;
  revokeSessionsForUser(userId: string, revokedAt: Date): Promise<number>;
}

export interface WorkspaceRepository {
  listWorkspaceMemberships(userId: string): Promise<WorkspaceSummaryRecord[]>;
}

export type CompleteAuthRepository = AuthRepository & SessionRepository & WorkspaceRepository;
