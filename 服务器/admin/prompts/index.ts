import "server-only";

import { defaultPrompt } from "@server/admin/agents/defaults";
import { getAgentStrategy, saveAgentStrategy } from "@server/admin/agents/store";
import type {
  AgentId,
  AgentPromptVersion,
  AgentStrategyState,
} from "@server/admin/agents/types";

export function getAgentPrompt(state: AgentStrategyState, agentId: AgentId, version?: string) {
  const agent = state.agents.find((item) => item.id === agentId);
  const targetVersion = version || agent?.promptVersion;
  return (
    state.prompts.find((prompt) => prompt.agentId === agentId && prompt.version === targetVersion)?.content ||
    defaultPrompt(agentId)
  );
}

export async function savePrompts(input: {
  prompts: AgentPromptVersion[];
  agents?: AgentStrategyState["agents"];
}) {
  const state = await getAgentStrategy();
  return saveAgentStrategy({
    ...state,
    agents: input.agents ?? state.agents,
    prompts: input.prompts,
  });
}
