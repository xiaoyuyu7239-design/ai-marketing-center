import "server-only";

import { MAX_EVALS } from "@server/admin/agents/constants";
import { getAgentStrategy, saveAgentStrategy } from "@server/admin/agents/store";
import type { AgentEvalRecord } from "@server/admin/agents/types";
import { nowIso, uid } from "@server/admin/agents/utils";

export function createEvalRecord(input: Omit<AgentEvalRecord, "id" | "createdAt">): AgentEvalRecord {
  return { id: uid("eval"), createdAt: nowIso(), ...input };
}

export async function addEvalRecord(record: AgentEvalRecord) {
  const state = await getAgentStrategy();
  return saveAgentStrategy({ ...state, evals: [record, ...state.evals].slice(0, MAX_EVALS) });
}

export async function saveEvalRecords(evals: AgentEvalRecord[]) {
  const state = await getAgentStrategy();
  return saveAgentStrategy({ ...state, evals: evals.slice(0, MAX_EVALS) });
}
