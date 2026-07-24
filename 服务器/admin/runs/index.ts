import "server-only";

import { MAX_RUNS } from "@server/admin/agents/constants";
import { mutateAgentStrategy, redactAgentLogText } from "@server/admin/agents/store";
import type { AgentRunRecord, AgentTokenUsage } from "@server/admin/agents/types";
import { nowIso, uid } from "@server/admin/agents/utils";

type AgentRunInput = Omit<
  AgentRunRecord,
  "id" | "createdAt" | "costEstimateUsd" | "costUsd" | "usage"
> & {
  usage?: AgentTokenUsage | null;
  costUsd?: number | null;
};

function validCost(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : null;
}

function validUsage(value: AgentTokenUsage | null | undefined): AgentTokenUsage | null {
  if (!value) return null;
  const token = (item: number | null) => typeof item === "number" && Number.isFinite(item)
    ? Math.max(0, Math.round(item))
    : null;
  return {
    inputTokens: token(value.inputTokens),
    outputTokens: token(value.outputTokens),
    totalTokens: token(value.totalTokens),
  };
}

export async function addRunRecord(input: AgentRunInput) {
  const costUsd = validCost(input.costUsd);
  const record: AgentRunRecord = {
    ...input,
    id: uid("run"),
    createdAt: nowIso(),
    ...(input.fallbackReason ? { fallbackReason: redactAgentLogText(input.fallbackReason) } : {}),
    ...(input.errorReason ? { errorReason: redactAgentLogText(input.errorReason) } : {}),
    usage: validUsage(input.usage),
    costUsd,
    // 兼容字段与真实成本保持一致；未知时两者都是 null。
    costEstimateUsd: costUsd,
  };

  await mutateAgentStrategy((state) => {
    const runs = [record, ...state.runs].slice(0, MAX_RUNS);
    const agentRuns = runs.filter((run) => run.agentId === input.agentId);
    const requestGroups = new Map<string, AgentRunRecord[]>();
    for (const run of agentRuns) {
      const group = requestGroups.get(run.requestId) ?? [];
      group.push(run);
      requestGroups.set(run.requestId, group);
    }
    const recentRequests = [...requestGroups.values()].slice(0, 30);
    const successRate = recentRequests.length
      ? recentRequests.filter((attempts) => attempts[0]?.success).length / recentRequests.length
      : 0;
    const avgLatencyMs = recentRequests.length
      ? Math.round(
          recentRequests.reduce(
            (sum, attempts) => sum + attempts.reduce((requestSum, attempt) => requestSum + attempt.latencyMs, 0),
            0,
          ) / recentRequests.length,
        )
      : 0;

    const applyMetrics = (agent: typeof state.agents[number]) =>
      agent.id === input.agentId
        ? { ...agent, successRate: Number(successRate.toFixed(2)), avgLatencyMs }
        : agent;
    return {
      ...state,
      runs,
      agents: state.agents.map(applyMetrics),
      draftAgents: state.draftAgents.map(applyMetrics),
    };
  });
  return record;
}
