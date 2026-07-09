import { NextRequest, NextResponse } from "next/server";
import { isAdminRequest } from "@server/admin/admin-auth";
import { getAgentStrategy } from "@server/admin/agents";

function runsPayload(state: Awaited<ReturnType<typeof getAgentStrategy>>) {
  return {
    agents: state.agents,
    runs: state.runs,
  };
}

export async function GET(req: NextRequest) {
  if (!isAdminRequest(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return NextResponse.json(runsPayload(await getAgentStrategy()));
}
