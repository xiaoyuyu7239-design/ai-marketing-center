import "server-only";

import { eq } from "drizzle-orm";
import { getDb } from "@backend/db";
import { settings } from "@backend/db/schema";
import { STRATEGY_KEY } from "./constants";
import { defaultState } from "./defaults";
import type {
  AgentConfig,
  AgentEvalRecord,
  AgentPromptVersion,
  AgentRunRecord,
  AgentStrategyState,
} from "./types";

function asState(value: unknown): AgentStrategyState {
  const base = defaultState();
  if (!value || typeof value !== "object") return base;
  const raw = value as Partial<AgentStrategyState>;
  const rawAgents = Array.isArray(raw.agents) && raw.agents.length ? raw.agents as AgentConfig[] : [];
  const rawPrompts = Array.isArray(raw.prompts) && raw.prompts.length ? raw.prompts as AgentPromptVersion[] : [];
  const agents = rawAgents.length
    ? [
        ...rawAgents,
        ...base.agents.filter((agent) => !rawAgents.some((item) => item.id === agent.id)),
      ]
    : base.agents;
  const prompts = rawPrompts.length
    ? [
        ...rawPrompts,
        ...base.prompts.filter((prompt) => !rawPrompts.some((item) => item.agentId === prompt.agentId && item.version === prompt.version)),
      ]
    : base.prompts;
  return {
    onlineVersion: raw.onlineVersion || base.onlineVersion,
    draftVersion: raw.draftVersion || base.draftVersion,
    publishedAt: raw.publishedAt || base.publishedAt,
    agents,
    prompts,
    runs: Array.isArray(raw.runs) ? raw.runs as AgentRunRecord[] : base.runs,
    evals: Array.isArray(raw.evals) ? raw.evals as AgentEvalRecord[] : base.evals,
  };
}

async function readRawState() {
  const db = getDb();
  const rows = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, STRATEGY_KEY));
  return rows[0]?.value;
}

export async function getAgentStrategy(): Promise<AgentStrategyState> {
  return asState(await readRawState());
}

export async function saveAgentStrategy(nextState: AgentStrategyState) {
  const db = getDb();
  await db
    .insert(settings)
    .values({ key: STRATEGY_KEY, value: nextState, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value: nextState, updatedAt: new Date() },
    });
  return nextState;
}
