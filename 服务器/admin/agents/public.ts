import "server-only";

import {
  AgentConfigError,
  type AgentConfig,
  type AgentEndpointRole,
  type AgentId,
  type AgentPromotionEvidence,
  type ModelEndpointConfig,
  type ModelSecretRef,
} from "./types";

export const MODEL_SECRET_REFS: readonly ModelSecretRef[] = [
  "llm.primary",
  "llm.fallback",
  "image.primary",
  "image.fallback",
  "video.primary",
  "video.fallback",
  "tts.primary",
  "tts.fallback",
] as const;

/**
 * 只有这个固定映射能读取凭据。存储层/浏览器只会看到左侧别名，
 * 无法利用 secretRef 读取任意环境变量。
 */
const SECRET_ENV_CHAINS: Readonly<Record<ModelSecretRef, readonly string[]>> = {
  "llm.primary": ["CLIPFORGE_LLM_API_KEY"],
  "llm.fallback": ["CLIPFORGE_LLM_FALLBACK_API_KEY", "CLIPFORGE_LLM_API_KEY"],
  "image.primary": ["CLIPFORGE_IMAGE_API_KEY", "CLIPFORGE_AI_API_KEY", "ATLAS_API_KEY"],
  "image.fallback": ["CLIPFORGE_IMAGE_FALLBACK_API_KEY", "CLIPFORGE_IMAGE_API_KEY", "CLIPFORGE_AI_API_KEY", "ATLAS_API_KEY"],
  "video.primary": ["CLIPFORGE_VIDEO_API_KEY", "CLIPFORGE_AI_API_KEY", "ATLAS_API_KEY"],
  "video.fallback": ["CLIPFORGE_VIDEO_FALLBACK_API_KEY", "CLIPFORGE_VIDEO_API_KEY", "CLIPFORGE_AI_API_KEY", "ATLAS_API_KEY"],
  "tts.primary": ["CLIPFORGE_TTS_API_KEY", "VOLCENGINE_TTS_API_KEY", "ATLAS_API_KEY"],
  "tts.fallback": ["CLIPFORGE_TTS_FALLBACK_API_KEY", "CLIPFORGE_TTS_API_KEY", "VOLCENGINE_TTS_API_KEY", "ATLAS_API_KEY"],
};

const PRODUCTION_SECRET_ENV: Readonly<Record<ModelSecretRef, string>> = {
  "llm.primary": "CLIPFORGE_LLM_API_KEY",
  "llm.fallback": "CLIPFORGE_LLM_FALLBACK_API_KEY",
  "image.primary": "CLIPFORGE_IMAGE_API_KEY",
  "image.fallback": "CLIPFORGE_IMAGE_FALLBACK_API_KEY",
  "video.primary": "CLIPFORGE_VIDEO_API_KEY",
  "video.fallback": "CLIPFORGE_VIDEO_FALLBACK_API_KEY",
  "tts.primary": "CLIPFORGE_TTS_API_KEY",
  "tts.fallback": "CLIPFORGE_TTS_FALLBACK_API_KEY",
};

const BUILTIN_MODEL_ENDPOINT_HOSTS = new Set([
  "api.atlascloud.ai",
  "api.openai.com",
  "api.siliconflow.cn",
  "api.deepseek.com",
  "openrouter.ai",
  "ark.cn-beijing.volces.com",
  "openspeech.bytedance.com",
  "dashscope.aliyuncs.com",
  "api.fal.ai",
  "api.replicate.com",
]);
const BUILTIN_MODEL_FAULT_DOMAINS = new Map([
  ["api.atlascloud.ai", "atlascloud"],
  ["api.openai.com", "openai"],
  ["api.siliconflow.cn", "siliconflow"],
  ["api.deepseek.com", "deepseek"],
  ["openrouter.ai", "openrouter"],
  ["ark.cn-beijing.volces.com", "volcengine"],
  ["openspeech.bytedance.com", "volcengine"],
  ["dashscope.aliyuncs.com", "alibaba-cloud"],
  ["api.fal.ai", "fal-ai"],
  ["api.replicate.com", "replicate"],
]);

const FORBIDDEN_CREDENTIAL_KEY = /^(?:api[_-]?key|access[_-]?token|auth(?:orization)?|credential|password|private[_-]?key|token)$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const REVISION_EVIDENCE_FILE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/;
const CANDIDATE_KEY = /^(primary|fallback):[^\u0000-\u001f\u007f]{1,1800}@([0-9a-f]{64})$/;
const EVALUATION_REQUEST_KINDS = new Set([
  "chat-json",
  "vision-json",
  "image-generation",
  "video-generation",
  "tts-generation",
]);
const AGENT_IDS = new Set<AgentId>([
  "script",
  "topic-script",
  "product-analysis",
  "publish-copy",
  "publish-ranker",
  "diagnose",
  "metrics-ocr",
  "retro",
  "weekly-report",
  "imageAgent",
  "videoAgent",
  "ttsAgent",
]);

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function cleanString(value: unknown, fallback: string, maxLength = 500) {
  if (typeof value !== "string") return fallback;
  return value.trim().slice(0, maxLength);
}

function optionalString(value: unknown, fallback?: string, maxLength = 500) {
  if (value === undefined) return fallback;
  if (typeof value !== "string") return fallback;
  const normalized = value.trim().slice(0, maxLength);
  return normalized || undefined;
}

function finiteNumber(value: unknown, fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback;
}

export function isModelSecretRef(value: unknown): value is ModelSecretRef {
  return typeof value === "string" && (MODEL_SECRET_REFS as readonly string[]).includes(value);
}

export function isFloatingModelIdentifier(value: unknown) {
  const normalized = String(value || "").trim().toLowerCase();
  return !normalized
    || /(?:^|[/_-])(?:latest|preview|experimental|default|auto)$/.test(normalized)
    || /^(?:gpt-4o|gpt-4o-mini|qwen-plus|qwen-max|qwen-turbo|deepseek-chat|deepseek-reasoner)$/.test(normalized)
    || /seedream-(?:4|5)(?:\.0)?(?:-lite|-pro)?$/.test(normalized)
    || /seedance-(?:1\.5|2\.0)(?:-lite|-pro)?$/.test(normalized);
}

function requiresRuntimeModelRewrite(endpoint: ModelEndpointConfig) {
  const model = endpoint.model;
  return (endpoint.provider === "atlas-cloud" && model === "openai/gpt-image-2/text-to-image")
    || (endpoint.provider === "fal-ai" && model === "openai/gpt-image-2")
    || model === "fal-ai/gpt-image-1.5"
    || (model.startsWith("black-forest-labs/flux") && !model.includes("kontext"))
    || model.endsWith("/text-to-image")
    || model.includes("/text-to-video")
    || model.includes("/image-to-video");
}

export function validateEndpointRevisionPolicy(endpoint: ModelEndpointConfig) {
  const revision = endpoint.deploymentRevision?.trim() || "";
  if (revision.length < 3 || revision.length > 300 || /[\u0000-\u001f\u007f]/.test(revision)
    || /(?:^|[/_-])(?:latest|preview|experimental|default|auto)$/.test(revision.toLowerCase())) {
    throw new AgentConfigError("生产模型必须填写供应商可核验的不可变 deploymentRevision");
  }
  if (isFloatingModelIdentifier(endpoint.model) || (endpoint.visionModel && isFloatingModelIdentifier(endpoint.visionModel))) {
    throw new AgentConfigError("生产模型不能使用 latest、展示名或已知浮动别名，请改用固定模型/接入点 ID");
  }
  if (endpoint.visionModel && endpoint.visionModel !== endpoint.model) {
    throw new AgentConfigError("单个生产端点只能绑定一个有效模型 revision；视觉 Agent 请把固定视觉模型直接填入 model");
  }
  if (requiresRuntimeModelRewrite(endpoint)) {
    throw new AgentConfigError("生产模型 ID 会被运行路由按模式改写，无法与单一 revision 证据一致；请使用无需改写的固定接入点 ID");
  }
  if (!REVISION_EVIDENCE_FILE.test(endpoint.revisionEvidenceFile || "")) {
    throw new AgentConfigError("生产模型必须填写安全的 revisionEvidenceFile 文件名");
  }
  if (!SHA256.test(endpoint.revisionEvidenceSha256 || "")) {
    throw new AgentConfigError("生产模型必须填写 revisionEvidenceFile 的 SHA-256");
  }
}

export function defaultSecretRef(agentId: AgentId, role: AgentEndpointRole): ModelSecretRef {
  if (agentId === "imageAgent") return role === "primary" ? "image.primary" : "image.fallback";
  if (agentId === "videoAgent") return role === "primary" ? "video.primary" : "video.fallback";
  if (agentId === "ttsAgent") return role === "primary" ? "tts.primary" : "tts.fallback";
  return role === "primary" ? "llm.primary" : "llm.fallback";
}

export function resolveModelSecret(secretRef: ModelSecretRef): string {
  const chain = process.env.NODE_ENV === "production"
    ? [PRODUCTION_SECRET_ENV[secretRef]]
    : SECRET_ENV_CHAINS[secretRef];
  for (const envName of chain) {
    const value = process.env[envName]?.trim();
    if (value) return value;
  }
  return "";
}

function configuredFaultDomains() {
  const result = new Map(BUILTIN_MODEL_FAULT_DOMAINS);
  for (const item of (process.env.HUIMAI_MODEL_ENDPOINT_FAULT_DOMAINS || "").split(",")) {
    const [rawHost, rawDomain, ...rest] = item.split("=");
    const host = rawHost?.trim().toLowerCase();
    const domain = rawDomain?.trim().toLowerCase();
    if (rest.length || !host || !domain) continue;
    if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host)) continue;
    if (!/^[a-z0-9][a-z0-9._-]{1,99}$/.test(domain)) continue;
    result.set(host, domain);
  }
  return result;
}

export function modelEndpointFaultDomain(endpoint: ModelEndpointConfig): string | undefined {
  try {
    return configuredFaultDomains().get(new URL(endpoint.baseUrl).hostname.toLowerCase());
  } catch {
    return undefined;
  }
}

export function validateAgentFaultDomains(primary: ModelEndpointConfig, fallback: ModelEndpointConfig) {
  const primaryDomain = modelEndpointFaultDomain(primary);
  const fallbackDomain = modelEndpointFaultDomain(fallback);
  if (!primaryDomain || !fallbackDomain) {
    throw new AgentConfigError(
      "主备模型必须有受控故障域归属；自定义主机请配置 HUIMAI_MODEL_ENDPOINT_FAULT_DOMAINS=host=fault-domain",
    );
  }
  if (primaryDomain === fallbackDomain) {
    throw new AgentConfigError(`主备模型位于同一供应商故障域 ${primaryDomain}`);
  }
}

export function modelSecretConfigured(secretRef: ModelSecretRef) {
  return Boolean(resolveModelSecret(secretRef));
}

/** 浏览器请求中出现任何原始凭据字段都直接拒绝（即使值为空）。 */
export function assertNoRawCredentials(value: unknown, path = "agents") {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoRawCredentials(item, `${path}[${index}]`));
    return;
  }
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_CREDENTIAL_KEY.test(key)) {
      throw new AgentConfigError(`${path}.${key} 不允许通过浏览器提交，请使用受控 secretRef`);
    }
    assertNoRawCredentials(nested, `${path}.${key}`);
  }
}

function configuredEndpointHosts() {
  const extra = (process.env.HUIMAI_MODEL_ENDPOINT_HOSTS || "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  return new Set([...BUILTIN_MODEL_ENDPOINT_HOSTS, ...extra]);
}

function hostnameAllowed(hostname: string) {
  const normalized = hostname.toLowerCase();
  for (const entry of configuredEndpointHosts()) {
    if (entry.startsWith("*.")) {
      const suffix = entry.slice(1);
      if (normalized.endsWith(suffix) && normalized !== suffix.slice(1)) return true;
    } else if (normalized === entry) {
      return true;
    }
  }
  return false;
}

export function validateEndpointPolicy(
  endpoint: ModelEndpointConfig,
  options: { production?: boolean; requireRevision?: boolean } = {},
) {
  if (!isModelSecretRef(endpoint.secretRef)) {
    throw new AgentConfigError(`未授权的模型凭据引用：${String(endpoint.secretRef || "(空)")}`);
  }
  if (!endpoint.baseUrl) return;

  let parsed: URL;
  try {
    parsed = new URL(endpoint.baseUrl);
  } catch {
    throw new AgentConfigError(`模型 baseUrl 不是合法 URL：${endpoint.baseUrl}`);
  }
  if (parsed.username || parsed.password) {
    throw new AgentConfigError("模型 baseUrl 不能携带用户名或密码");
  }
  if (parsed.hash) {
    throw new AgentConfigError("模型 baseUrl 不能携带 URL fragment");
  }

  const production = options.production ?? process.env.NODE_ENV === "production";
  const localDevHost = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "::1";
  if (production && parsed.protocol !== "https:") {
    throw new AgentConfigError("生产环境模型 baseUrl 必须使用 HTTPS");
  }
  if (!production && parsed.protocol !== "https:" && !(parsed.protocol === "http:" && localDevHost)) {
    throw new AgentConfigError("模型 baseUrl 必须使用 HTTPS（本地开发 localhost 除外）");
  }
  if (production && !hostnameAllowed(parsed.hostname)) {
    throw new AgentConfigError(
      `模型端点主机未在白名单：${parsed.hostname}；请配置 HUIMAI_MODEL_ENDPOINT_HOSTS`,
    );
  }
  if (options.requireRevision) validateEndpointRevisionPolicy(endpoint);
}

export function sanitizeEndpoint(
  value: unknown,
  fallback: ModelEndpointConfig,
  agentId: AgentId,
  role: AgentEndpointRole,
  options: { validate?: boolean } = {},
): ModelEndpointConfig {
  const raw = objectValue(value);
  if (options.validate !== false && "secretRef" in raw && !isModelSecretRef(raw.secretRef)) {
    throw new AgentConfigError(`未授权的模型凭据引用：${String(raw.secretRef || "(空)")}`);
  }
  const expectedSecretRef = defaultSecretRef(agentId, role);
  if (options.validate !== false && "secretRef" in raw && raw.secretRef !== expectedSecretRef) {
    throw new AgentConfigError(`${agentId} ${role} 必须使用专属凭据引用 ${expectedSecretRef}`);
  }
  const secretRef = expectedSecretRef;
  const speed = raw.speed === undefined
    ? fallback.speed
    : finiteNumber(raw.speed, fallback.speed ?? 1, 0.25, 4);
  const endpoint: ModelEndpointConfig = {
    provider: cleanString(raw.provider, fallback.provider, 100),
    model: cleanString(raw.model, fallback.model, 300),
    baseUrl: cleanString(raw.baseUrl, fallback.baseUrl, 1_000).replace(/\/+$/, ""),
    secretRef,
    visionModel: optionalString(raw.visionModel, fallback.visionModel, 300),
    deploymentRevision: optionalString(raw.deploymentRevision, fallback.deploymentRevision, 300),
    revisionEvidenceFile: optionalString(raw.revisionEvidenceFile, fallback.revisionEvidenceFile, 200),
    revisionEvidenceSha256: optionalString(raw.revisionEvidenceSha256, fallback.revisionEvidenceSha256, 64)?.toLowerCase(),
    voice: optionalString(raw.voice, fallback.voice, 300),
    ...(speed !== undefined ? { speed } : {}),
    groupId: optionalString(raw.groupId, fallback.groupId, 300),
  };
  if (options.validate !== false) validateEndpointPolicy(endpoint);
  return endpoint;
}

/**
 * 明确列出可入库字段：旧 JSON 中的 apiKey/apiKeyConfigured 和任何未知字段都不会被 spread 回新状态。
 */
export function sanitizeAgentConfig(
  value: unknown,
  fallback: AgentConfig,
  options: {
    rejectCredentials?: boolean;
    strategyRevision?: number;
    validateEndpoints?: boolean;
    promotionEvidenceSource?: "value" | "omit";
  } = {},
): AgentConfig {
  if (options.rejectCredentials) assertNoRawCredentials(value);
  const raw = objectValue(value);
  const id = fallback.id;
  const promotionEvidence = options.promotionEvidenceSource === "value"
    ? sanitizePromotionEvidence(raw.promotionEvidence)
    : undefined;
  return {
    id,
    name: cleanString(raw.name, fallback.name, 100),
    description: cleanString(raw.description, fallback.description, 1_000),
    primary: sanitizeEndpoint(raw.primary, fallback.primary, id, "primary", { validate: options.validateEndpoints }),
    fallback: sanitizeEndpoint(raw.fallback, fallback.fallback, id, "fallback", { validate: options.validateEndpoints }),
    promptVersion: cleanString(raw.promptVersion, fallback.promptVersion, 200),
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : fallback.enabled,
    successRate: finiteNumber(raw.successRate, fallback.successRate, 0, 1),
    avgLatencyMs: Math.round(finiteNumber(raw.avgLatencyMs, fallback.avgLatencyMs, 0, 86_400_000)),
    strategyRevision: Math.round(finiteNumber(
      options.strategyRevision ?? raw.strategyRevision,
      fallback.strategyRevision,
      1,
    )),
    ...(promotionEvidence ? { promotionEvidence } : {}),
    updatedAt: cleanString(raw.updatedAt, fallback.updatedAt, 100),
  };
}

function exactKeys(raw: Record<string, unknown>, keys: readonly string[]) {
  const actual = Object.keys(raw).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

/** 严格重建服务端发布证据；旧版、缺字段、多字段或篡改对象一律丢弃。 */
export function sanitizePromotionEvidence(value: unknown): AgentPromotionEvidence | undefined {
  const raw = objectValue(value);
  if (!exactKeys(raw, [
    "schemaVersion",
    "agentId",
    "requestKind",
    "primary",
    "fallback",
    "promptContentSha256",
    "draftConfigSha256",
    "goldenSetSha256",
    "codeVersion",
    "verifiedAt",
  ])) return undefined;
  if (raw.schemaVersion !== 1
    || typeof raw.agentId !== "string"
    || !AGENT_IDS.has(raw.agentId as AgentId)
    || typeof raw.requestKind !== "string"
    || !EVALUATION_REQUEST_KINDS.has(raw.requestKind)
    || !SHA256.test(String(raw.promptContentSha256 || ""))
    || !SHA256.test(String(raw.draftConfigSha256 || ""))
    || !SHA256.test(String(raw.goldenSetSha256 || ""))
    || typeof raw.codeVersion !== "string"
    || !raw.codeVersion.trim()
    || raw.codeVersion.length > 200
    || /[\u0000-\u001f\u007f]/.test(raw.codeVersion)) return undefined;

  const verifiedAt = typeof raw.verifiedAt === "string" ? raw.verifiedAt : "";
  const parsedAt = Date.parse(verifiedAt);
  if (!Number.isFinite(parsedAt) || new Date(parsedAt).toISOString() !== verifiedAt) return undefined;
  const candidate = (value: unknown, role: "primary" | "fallback") => {
    const item = objectValue(value);
    if (!exactKeys(item, ["candidateKey", "evaluationFingerprint"])
      || typeof item.candidateKey !== "string"
      || typeof item.evaluationFingerprint !== "string"
      || !SHA256.test(item.evaluationFingerprint)) return undefined;
    const match = CANDIDATE_KEY.exec(item.candidateKey);
    if (!match || match[1] !== role || match[2] !== item.evaluationFingerprint) return undefined;
    return { candidateKey: item.candidateKey, evaluationFingerprint: item.evaluationFingerprint };
  };
  const primary = candidate(raw.primary, "primary");
  const fallback = candidate(raw.fallback, "fallback");
  if (!primary || !fallback) return undefined;
  return {
    schemaVersion: 1,
    agentId: raw.agentId as AgentId,
    requestKind: raw.requestKind as AgentPromotionEvidence["requestKind"],
    primary,
    fallback,
    promptContentSha256: raw.promptContentSha256 as string,
    draftConfigSha256: raw.draftConfigSha256 as string,
    goldenSetSha256: raw.goldenSetSha256 as string,
    codeVersion: raw.codeVersion,
    verifiedAt,
  };
}

function publicEndpoint(endpoint: ModelEndpointConfig): ModelEndpointConfig {
  return {
    provider: endpoint.provider,
    model: endpoint.model,
    baseUrl: endpoint.baseUrl,
    secretRef: endpoint.secretRef,
    secretConfigured: modelSecretConfigured(endpoint.secretRef),
    ...(endpoint.visionModel ? { visionModel: endpoint.visionModel } : {}),
    ...(endpoint.deploymentRevision ? { deploymentRevision: endpoint.deploymentRevision } : {}),
    ...(endpoint.revisionEvidenceFile ? { revisionEvidenceFile: endpoint.revisionEvidenceFile } : {}),
    ...(endpoint.revisionEvidenceSha256 ? { revisionEvidenceSha256: endpoint.revisionEvidenceSha256 } : {}),
    ...(endpoint.voice ? { voice: endpoint.voice } : {}),
    ...(endpoint.speed !== undefined ? { speed: endpoint.speed } : {}),
    ...(endpoint.groupId ? { groupId: endpoint.groupId } : {}),
  };
}

export function publicAgent(agent: AgentConfig): AgentConfig {
  const promotionEvidence = sanitizePromotionEvidence(agent.promotionEvidence);
  const result: AgentConfig = {
    id: agent.id,
    name: agent.name,
    description: agent.description,
    primary: publicEndpoint(agent.primary),
    fallback: publicEndpoint(agent.fallback),
    promptVersion: agent.promptVersion,
    enabled: agent.enabled,
    successRate: agent.successRate,
    avgLatencyMs: agent.avgLatencyMs,
    strategyRevision: agent.strategyRevision,
    ...(promotionEvidence ? { promotionEvidence } : {}),
    updatedAt: agent.updatedAt,
  };
  if (agent.previous) {
    result.previous = publicAgent(agent.previous) as Omit<AgentConfig, "previous">;
  }
  return result;
}

export function publicAgents(agents: AgentConfig[]): AgentConfig[] {
  return agents.map(publicAgent);
}

/**
 * @deprecated 保留函数名以兼容现有路由；它现在的行为是拒绝原始凭据并清洗公开配置。
 */
export function mergeAgentSecrets(current: AgentConfig[], incoming: AgentConfig[]): AgentConfig[] {
  assertNoRawCredentials(incoming);
  return incoming.map((value) => {
    const id = objectValue(value).id;
    const fallback = current.find((item) => item.id === id);
    if (!fallback) throw new AgentConfigError(`未知 Agent：${String(id || "(空)")}`);
    return sanitizeAgentConfig(value, fallback, { rejectCredentials: true });
  });
}
