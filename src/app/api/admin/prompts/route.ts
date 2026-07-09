import { NextRequest, NextResponse } from "next/server";
import { isAdminRequest } from "@server/admin/admin-auth";
import { getAgentStrategy, type AgentConfig, type AgentPromptVersion } from "@server/admin/agents";
import { savePrompts } from "@server/admin/prompts";

function promptsPayload(state: Awaited<ReturnType<typeof getAgentStrategy>>) {
  return {
    onlineVersion: state.onlineVersion,
    draftVersion: state.draftVersion,
    publishedAt: state.publishedAt,
    agents: state.agents,
    prompts: state.prompts,
  };
}

export async function GET(req: NextRequest) {
  if (!isAdminRequest(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return NextResponse.json(promptsPayload(await getAgentStrategy()));
}

export async function PUT(req: NextRequest) {
  if (!isAdminRequest(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const body = await req.json().catch(() => null);
  if (!body || !Array.isArray(body.prompts)) {
    return NextResponse.json({ error: "Prompt 数据格式不正确" }, { status: 400 });
  }
  const saved = await savePrompts({
    prompts: body.prompts as AgentPromptVersion[],
    agents: Array.isArray(body.agents) ? body.agents as AgentConfig[] : undefined,
  });
  return NextResponse.json(promptsPayload(saved));
}
