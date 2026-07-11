import type { NextRequest } from "next/server";
import { getSaasAuthRuntime } from "@backend/saas/db/auth-runtime";
import {
  handleDeleteSession,
  handleGetSession,
} from "@server/auth/api-handlers";

export async function GET(request: NextRequest) {
  return handleGetSession(request, { runtime: getSaasAuthRuntime() });
}

export async function DELETE(request: NextRequest) {
  return handleDeleteSession(request, { runtime: getSaasAuthRuntime() });
}
