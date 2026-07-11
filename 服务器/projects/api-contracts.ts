import type { ProjectContentType, ProjectStatus } from "./model";

export type ProjectApiErrorResponse = {
  error: { code: string; message: string; requestId: string };
};

export type ProjectApiSuccessResponse<T> = {
  data: T;
  requestId: string;
};

export type ProjectPayload = {
  id: string;
  workspaceId: string;
  name: string;
  status: ProjectStatus;
  contentType: ProjectContentType;
  topic: string | null;
  productName: string | null;
  productCategory: string | null;
  productDescription: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ProjectListPayload = {
  projects: ProjectPayload[];
  nextCursor: string | null;
};

export type ProjectCreatePayload = {
  project: ProjectPayload;
};
