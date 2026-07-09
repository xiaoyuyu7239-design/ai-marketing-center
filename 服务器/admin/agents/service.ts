import "server-only";

import type { LLMConfig } from "@backend/script-engine/generator";
import { getAgentPrompt } from "@server/admin/prompts";
import { addRunRecord } from "@server/admin/runs";
import { getAgentStrategy, saveAgentStrategy } from "./store";
import {
  AgentConfigError,
  type AgentId,
  type ModelEndpointConfig,
} from "./types";
import { nowIso } from "./utils";

export interface AgentRuntimeConfig extends LLMConfig {
  provider: string;
  voice?: string;
  speed?: number;
  groupId?: string;
}

export function toLLMConfig(endpoint: ModelEndpointConfig): AgentRuntimeConfig {
  return {
    provider: endpoint.provider,
    baseUrl: endpoint.baseUrl,
    apiKey: endpoint.apiKey,
    model: endpoint.model,
    visionModel: endpoint.visionModel,
    voice: endpoint.voice,
    speed: endpoint.speed,
    groupId: endpoint.groupId,
  };
}

export function endpointReady(endpoint: ModelEndpointConfig) {
  return Boolean(endpoint.baseUrl?.trim() && endpoint.model?.trim());
}

export function getAgentOrThrow(state: Awaited<ReturnType<typeof getAgentStrategy>>, agentId: AgentId) {
  const agent = state.agents.find((item) => item.id === agentId);
  if (!agent) throw new AgentConfigError(`未找到 Agent 配置：${agentId}`);
  if (!agent.enabled) throw new AgentConfigError(`${agent.name} 已停用，请联系工作人员开启`);
  if (!endpointReady(agent.primary) && !endpointReady(agent.fallback)) {
    throw new AgentConfigError(`${agent.name} 尚未配置可用模型策略`);
  }
  return agent;
}

export async function saveAgents(agents: Awaited<ReturnType<typeof getAgentStrategy>>["agents"]) {
  const state = await getAgentStrategy();
  return saveAgentStrategy({ ...state, agents });
}

export async function runAgentOperation<T>(
  agentId: AgentId,
  userLabel: string,
  operation: (config: AgentRuntimeConfig, prompt: string, usedFallback: boolean) => Promise<T>,
) {
  const state = await getAgentStrategy();
  const agent = getAgentOrThrow(state, agentId);
  const prompt = getAgentPrompt(state, agentId);
  const started = Date.now();
  let usedFallback = false;
  let endpoint = agent.primary;

  try {
    if (!endpointReady(endpoint)) throw new AgentConfigError(`${agent.name} 主模型未配置完整`);
    const result = await operation(toLLMConfig(endpoint), prompt, false);
    await addRunRecord({
      userLabel,
      agentId,
      agentName: agent.name,
      provider: endpoint.provider,
      model: endpoint.model,
      promptVersion: agent.promptVersion,
      fallbackTriggered: false,
      success: true,
      latencyMs: Date.now() - started,
    });
    return result;
  } catch (primaryError) {
    if (!endpointReady(agent.fallback)) {
      const reason = primaryError instanceof Error ? primaryError.message : String(primaryError);
      await addRunRecord({
        userLabel,
        agentId,
        agentName: agent.name,
        provider: endpoint.provider,
        model: endpoint.model,
        promptVersion: agent.promptVersion,
        fallbackTriggered: false,
        success: false,
        errorReason: reason,
        latencyMs: Date.now() - started,
      });
      throw primaryError;
    }

    usedFallback = true;
    endpoint = agent.fallback;
    try {
      const result = await operation(toLLMConfig(endpoint), prompt, true);
      await addRunRecord({
        userLabel,
        agentId,
        agentName: agent.name,
        provider: endpoint.provider,
        model: endpoint.model,
        promptVersion: agent.promptVersion,
        fallbackTriggered: usedFallback,
        success: true,
        latencyMs: Date.now() - started,
      });
      return result;
    } catch (fallbackError) {
      const reason = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
      await addRunRecord({
        userLabel,
        agentId,
        agentName: agent.name,
        provider: endpoint.provider,
        model: endpoint.model,
        promptVersion: agent.promptVersion,
        fallbackTriggered: usedFallback,
        success: false,
        errorReason: reason,
        latencyMs: Date.now() - started,
      });
      throw fallbackError;
    }
  }
}

export async function publishAgent(agentId: AgentId) {
  const state = await getAgentStrategy();
  const stamp = nowIso();
  const agents = state.agents.map((agent) =>
    agent.id === agentId
      ? { ...agent, previous: { ...agent, previous: undefined }, updatedAt: stamp }
      : agent,
  );
  const nextState = {
    ...state,
    onlineVersion: `strategy-v${Date.now()}`,
    publishedAt: stamp,
    agents,
  };
  return saveAgentStrategy(nextState);
}

export async function rollbackAgent(agentId: AgentId) {
  const state = await getAgentStrategy();
  const agents = state.agents.map((agent) => {
    if (agent.id !== agentId || !agent.previous) return agent;
    return { ...agent.previous, previous: undefined, updatedAt: nowIso() };
  });
  return saveAgentStrategy({ ...state, agents });
}
