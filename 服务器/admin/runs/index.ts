import "server-only";

import { MAX_RUNS } from "@server/admin/agents/constants";
import { getAgentStrategy, saveAgentStrategy } from "@server/admin/agents/store";
import type { AgentRunRecord } from "@server/admin/agents/types";
import { nowIso, uid } from "@server/admin/agents/utils";

function estimateCostUsd(latencyMs: number, success: boolean) {
  if (!success) return 0;
  return Number(Math.max(0.002, latencyMs / 180000).toFixed(4));
}

export async function addRunRecord(record: Omit<AgentRunRecord, "id" | "createdAt" | "costEstimateUsd"> & { costEstimateUsd?: number }) {
  const state = await getAgentStrategy();
  const runs = [
    {
      id: uid("run"),
      createdAt: nowIso(),
      costEstimateUsd: record.costEstimateUsd ?? estimateCostUsd(record.latencyMs, record.success),
      ...record,
    },
    ...state.runs,
  ].slice(0, MAX_RUNS);

  const agentRuns = runs.filter((run) => run.agentId === record.agentId);
  const lastRuns = agentRuns.slice(0, 30);
  const successRate =
    lastRuns.length === 0 ? 0 : lastRuns.filter((run) => run.success).length / lastRuns.length;
  const avgLatencyMs =
    lastRuns.length === 0
      ? 0
      : Math.round(lastRuns.reduce((sum, run) => sum + run.latencyMs, 0) / lastRuns.length);

  await saveAgentStrategy({
    ...state,
    runs,
    agents: state.agents.map((agent) =>
      agent.id === record.agentId
        ? { ...agent, successRate: Number(successRate.toFixed(2)), avgLatencyMs, updatedAt: nowIso() }
        : agent,
    ),
  });
}
