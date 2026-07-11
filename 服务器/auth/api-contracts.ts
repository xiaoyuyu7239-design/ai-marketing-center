import type { PlatformRole, WorkspaceRole } from "./model";

export type ApiErrorResponse = {
  error: {
    code: string;
    message: string;
    requestId: string;
  };
};

export type ApiSuccessResponse<T> = {
  data: T;
  requestId: string;
};

export type SessionPayload = {
  authenticated: boolean;
  user: null | {
    id: string;
    platformRole: PlatformRole;
  };
  session: null | {
    id: string;
    expiresAt: string;
  };
  workspace: null | {
    id: string;
    name: string;
    role: WorkspaceRole;
  };
};

export type WorkspaceListPayload = {
  workspaces: Array<{
    id: string;
    name: string;
    role: WorkspaceRole;
  }>;
};
