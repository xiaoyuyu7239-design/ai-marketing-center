import type { NextRequest } from "next/server";
import { getSaasAuthRuntime } from "@backend/saas/db/auth-runtime";
import { handleGetWorkspaces } from "@server/auth/api-handlers";

export async function GET(request: NextRequest) {
  return handleGetWorkspaces(request, { runtime: getSaasAuthRuntime() });
}
