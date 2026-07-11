import type { ProjectCursor } from "./repository";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_CURSOR_LENGTH = 512;

export class ProjectCursorError extends Error {
  constructor() {
    super("Invalid project cursor");
    this.name = "ProjectCursorError";
  }
}

export function encodeProjectCursor(cursor: ProjectCursor) {
  return Buffer.from(JSON.stringify({
    createdAt: cursor.createdAt.toISOString(),
    id: cursor.id,
  }), "utf8").toString("base64url");
}

export function decodeProjectCursor(value: string): ProjectCursor {
  if (!value || value.length > MAX_CURSOR_LENGTH) throw new ProjectCursorError();
  try {
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as {
      createdAt?: unknown;
      id?: unknown;
    };
    if (typeof decoded.createdAt !== "string" || typeof decoded.id !== "string") {
      throw new ProjectCursorError();
    }
    const createdAt = new Date(decoded.createdAt);
    if (
      Number.isNaN(createdAt.getTime())
      || createdAt.toISOString() !== decoded.createdAt
      || !UUID_PATTERN.test(decoded.id)
    ) {
      throw new ProjectCursorError();
    }
    return { createdAt, id: decoded.id };
  } catch (error) {
    if (error instanceof ProjectCursorError) throw error;
    throw new ProjectCursorError();
  }
}
