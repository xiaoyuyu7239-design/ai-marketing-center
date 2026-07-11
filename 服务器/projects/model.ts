export const PROJECT_STATUSES = [
  "draft",
  "scripting",
  "assets",
  "video",
  "composing",
  "done",
] as const;

export const PROJECT_CONTENT_TYPES = ["product", "topic"] as const;

export type ProjectStatus = (typeof PROJECT_STATUSES)[number];
export type ProjectContentType = (typeof PROJECT_CONTENT_TYPES)[number];

export type ProjectSummary = {
  id: string;
  workspaceId: string;
  name: string;
  status: ProjectStatus;
  contentType: ProjectContentType;
  topic: string | null;
  productName: string | null;
  productCategory: string | null;
  productDescription: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type CreateProjectInput = {
  name?: string;
  contentType?: ProjectContentType;
  topic?: string;
  productName?: string;
  productCategory?: string;
  productDescription?: string;
};
