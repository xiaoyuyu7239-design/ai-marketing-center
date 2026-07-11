import "server-only";

import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import type { SaasAuthRuntime } from "@backend/saas/db/auth-runtime";
import {
  getOptionalAuthContext,
  requireUser,
} from "./auth-context";
import type {
  ApiErrorResponse,
  ApiSuccessResponse,
  SessionPayload,
  WorkspaceListPayload,
} from "./api-contracts";
import { AuthError } from "./errors";
import { revokePersistentSession } from "./session-service";
import {
  AUTH_COOKIE_NAME,
  clearedSessionCookieOptions,
  readSessionToken,
} from "./session-token";

export type AuthApiDependencies = {
  runtime: SaasAuthRuntime;
  now?: () => Date;
  createRequestId?: () => string;
};

const NO_STORE_HEADERS = { "Cache-Control": "no-store" } as const;

function successResponse<T>(data: T, requestId: string) {
  return NextResponse.json<ApiSuccessResponse<T>>(
    { data, requestId },
    { headers: NO_STORE_HEADERS },
  );
}

function errorResponse(
  status: number,
  code: string,
  message: string,
  requestId: string,
) {
  return NextResponse.json<ApiErrorResponse>(
    { error: { code, message, requestId } },
    { status, headers: NO_STORE_HEADERS },
  );
}

function runtimeNotConfigured(runtime: Extract<SaasAuthRuntime, { enabled: false }>, requestId: string) {
  return errorResponse(503, runtime.code, runtime.reason, requestId);
}

function unexpectedError(error: unknown, requestId: string) {
  console.error("SaaS auth API request failed", {
    requestId,
    errorName: error instanceof Error ? error.name : "UnknownError",
  });
  return errorResponse(
    500,
    "AUTH_INTERNAL_ERROR",
    "The authentication service could not complete the request.",
    requestId,
  );
}

function authorizationError(error: unknown, requestId: string) {
  if (error instanceof AuthError) {
    return errorResponse(error.status, error.code, error.message, requestId);
  }
  return unexpectedError(error, requestId);
}

export async function handleGetSession(
  request: Request,
  dependencies: AuthApiDependencies,
) {
  const requestId = dependencies.createRequestId?.() ?? randomUUID();
  if (!dependencies.runtime.enabled) {
    return runtimeNotConfigured(dependencies.runtime, requestId);
  }

  try {
    const context = await getOptionalAuthContext(request, {
      repository: dependencies.runtime.repository,
      now: dependencies.now,
      createRequestId: () => requestId,
    });
    const payload: SessionPayload = context
      ? {
          authenticated: true,
          user: context.user,
          session: {
            id: context.session.id,
            expiresAt: context.session.expiresAt.toISOString(),
          },
          workspace: context.workspace,
        }
      : {
          authenticated: false,
          user: null,
          session: null,
          workspace: null,
        };
    return successResponse(payload, requestId);
  } catch (error) {
    return unexpectedError(error, requestId);
  }
}

export async function handleGetWorkspaces(
  request: Request,
  dependencies: AuthApiDependencies,
) {
  const requestId = dependencies.createRequestId?.() ?? randomUUID();
  if (!dependencies.runtime.enabled) {
    return runtimeNotConfigured(dependencies.runtime, requestId);
  }

  try {
    const context = await requireUser(request, {
      repository: dependencies.runtime.repository,
      now: dependencies.now,
      createRequestId: () => requestId,
    });
    const memberships = await dependencies.runtime.repository
      .listWorkspaceMemberships(context.user.id);
    const payload: WorkspaceListPayload = {
      workspaces: memberships.map((membership) => ({
        id: membership.workspaceId,
        name: membership.workspaceName,
        role: membership.role,
      })),
    };
    return successResponse(payload, requestId);
  } catch (error) {
    return authorizationError(error, requestId);
  }
}

export async function handleDeleteSession(
  request: Request,
  dependencies: AuthApiDependencies,
) {
  const requestId = dependencies.createRequestId?.() ?? randomUUID();
  if (!dependencies.runtime.enabled) {
    return runtimeNotConfigured(dependencies.runtime, requestId);
  }

  try {
    const token = readSessionToken(request);
    if (token) {
      await revokePersistentSession(
        token,
        dependencies.runtime.repository,
        dependencies.now,
      );
    }
    const response = new NextResponse(null, {
      status: 204,
      headers: NO_STORE_HEADERS,
    });
    response.cookies.set({
      name: AUTH_COOKIE_NAME,
      value: "",
      ...clearedSessionCookieOptions(),
    });
    return response;
  } catch (error) {
    return unexpectedError(error, requestId);
  }
}
