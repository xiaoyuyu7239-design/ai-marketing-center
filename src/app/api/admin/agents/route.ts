import { NextRequest, NextResponse } from "next/server";
import { isAdminRequest } from "@server/admin/admin-auth";
import {
  getAgentStrategy,
  mergeAgentSecrets,
  publicAgents,
  publishAgent,
  rollbackAgent,
  saveAgents,
  AgentConfigError,
  type AgentConfig,
  type AgentId,
} from "@server/admin/agents";

function agentsPayload(state: Awaited<ReturnType<typeof getAgentStrategy>>) {
  const drafts = state.draftAgents.map((agent) => ({
    ...agent,
    previous: state.previousAgents[agent.id],
  }));
  return {
    strategyRevision: state.strategyRevision,
    onlineVersion: state.onlineVersion,
    draftVersion: state.draftVersion,
    publishedAt: state.publishedAt,
    // 兼容旧 UI：agents 在管理端路由始终表示可编辑的 draft 槽。
    agents: publicAgents(drafts),
    onlineAgents: publicAgents(state.agents),
    audit: state.audit,
  };
}

function json(payload: unknown, init?: ResponseInit) {
  const response = NextResponse.json(payload, init);
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}

export async function GET(req: NextRequest) {
  if (!isAdminRequest(req)) {
    return json({ error: "Unauthorized" }, { status: 401 });
  }
  return json(agentsPayload(await getAgentStrategy()));
}

export async function PUT(req: NextRequest) {
  if (!isAdminRequest(req)) {
    return json({ error: "Unauthorized" }, { status: 401 });
  }
  const body = await req.json().catch(() => null);
  if (!body || !Array.isArray(body.agents)) {
    return json({ error: "Agent 数据格式不正确" }, { status: 400 });
  }
  try {
    const current = await getAgentStrategy();
    const agents = mergeAgentSecrets(current.draftAgents, body.agents as AgentConfig[]);
    return json(agentsPayload(await saveAgents(agents)));
  } catch (error) {
    if (error instanceof AgentConfigError) {
      return json({ error: error.message }, { status: 400 });
    }
    throw error;
  }
}

export async function POST(req: NextRequest) {
  if (!isAdminRequest(req)) {
    return json({ error: "Unauthorized" }, { status: 401 });
  }
  const body = await req.json().catch(() => ({}));
  const agentId = body.agentId as AgentId | undefined;
  if (!agentId) {
    return json({ error: "缺少 agentId" }, { status: 400 });
  }

  try {
    if (body.action === "publish") {
      return json(agentsPayload(await publishAgent(agentId)));
    }
    if (body.action === "rollback") {
      return json(agentsPayload(await rollbackAgent(agentId)));
    }
  } catch (error) {
    if (error instanceof AgentConfigError) {
      return json({ error: error.message }, { status: 409 });
    }
    throw error;
  }

  return json({ error: "未知操作" }, { status: 400 });
}
