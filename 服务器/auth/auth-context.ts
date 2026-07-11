import "server-only";

import { randomUUID } from "crypto";
import type {
  PlatformRole,
  WorkspaceRole,
} from "./model";
import type { AuthRepository } from "./repository";
import { AuthError } from "./errors";
import {
  hashSessionToken,
  isValidSessionToken,
  readSessionToken,
} from "./session-token";

export type {
  AuthRepository,
  SessionAuthRecord,
  WorkspaceMembershipRecord,
} from "./repository";

export type AuthContextDependencies = {
  repository: AuthRepository;
  now?: () => Date;
  createRequestId?: () => string;
};

export type AuthContext = {
  requestId: string;
  user: {
    id: string;
    platformRole: PlatformRole;
  };
  session: {
    id: string;
    expiresAt: Date;
  };
  workspace: null | {
    id: string;
    name: string;
    role: WorkspaceRole;
  };
};

export async function getOptionalAuthContext(
  request: Request,
  dependencies: AuthContextDependencies,
): Promise<AuthContext | null> {
  const token = readSessionToken(request);
  if (!token || !isValidSessionToken(token)) return null;

  const session = await dependencies.repository.findSessionByTokenDigest(hashSessionToken(token));
  const now = dependencies.now?.() ?? new Date();
  if (
    !session
    || session.revokedAt !== null
    || session.expiresAt.getTime() <= now.getTime()
    || session.userStatus !== "active"
  ) {
    return null;
  }

  await dependencies.repository.markSessionUsed(session.sessionId, now);

  const requestedWorkspaceId = request.headers.get("x-clipforge-workspace-id")?.trim() ?? "";
  let workspace: AuthContext["workspace"] = null;
  if (requestedWorkspaceId) {
    const membership = await dependencies.repository.findWorkspaceMembership(session.userId, requestedWorkspaceId);
    if (membership?.workspaceStatus === "active") {
      workspace = {
        id: membership.workspaceId,
        name: membership.workspaceName,
        role: membership.role,
      };
    }
  }

  return {
    requestId: dependencies.createRequestId?.() ?? randomUUID(),
    user: { id: session.userId, platformRole: session.platformRole },
    session: { id: session.sessionId, expiresAt: session.expiresAt },
    workspace,
  };
}

export async function requireUser(request: Request, dependencies: AuthContextDependencies) {
  const context = await getOptionalAuthContext(request, dependencies);
  if (!context) throw new AuthError(401, "AUTH_REQUIRED", "A valid user session is required");
  return context;
}

export async function requireWorkspace(request: Request, dependencies: AuthContextDependencies) {
  const context = await requireUser(request, dependencies);
  if (!context.workspace) {
    throw new AuthError(403, "WORKSPACE_FORBIDDEN", "An active workspace membership is required");
  }
  return context as AuthContext & { workspace: NonNullable<AuthContext["workspace"]> };
}

export async function requireWorkspaceRole(
  request: Request,
  roles: readonly WorkspaceRole[],
  dependencies: AuthContextDependencies,
) {
  const context = await requireWorkspace(request, dependencies);
  if (!roles.includes(context.workspace.role)) {
    throw new AuthError(403, "INSUFFICIENT_WORKSPACE_ROLE", "The workspace role is not allowed");
  }
  return context;
}

export async function requirePlatformAdmin(request: Request, dependencies: AuthContextDependencies) {
  const context = await requireUser(request, dependencies);
  if (context.user.platformRole !== "admin") {
    throw new AuthError(403, "PLATFORM_ADMIN_REQUIRED", "Platform administrator access is required");
  }
  return context;
}
