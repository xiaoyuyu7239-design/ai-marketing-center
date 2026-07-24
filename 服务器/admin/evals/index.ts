import "server-only";

import { MAX_EVALS } from "@server/admin/agents/constants";
import { mutateAgentStrategy } from "@server/admin/agents/store";
import type { AgentEvalRecord } from "@server/admin/agents/types";
import { nowIso, uid } from "@server/admin/agents/utils";

export * from "./golden-set";
export * from "./scoring";
export * from "./runner";

export function createEvalRecord(input: Omit<AgentEvalRecord, "id" | "createdAt">): AgentEvalRecord {
  return { id: uid("eval"), createdAt: nowIso(), ...input };
}

export async function addEvalRecord(record: AgentEvalRecord) {
  return mutateAgentStrategy((state) => ({
    ...state,
    evals: [record, ...state.evals].slice(0, MAX_EVALS),
  }));
}

export async function addEvalRecords(records: AgentEvalRecord[]) {
  return mutateAgentStrategy((state) => ({
    ...state,
    evals: [...records, ...state.evals].slice(0, MAX_EVALS),
  }));
}

export async function updateEvalRecord(
  recordId: string,
  update: (record: AgentEvalRecord) => AgentEvalRecord,
) {
  return mutateAgentStrategy((state) => {
    const index = state.evals.findIndex((record) => record.id === recordId);
    if (index < 0) throw new Error("评测记录不存在");
    return {
      ...state,
      evals: state.evals.map((record, recordIndex) => recordIndex === index ? update(record) : record),
    };
  });
}

export async function deleteEvalRecord(recordId: string) {
  return mutateAgentStrategy((state) => {
    if (!state.evals.some((record) => record.id === recordId)) throw new Error("评测记录不存在");
    return { ...state, evals: state.evals.filter((record) => record.id !== recordId) };
  });
}

export async function saveEvalRecords(evals: AgentEvalRecord[]) {
  return mutateAgentStrategy((state) => ({ ...state, evals: evals.slice(0, MAX_EVALS) }));
}
