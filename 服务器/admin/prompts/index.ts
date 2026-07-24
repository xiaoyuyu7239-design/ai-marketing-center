import "server-only";

import { MAX_AUDIT_RECORDS } from "@server/admin/agents/constants";
import { defaultPrompt } from "@server/admin/agents/defaults";
import { assertNoRawCredentials } from "@server/admin/agents/public";
import { mutateAgentStrategy } from "@server/admin/agents/store";
import type {
  AgentConfig,
  AgentId,
  AgentPromptVersion,
  AgentStrategyState,
} from "@server/admin/agents/types";
import { AgentConfigError } from "@server/admin/agents/types";
import { nowIso, uid } from "@server/admin/agents/utils";

export function getAgentPrompt(state: AgentStrategyState, agentId: AgentId, version?: string) {
  const agent = state.agents.find((item) => item.id === agentId);
  const targetVersion = version || agent?.promptVersion;
  if (!targetVersion) return defaultPrompt(agentId);
  const matches = state.prompts.filter(
    (prompt) => prompt.agentId === agentId && prompt.version === targetVersion,
  );
  if (matches.length !== 1 || !matches[0].content.trim()) {
    // 已配置 Agent 的 prompt 丢失/重复时必须 fail-closed；回退默认 prompt
    // 会让线上行为绕过 draft -> Golden Set -> publish 链路直接变更。
    throw new AgentConfigError(`${agentId} 的 prompt ${targetVersion} 缺失、重复或为空`);
  }
  return matches[0].content;
}

function validatePromptSet(state: AgentStrategyState, incoming: AgentPromptVersion[]) {
  const knownAgents = new Set(state.agents.map((agent) => agent.id));
  const identities = new Set<string>();
  const ids = new Set<string>();
  for (const prompt of incoming) {
    if (!prompt || !knownAgents.has(prompt.agentId)) throw new AgentConfigError("存在未知 Agent 的 prompt");
    if (!prompt.id?.trim() || !prompt.version?.trim() || !prompt.content?.trim()) {
      throw new AgentConfigError("prompt id、version 和 content 均不得为空");
    }
    const identity = `${prompt.agentId}\u0000${prompt.version}`;
    if (identities.has(identity)) throw new AgentConfigError(`${prompt.agentId} prompt 版本 ${prompt.version} 重复`);
    if (ids.has(prompt.id)) throw new AgentConfigError(`prompt id ${prompt.id} 重复`);
    identities.add(identity);
    ids.add(prompt.id);

    const existing = state.prompts.find(
      (item) => item.agentId === prompt.agentId && item.version === prompt.version,
    );
    if (existing && existing.content !== prompt.content) {
      // prompt 版本是 Golden 候选绑定的一部分，一旦创建就不允许原地改写。
      throw new AgentConfigError(`${prompt.agentId} 的 prompt ${prompt.version} 不可原地修改，请新建版本`);
    }
  }

  for (const agent of [...state.agents, ...state.draftAgents]) {
    const referencedVersion = agent.promptVersion;
    const count = incoming.filter(
      (prompt) => prompt.agentId === agent.id && prompt.version === referencedVersion,
    ).length;
    if (count !== 1) {
      throw new AgentConfigError(`${agent.name} 引用的 prompt ${referencedVersion} 不得删除或重复`);
    }
  }
}

export async function savePrompts(input: {
  prompts: AgentPromptVersion[];
  agents?: AgentConfig[];
}) {
  if (input.agents) assertNoRawCredentials(input.agents);
  return mutateAgentStrategy((state) => {
    validatePromptSet(state, input.prompts);
    // 线上 Agent 引用的 prompt 内容不允许原地改写；必须新建版本，
    // 先写入 draft Agent.promptVersion，再通过单 Agent publish 上线。
    for (const onlineAgent of state.agents) {
      const current = state.prompts.find(
        (prompt) => prompt.agentId === onlineAgent.id && prompt.version === onlineAgent.promptVersion,
      );
      const incoming = input.prompts.find(
        (prompt) => prompt.agentId === onlineAgent.id && prompt.version === onlineAgent.promptVersion,
      );
      if (!incoming) {
        throw new AgentConfigError(`${onlineAgent.name} 的线上 prompt 不得删除`);
      }
      if (current && incoming.content !== current.content) {
        throw new AgentConfigError(`${onlineAgent.name} 的线上 prompt 不可原地修改，请新建草稿版本`);
      }
    }

    const changedAgentIds: AgentId[] = [];
    const draftAgents = state.draftAgents.map((agent) => {
      const incomingAgent = input.agents?.find((item) => item.id === agent.id);
      if (!incomingAgent || incomingAgent.promptVersion === agent.promptVersion) return agent;
      const promptExists = input.prompts.some(
        (prompt) => prompt.agentId === agent.id && prompt.version === incomingAgent.promptVersion,
      );
      if (!promptExists) throw new AgentConfigError(`${agent.name} 引用的 prompt 版本不存在`);
      changedAgentIds.push(agent.id);
      return { ...agent, promptVersion: incomingAgent.promptVersion };
    });
    const promptsChanged = JSON.stringify(input.prompts) !== JSON.stringify(state.prompts);
    if (!promptsChanged && !changedAgentIds.length) return state;

    const stamp = nowIso();
    const revision = state.strategyRevision + 1;
    const changedSet = new Set(changedAgentIds);
    const auditAgentIds = changedAgentIds.length
      ? changedAgentIds
      : [...new Set(input.prompts.map((prompt) => prompt.agentId))];
    return {
      ...state,
      strategyRevision: revision,
      draftVersion: `strategy-draft-r${revision}`,
      draftAgents: draftAgents.map((agent) => changedSet.has(agent.id)
        ? { ...agent, strategyRevision: revision, updatedAt: stamp }
        : agent),
      prompts: input.prompts,
      audit: [
        ...auditAgentIds.map((agentId) => ({
          id: uid("audit"),
          createdAt: stamp,
          action: "draft_saved" as const,
          revision,
          agentId,
          summary: `已保存 ${agentId} prompt 草稿，线上版本未变更`,
        })),
        ...state.audit,
      ].slice(0, MAX_AUDIT_RECORDS),
    };
  });
}
