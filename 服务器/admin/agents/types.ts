export type AgentId =
  | "script"
  | "topic-script"
  | "product-analysis"
  | "publish-copy"
  | "publish-ranker"
  | "diagnose"
  | "metrics-ocr"
  | "retro"
  | "weekly-report"
  | "imageAgent"
  | "videoAgent"
  | "ttsAgent";

export type PromptStatus = "draft" | "eval" | "online";

/**
 * 管理端只能在这些语义化别名中选择凭据。别名由服务端映射到固定环境变量链，
 * 不允许浏览器传入任意环境变量名，更不允许传入密钥本身。
 */
export type ModelSecretRef =
  | "llm.primary"
  | "llm.fallback"
  | "image.primary"
  | "image.fallback"
  | "video.primary"
  | "video.fallback"
  | "tts.primary"
  | "tts.fallback";

/** 可持久化/可返回浏览器的端点配置，绝不包含凭据。 */
export interface ModelEndpointConfig {
  provider: string;
  model: string;
  baseUrl: string;
  secretRef: ModelSecretRef;
  /** 仅由服务端生成的公开 DTO 字段，入库时会被剔除。 */
  secretConfigured?: boolean;
  visionModel?: string;
  /** 供应商控制台中不可变的模型/部署修订号；不能填写 latest、展示名或可重指向别名。 */
  deploymentRevision?: string;
  /** 位于 HUIMAI_MODEL_REVISION_EVIDENCE_DIR 下的证据文件名。 */
  revisionEvidenceFile?: string;
  /** 上述证据文件的 SHA-256；预检会读取文件并逐字节核验。 */
  revisionEvidenceSha256?: string;
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
  /** 该配置槽最后一次变更对应的单调策略修订号。 */
  strategyRevision: number;
  /**
   * 只由服务端在 Golden 门禁通过的原子发布中写入。
   * draft 槽和浏览器输入不得传承/生成该字段。
   */
  promotionEvidence?: AgentPromotionEvidence;
  /**
   * 只为兼容现有后台 UI 的可选 DTO 字段。真实 previous 槽独立存在
   * AgentStrategyState.previousAgents 中，入库时不会保存这个嵌套字段。
   */
  previous?: Omit<AgentConfig, "previous">;
  updatedAt: string;
}

export interface AgentPromotionCandidateEvidence {
  candidateKey: string;
  evaluationFingerprint: string;
}

export interface AgentPromotionEvidence {
  schemaVersion: 1;
  agentId: AgentId;
  requestKind: AgentEvalRequestKind;
  primary: AgentPromotionCandidateEvidence;
  fallback: AgentPromotionCandidateEvidence;
  promptContentSha256: string;
  draftConfigSha256: string;
  goldenSetSha256: string;
  codeVersion: string;
  verifiedAt: string;
}

export type AgentEndpointRole = "primary" | "fallback";

export type AgentErrorCategory =
  | "network"
  | "timeout"
  | "rate_limit"
  | "provider_5xx"
  | "billing"
  | "empty_response"
  | "parse"
  | "safety"
  | "client_4xx"
  | "configuration"
  | "unknown";

export interface AgentTokenUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
}

export interface AgentRunRecord {
  id: string;
  requestId: string;
  attempt: number;
  endpointRole: AgentEndpointRole;
  createdAt: string;
  userLabel: string;
  agentId: AgentId;
  agentName: string;
  provider: string;
  model: string;
  strategyRevision: number;
  codeVersion: string;
  promptVersion: string;
  fallbackTriggered: boolean;
  fallbackReason?: string;
  errorCategory?: AgentErrorCategory;
  success: boolean;
  errorReason?: string;
  latencyMs: number;
  usage: AgentTokenUsage | null;
  /** 只接受供应商或计费层回传的真实成本；未知必须为 null。 */
  costUsd: number | null;
  /** @deprecated 仅保留给旧 UI/DTO 兼容，不再进行延时推算。 */
  costEstimateUsd: number | null;
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
  /** 旧记录可能没有以下 Golden Set 字段；新评测必须全部写入。 */
  evaluationKind?: "golden";
  status?: "completed" | "awaiting-human-review" | "failed";
  caseId?: string;
  candidateKey?: string;
  candidateRole?: AgentEndpointRole;
  requestKind?: AgentEvalRequestKind;
  structurePassed?: boolean | null;
  qualityScore?: number | null;
  /** 只接收供应商明确回传的 USD 成本；未知必须是 null。 */
  actualCostUsd?: number | null;
  artifactUrls?: string[];
  /**
   * 由服务端在原子落盘后生成的真实媒体元数据。人工评分和发布门禁
   * 都会重新校验 sha256，不接受浏览器提交的 URL/文件头冒充产物。
   */
  artifactMetadata?: AgentEvalArtifactMetadata[];
  /** 候选绑定的可追溯摘要；缺任一项的旧记录不得参与晋级。 */
  evaluationFingerprint?: string;
  promptContentSha256?: string;
  draftConfigSha256?: string;
  goldenSetSha256?: string;
  codeVersion?: string;
  criteria?: AgentEvalCriterionResult[];
  reviewIssues?: string[];
  humanScores?: Record<string, number>;
  score?: number;
}

export interface AgentEvalArtifactMetadata {
  filename: string;
  url: string;
  mediaType: "image" | "video" | "audio";
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  probe: {
    formatName: string;
    codecName: string;
    width?: number;
    height?: number;
    durationSeconds?: number;
  };
}

export type AgentEvalRequestKind =
  | "chat-json"
  | "vision-json"
  | "image-generation"
  | "video-generation"
  | "tts-generation";

export interface AgentEvalCriterionResult {
  criterionId: string;
  label: string;
  weight: number;
  passed?: boolean;
  detail?: string;
  score?: number | null;
  weightedScore?: number | null;
}

export interface GoldenEvalRubricDto {
  id: string;
  label: string;
  weight: number;
  evaluator: "automatic" | "human";
  guidance?: string;
  anchors?: { 1: string; 3: string; 5: string };
}

export interface GoldenEvalFixtureDto {
  fixtureId: string;
  state: "ready" | "disabled" | "missing" | "invalid";
  ready: boolean;
  reason: string;
}

export interface GoldenEvalCaseDto {
  id: string;
  agentId: AgentId;
  familyId: string;
  name: string;
  weight: number;
  requestKind: AgentEvalRequestKind;
  outputKind: "json" | "media";
  ready: boolean;
  readinessReason: string;
  fixtures: GoldenEvalFixtureDto[];
  rubric: GoldenEvalRubricDto[];
}

export interface GoldenEvalPromotionDto {
  agentId: AgentId;
  candidateKey: string;
  requestKind: AgentEvalRequestKind;
  sampleCount: number;
  distinctCaseCount: number;
  successRate: number;
  structurePassRate: number | null;
  qualityCoverageRate: number;
  qualityScore: number | null;
  p95LatencyMs: number;
  costCoverageRate: number;
  averageActualCostUsd: number | null;
  coveredCaseIds: string[];
  requiredCaseIds: string[];
  passed: boolean;
  failures: string[];
}

export interface GoldenEvalPayload {
  integrityPassed: boolean;
  integrityIssues: string[];
  cases: GoldenEvalCaseDto[];
  promotions: GoldenEvalPromotionDto[];
}

export type AgentStrategyAuditAction =
  | "legacy_scrubbed"
  | "draft_saved"
  | "published"
  | "rolled_back";

export interface AgentStrategyAuditRecord {
  id: string;
  createdAt: string;
  action: AgentStrategyAuditAction;
  revision: number;
  agentId?: AgentId;
  fromRevision?: number;
  summary: string;
}

export interface AgentStrategyState {
  /** 单调增长的全局修订号，用于审计和运行记录关联。 */
  strategyRevision: number;
  onlineVersion: string;
  draftVersion: string;
  publishedAt: string;
  /** 线上槽。普通运行链路只能读这个数组。 */
  agents: AgentConfig[];
  /** 仅管理端 DTO 使用的线上槽镜像；存储层会忽略它。 */
  onlineAgents?: AgentConfig[];
  /** 草稿槽。后台 PUT 只能修改这个数组。 */
  draftAgents: AgentConfig[];
  /** 每个 Agent 独立的上一个线上槽，发布/回滚不会波及其它 Agent。 */
  previousAgents: Partial<Record<AgentId, AgentConfig>>;
  prompts: AgentPromptVersion[];
  runs: AgentRunRecord[];
  evals: AgentEvalRecord[];
  audit: AgentStrategyAuditRecord[];
}

export class AgentConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentConfigError";
  }
}
