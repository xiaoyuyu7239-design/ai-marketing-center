import "server-only";

import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import type { SaasProjectRuntime } from "@backend/saas/db/project-runtime";
import { requireWorkspace } from "@server/auth/auth-context";
import { AuthError } from "@server/auth/errors";
import type { CreateProjectInput, ProjectSummary } from "./model";
import { decodeProjectCursor, ProjectCursorError } from "./pagination";
import type {
  ProjectApiErrorResponse,
  ProjectApiSuccessResponse,
  ProjectCreatePayload,
  ProjectListPayload,
  ProjectPayload,
} from "./api-contracts";

const NO_STORE_HEADERS = { "Cache-Control": "no-store" } as const;
const CREATE_FIELDS = new Set([
  "name",
  "contentType",
  "topic",
  "productName",
  "productCategory",
  "productDescription",
]);

export type ProjectApiDependencies = {
  runtime: SaasProjectRuntime;
  now?: () => Date;
  createRequestId?: () => string;
};

class ProjectApiInputError extends Error {
  constructor(
    public readonly code: "INVALID_PROJECT_QUERY" | "INVALID_PROJECT_INPUT",
    message: string,
  ) {
    super(message);
    this.name = "ProjectApiInputError";
  }
}

function successResponse<T>(data: T, requestId: string, status = 200) {
  return NextResponse.json<ProjectApiSuccessResponse<T>>(
    { data, requestId },
    { status, headers: NO_STORE_HEADERS },
  );
}

function errorResponse(status: number, code: string, message: string, requestId: string) {
  return NextResponse.json<ProjectApiErrorResponse>(
    { error: { code, message, requestId } },
    { status, headers: NO_STORE_HEADERS },
  );
}

function serializeProject(project: ProjectSummary): ProjectPayload {
  return {
    ...project,
    createdAt: project.createdAt.toISOString(),
    updatedAt: project.updatedAt.toISOString(),
  };
}

function handleError(error: unknown, requestId: string) {
  if (error instanceof AuthError) {
    return errorResponse(error.status, error.code, error.message, requestId);
  }
  if (error instanceof ProjectApiInputError) {
    return errorResponse(400, error.code, error.message, requestId);
  }
  if (error instanceof ProjectCursorError) {
    return errorResponse(400, "INVALID_PROJECT_QUERY", error.message, requestId);
  }
  console.error("SaaS projects API request failed", {
    requestId,
    errorName: error instanceof Error ? error.name : "UnknownError",
  });
  return errorResponse(
    500,
    "PROJECT_INTERNAL_ERROR",
    "The project service could not complete the request.",
    requestId,
  );
}

function parseListOptions(request: Request) {
  const url = new URL(request.url);
  const rawLimit = url.searchParams.get("limit");
  const limit = rawLimit === null ? 50 : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new ProjectApiInputError(
      "INVALID_PROJECT_QUERY",
      "Project list limit must be an integer between 1 and 100.",
    );
  }
  const rawCursor = url.searchParams.get("cursor");
  return {
    limit,
    cursor: rawCursor ? decodeProjectCursor(rawCursor) : null,
  };
}

function normalizeOptionalString(
  body: Record<string, unknown>,
  key: keyof CreateProjectInput,
  maxLength: number,
) {
  const value = body[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new ProjectApiInputError("INVALID_PROJECT_INPUT", `${key} must be a string.`);
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw new ProjectApiInputError("INVALID_PROJECT_INPUT", `${key} is too long.`);
  }
  return normalized || undefined;
}

async function parseCreateInput(request: Request): Promise<CreateProjectInput> {
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    throw new ProjectApiInputError("INVALID_PROJECT_INPUT", "Project body must be valid JSON.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProjectApiInputError("INVALID_PROJECT_INPUT", "Project body must be an object.");
  }
  const body = value as Record<string, unknown>;
  for (const key of Object.keys(body)) {
    if (!CREATE_FIELDS.has(key)) {
      throw new ProjectApiInputError("INVALID_PROJECT_INPUT", `Unknown project field: ${key}.`);
    }
  }

  const name = normalizeOptionalString(body, "name", 120);
  if (body.name !== undefined && !name) {
    throw new ProjectApiInputError("INVALID_PROJECT_INPUT", "Project name cannot be empty.");
  }
  const contentType = body.contentType;
  if (
    contentType !== undefined
    && contentType !== "product"
    && contentType !== "topic"
  ) {
    throw new ProjectApiInputError(
      "INVALID_PROJECT_INPUT",
      "contentType must be product or topic.",
    );
  }

  return {
    ...(name && { name }),
    ...(contentType && { contentType }),
    ...optionalField(body, "topic", 2_000),
    ...optionalField(body, "productName", 200),
    ...optionalField(body, "productCategory", 120),
    ...optionalField(body, "productDescription", 4_000),
  };
}

function optionalField(
  body: Record<string, unknown>,
  key: "topic" | "productName" | "productCategory" | "productDescription",
  maxLength: number,
) {
  const value = normalizeOptionalString(body, key, maxLength);
  return value ? { [key]: value } : {};
}

function runtimeDisabledResponse(
  runtime: Extract<SaasProjectRuntime, { enabled: false }>,
  requestId: string,
) {
  return errorResponse(503, runtime.code, runtime.reason, requestId);
}

export async function handleListProjects(
  request: Request,
  dependencies: ProjectApiDependencies,
) {
  const requestId = dependencies.createRequestId?.() ?? randomUUID();
  if (!dependencies.runtime.enabled) {
    return runtimeDisabledResponse(dependencies.runtime, requestId);
  }
  try {
    const context = await requireWorkspace(request, {
      repository: dependencies.runtime.authRepository,
      now: dependencies.now,
      createRequestId: () => requestId,
    });
    const options = parseListOptions(request);
    const result = await dependencies.runtime.projectRepository.listProjects(
      context.workspace.id,
      options,
    );
    const payload: ProjectListPayload = {
      projects: result.projects.map(serializeProject),
      nextCursor: result.nextCursor,
    };
    return successResponse(payload, requestId);
  } catch (error) {
    return handleError(error, requestId);
  }
}

export async function handleCreateProject(
  request: Request,
  dependencies: ProjectApiDependencies,
) {
  const requestId = dependencies.createRequestId?.() ?? randomUUID();
  if (!dependencies.runtime.enabled) {
    return runtimeDisabledResponse(dependencies.runtime, requestId);
  }
  try {
    const context = await requireWorkspace(request, {
      repository: dependencies.runtime.authRepository,
      now: dependencies.now,
      createRequestId: () => requestId,
    });
    const input = await parseCreateInput(request);
    const project = await dependencies.runtime.projectRepository.createProject(
      context.workspace.id,
      input,
    );
    const payload: ProjectCreatePayload = { project: serializeProject(project) };
    return successResponse(payload, requestId, 201);
  } catch (error) {
    return handleError(error, requestId);
  }
}
