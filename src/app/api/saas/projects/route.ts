import type { NextRequest } from "next/server";
import { getSaasProjectRuntime } from "@backend/saas/db/project-runtime";
import {
  handleCreateProject,
  handleListProjects,
} from "@server/projects/api-handlers";

export async function GET(request: NextRequest) {
  return handleListProjects(request, { runtime: getSaasProjectRuntime() });
}

export async function POST(request: NextRequest) {
  return handleCreateProject(request, { runtime: getSaasProjectRuntime() });
}
