import { NextRequest, NextResponse } from "next/server";
import { isAdminRequest } from "@server/admin/admin-auth";
import {
  getAgentStrategy,
  publishAgent,
  rollbackAgent,
  saveAgents,
  type AgentConfig,
  type AgentId,
} from "@server/admin/agents";

function agentsPayload(state: Awaited<ReturnType<typeof getAgentStrategy>>) {
  return {
    onlineVersion: state.onlineVersion,
    draftVersion: state.draftVersion,
    publishedAt: state.publishedAt,
    agents: state.agents,
  };
}

export async function GET(req: NextRequest) {
  if (!isAdminRequest(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return NextResponse.json(agentsPayload(await getAgentStrategy()));
}

export async function PUT(req: NextRequest) {
  if (!isAdminRequest(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const body = await req.json().catch(() => null);
  if (!body || !Array.isArray(body.agents)) {
    return NextResponse.json({ error: "Agent 数据格式不正确" }, { status: 400 });
  }
  return NextResponse.json(agentsPayload(await saveAgents(body.agents as AgentConfig[])));
}

export async function POST(req: NextRequest) {
  if (!isAdminRequest(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const body = await req.json().catch(() => ({}));
  const agentId = body.agentId as AgentId | undefined;
  if (!agentId) {
    return NextResponse.json({ error: "缺少 agentId" }, { status: 400 });
  }

  if (body.action === "publish") {
    return NextResponse.json(agentsPayload(await publishAgent(agentId)));
  }
  if (body.action === "rollback") {
    return NextResponse.json(agentsPayload(await rollbackAgent(agentId)));
  }

  return NextResponse.json({ error: "未知操作" }, { status: 400 });
}
