import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import { isAdminRequest } from "@server/admin/admin-auth";
import {
  endpointReady,
  getAgentStrategy,
  toLLMConfig,
  type ModelEndpointConfig,
  type AgentId,
} from "@server/admin/agents";
import {
  addEvalRecord,
  createEvalRecord,
  saveEvalRecords,
} from "@server/admin/evals";
import { getAgentPrompt } from "@server/admin/prompts";
import { extractJSON } from "@backend/script-engine/generator";

function candidateEndpoint(kind: string, primary: ModelEndpointConfig, fallback: ModelEndpointConfig) {
  return kind === "fallback" ? fallback : primary;
}

function evalsPayload(state: Awaited<ReturnType<typeof getAgentStrategy>>) {
  return {
    agents: state.agents,
    prompts: state.prompts,
    evals: state.evals,
  };
}

export async function GET(req: NextRequest) {
  if (!isAdminRequest(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return NextResponse.json(evalsPayload(await getAgentStrategy()));
}

export async function POST(req: NextRequest) {
  if (!isAdminRequest(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const agentId = body.agentId as AgentId;
  const candidates = Array.isArray(body.candidates) ? body.candidates as string[] : ["primary"];
  const testCase = typeof body.testCase === "string" && body.testCase.trim()
    ? body.testCase.trim()
    : "请输出一个 15 秒短视频脚本 JSON。";

  const state = await getAgentStrategy();
  const agent = state.agents.find((item) => item.id === agentId);
  if (!agent) {
    return NextResponse.json({ error: "未找到 Agent 配置" }, { status: 404 });
  }
  if (!agent.enabled) {
    return NextResponse.json({ error: `${agent.name} 已停用，无法评测` }, { status: 400 });
  }

  const selectedPromptVersion =
    typeof body.promptVersion === "string" && body.promptVersion.trim()
      ? body.promptVersion.trim()
      : agent.promptVersion;
  const prompt = getAgentPrompt(state, agentId, selectedPromptVersion);
  const results = [];

  for (const candidate of candidates) {
    const endpoint = candidateEndpoint(candidate, agent.primary, agent.fallback);
    const started = Date.now();
    let output = "";
    let errored = false;
    let jsonParsed = false;

    try {
      if (!endpointReady(endpoint)) {
        throw new Error("候选模型配置不完整");
      }
      const config = toLLMConfig(endpoint);
      const client = new OpenAI({ baseURL: config.baseUrl, apiKey: config.apiKey || "no-key" });
      const response = await client.chat.completions.create({
        model: config.model,
        messages: [
          { role: "system", content: prompt },
          { role: "user", content: testCase },
        ],
        temperature: 0.5,
        max_tokens: 1600,
      });
      output = response.choices[0]?.message?.content || "";
      try {
        JSON.parse(extractJSON(output));
        jsonParsed = true;
      } catch {
        jsonParsed = false;
      }
    } catch (error) {
      errored = true;
      output = error instanceof Error ? error.message : String(error);
    }

    const record = createEvalRecord({
      agentId,
      candidateModel: endpoint.model || candidate,
      provider: endpoint.provider || "unknown",
      promptVersion: selectedPromptVersion,
      testCase,
      output,
      latencyMs: Date.now() - started,
      errored,
      jsonParsed,
    });
    await addEvalRecord(record);
    results.push(record);
  }

  return NextResponse.json({ results });
}

export async function PATCH(req: NextRequest) {
  if (!isAdminRequest(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const body = await req.json().catch(() => null);
  if (!body || !Array.isArray(body.evals)) {
    return NextResponse.json({ error: "评测数据格式不正确" }, { status: 400 });
  }
  return NextResponse.json(evalsPayload(await saveEvalRecords(body.evals)));
}
