import type { CreateProjectInput, ProjectSummary } from "./model";

export type ProjectCursor = {
  createdAt: Date;
  id: string;
};

export type ListProjectsOptions = {
  limit: number;
  cursor: ProjectCursor | null;
};

export type ListProjectsResult = {
  projects: ProjectSummary[];
  nextCursor: string | null;
};

export interface ProjectRepository {
  listProjects(
    workspaceId: string,
    options: ListProjectsOptions,
  ): Promise<ListProjectsResult>;
  createProject(
    workspaceId: string,
    input: CreateProjectInput,
  ): Promise<ProjectSummary>;
}
