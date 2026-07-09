export type AgentId =
  | "script"
  | "topic-script"
  | "product-analysis"
  | "publish-copy"
  | "publish-ranker"
  | "imageAgent"
  | "videoAgent"
  | "ttsAgent";

export type PromptStatus = "draft" | "eval" | "online";

export interface ModelEndpointConfig {
  provider: string;
  model: string;
  baseUrl: string;
  apiKey: string;
  visionModel?: string;
  voice?: string;
  speed?: number;
  groupId?: string;
}

export interface AgentPromptVersion {
  id: string;
  agentId: AgentId;
  version: string;
  content: string;
  status: PromptStatus;
  updatedAt: string;
}

export interface AgentConfig {
  id: AgentId;
  name: string;
  description: string;
  primary: ModelEndpointConfig;
  fallback: ModelEndpointConfig;
  promptVersion: string;
  enabled: boolean;
  successRate: number;
  avgLatencyMs: number;
  previous?: Omit<AgentConfig, "previous">;
  updatedAt: string;
}

export interface AgentRunRecord {
  id: string;
  createdAt: string;
  userLabel: string;
  agentId: AgentId;
  agentName: string;
  provider: string;
  model: string;
  promptVersion: string;
  fallbackTriggered: boolean;
  success: boolean;
  errorReason?: string;
  latencyMs: number;
  costEstimateUsd: number;
}

export interface AgentEvalRecord {
  id: string;
  createdAt: string;
  agentId: AgentId;
  candidateModel: string;
  provider: string;
  promptVersion: string;
  testCase: string;
  output: string;
  latencyMs: number;
  errored: boolean;
  jsonParsed: boolean;
  score?: number;
}

export interface AgentStrategyState {
  onlineVersion: string;
  draftVersion: string;
  publishedAt: string;
  agents: AgentConfig[];
  prompts: AgentPromptVersion[];
  runs: AgentRunRecord[];
  evals: AgentEvalRecord[];
}

export class AgentConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentConfigError";
  }
}
