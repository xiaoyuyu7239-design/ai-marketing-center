import "server-only";

import type { LLMConfig } from "@backend/script-engine/generator";
import { getAgentPrompt } from "@server/admin/prompts";
import {
  candidateBindingFor,
  evaluationCodeVersion,
  goldenSetSha256,
  getPromotionDecisionForDraft,
  promotionEvidenceForDraft,
  verifyDraftPromotionArtifacts,
} from "@server/admin/evals/runner";
import { getCapabilityFamilyForAgent } from "@server/admin/evals/golden-set";
import {
  acquireGoldenEvaluationLease,
  GoldenEvaluationBusyError,
} from "@server/admin/evals/artifacts";
import { addRunRecord } from "@server/admin/runs";
import { MAX_AUDIT_RECORDS } from "./constants";
import {
  resolveModelSecret,
  sanitizeAgentConfig,
  sanitizePromotionEvidence,
  validateAgentFaultDomains,
  validateEndpointPolicy,
} from "./public";
import { getAgentStrategy, mutateAgentStrategy } from "./store";
import {
  AgentConfigError,
  type AgentConfig,
  type AgentEndpointRole,
  type AgentErrorCategory,
  type AgentId,
  type AgentTokenUsage,
  type ModelEndpointConfig,
} from "./types";
import { nowIso, uid } from "./utils";
import { withModelTelemetryReporter } from "@backend/shared/model-telemetry";
import { ProviderError } from "@backend/providers/base";
import { createProvider } from "@backend/providers";

export interface AgentRuntimeConfig extends LLMConfig {
  provider: string;
  voice?: string;
  speed?: number;
  groupId?: string;
}

export interface AgentOperationTelemetry {
  usage?: Partial<AgentTokenUsage>;
  /** 必须是供应商或计费系统返回的真实金额。 */
  costUsd?: number;
  /** 路由发生显式模式映射时，上报供应商实际收到的模型 ID。 */
  effectiveModel?: string;
}

export interface AgentOperationContext {
  requestId: string;
  attempt: number;
  endpointRole: AgentEndpointRole;
  reportTelemetry: (telemetry: AgentOperationTelemetry) => void;
}

export interface ClassifiedAgentError {
  category: AgentErrorCategory;
  fallbackAllowed: boolean;
  reason: string;
}

function errorRecord(error: unknown): Record<string, unknown> {
  return error && typeof error === "object" ? error as Record<string, unknown> : {};
}

function errorStatus(error: unknown): number | undefined {
  const raw = errorRecord(error);
  for (const candidate of [raw.status, raw.statusCode, errorRecord(raw.response).status, errorRecord(raw.cause).status]) {
    if (typeof candidate === "number" && Number.isInteger(candidate)) return candidate;
  }
  return undefined;
}

function errorCode(error: unknown) {
  const raw = errorRecord(error);
  return [raw.code, raw.type, errorRecord(raw.error).code, errorRecord(raw.cause).code]
    .filter((value): value is string => typeof value === "string")
    .join(" ");
}

function rawErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error ?? "未知错误");
}

function classifiedError(category: AgentErrorCategory, fallbackAllowed: boolean): ClassifiedAgentError {
  const reasons: Record<AgentErrorCategory, string> = {
    safety: "供应商内容安全策略拒绝",
    configuration: "模型配置无效或不完整",
    billing: "供应商余额或额度不足",
    rate_limit: "供应商请求限流",
    provider_5xx: "供应商服务暂时异常",
    timeout: "供应商请求超时",
    network: "供应商网络连接失败",
    parse: "供应商响应结构无法解析",
    empty_response: "供应商未返回有效内容",
    client_4xx: "供应商拒绝当前请求",
    unknown: "供应商请求结果未知",
  };
  return { category, fallbackAllowed, reason: reasons[category] };
}

export function classifyAgentError(error: unknown): ClassifiedAgentError {
  const status = errorStatus(error);
  const message = rawErrorMessage(error);
  const haystack = `${error instanceof Error ? error.name : ""} ${errorCode(error)} ${message}`;

  // 非幂等媒体提交在断网/超时/5xx 后可能已被供应商受理。此时既不能原地重试，
  // 也不能切备用供应商再创建一个付费任务；保留失败记录交由人工核账。
  if (/SUBMISSION_UNCERTAIN|提交结果未知/i.test(haystack)) {
    return { category: "unknown", fallbackAllowed: false, reason: "供应商提交结果未知，需要人工对账" };
  }

  // ProviderError 的分类由有界解析后的 code/status 得出，不再依赖易变的上游文案。
  if (error instanceof ProviderError) {
    switch (error.category) {
      case "safety":
        return classifiedError("safety", false);
      case "billing":
        return classifiedError("billing", true);
      case "auth":
      case "configuration":
        return classifiedError("configuration", false);
      case "rate_limit":
        return classifiedError("rate_limit", true);
      case "invalid_input":
        return classifiedError("client_4xx", false);
      case "provider_5xx":
        return classifiedError("provider_5xx", true);
      case "timeout":
        return classifiedError("timeout", true);
      case "network":
        return classifiedError("network", true);
      case "unknown":
        break;
    }
  }

  // 安全/内容策略拦截永远优先于状态码判定，不能通过换供应商规避。
  if (/content[_ -]?policy|safety|moderation|sensitive|risk[_ -]?control|安全校验|安全策略|内容审核|敏感内容|肖像保护|InputImageSensitiveContentDetected/i.test(haystack)) {
    return classifiedError("safety", false);
  }
  if (error instanceof AgentConfigError || /(?:未配置|配置不完整|secretRef|baseUrl 不是合法)/i.test(haystack)) {
    return classifiedError("configuration", false);
  }
  if (status === 402 || /insufficient[_ -]?(?:quota|balance|credit)|billing|余额不足|账户欠费|请充值|额度(?:不足|已用完)/i.test(haystack)) {
    return classifiedError("billing", true);
  }
  if (status === 429 || /rate[_ -]?limit|too many requests|限流|请求过于频繁/i.test(haystack)) {
    return classifiedError("rate_limit", true);
  }
  if (status !== undefined && status >= 500 && status <= 599) {
    return classifiedError("provider_5xx", true);
  }
  if (/AbortError|TimeoutError|APIConnectionTimeout|ETIMEDOUT|timed?\s*out|超时/i.test(haystack)) {
    return classifiedError("timeout", true);
  }
  if (/APIConnectionError|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|fetch failed|network error|socket hang up|网络错误|连接失败/i.test(haystack)) {
    return classifiedError("network", true);
  }
  if (error instanceof SyntaxError || /(?:invalid|malformed|unexpected).*json|json.*(?:parse|format|解析|无效|缺失)|未找到.*JSON|结构解析失败|无法解析|JSON 格式/i.test(haystack)) {
    return classifiedError("parse", true);
  }
  if (/empty response|empty content|no (?:content|output)|空响应|未返回内容|模型未返回/i.test(haystack)) {
    return classifiedError("empty_response", true);
  }
  if (status !== undefined && status >= 400 && status <= 499) {
    return classifiedError("client_4xx", false);
  }
  return classifiedError("unknown", false);
}

export function toLLMConfig(endpoint: ModelEndpointConfig): AgentRuntimeConfig {
  validateEndpointPolicy(endpoint, { requireRevision: process.env.NODE_ENV === "production" });
  return {
    provider: endpoint.provider,
    baseUrl: endpoint.baseUrl,
    apiKey: resolveModelSecret(endpoint.secretRef),
    model: endpoint.model,
    visionModel: endpoint.visionModel,
    voice: endpoint.voice,
    speed: endpoint.speed,
    groupId: endpoint.groupId,
  };
}

export function endpointReady(endpoint: ModelEndpointConfig) {
  try {
    validateEndpointPolicy(endpoint, { requireRevision: process.env.NODE_ENV === "production" });
    return Boolean(
      endpoint.provider?.trim() &&
      endpoint.baseUrl?.trim() &&
      endpoint.model?.trim() &&
      resolveModelSecret(endpoint.secretRef),
    );
  } catch {
    return false;
  }
}

export function getAgentOrThrow(state: Awaited<ReturnType<typeof getAgentStrategy>>, agentId: AgentId) {
  // state.agents 是序列化合约中的 online 槽；不得回退读 draftAgents。
  const agent = state.agents.find((item) => item.id === agentId);
  if (!agent) throw new AgentConfigError(`未找到 Agent 配置：${agentId}`);
  if (!agent.enabled) throw new AgentConfigError(`${agent.name} 已停用，请联系工作人员开启`);
  if (modelPromotionGateEnforced()) assertCurrentPublishedEvidence(state, agent);
  if (!endpointReady(agent.primary) && !endpointReady(agent.fallback)) {
    throw new AgentConfigError(`${agent.name} 线上槽尚未配置可用模型策略`);
  }
  return agent;
}

export interface AgentOperationReadiness {
  ready: boolean;
  /** 仅供服务端诊断；普通状态 API 目前只返回 ready 布尔值。 */
  reason: string;
  endpointRole?: AgentEndpointRole;
}

/**
 * 与 runAgentOperation 共用同一套 online/enabled/Golden/端点/凭据校验。
 * 只解析本地策略和 secretRef，不会发起任何供应商请求，因此不会计费。
 */
export function getAgentOperationReadiness(
  state: Awaited<ReturnType<typeof getAgentStrategy>>,
  agentId: AgentId,
): AgentOperationReadiness {
  try {
    const agent = getAgentOrThrow(state, agentId);
    // runAgentOperation 在任何 provider 调用前还会解析线上 Prompt；丢失/重复也必须反映为 not ready。
    getAgentPrompt(state, agentId);
    const endpointRole: AgentEndpointRole = endpointReady(agent.primary) ? "primary" : "fallback";
    // 运行时在真正进入 operation 前会做同样的转换/校验。
    const runtime = toLLMConfig(agent[endpointRole]);
    // 图片/视频路由的下一行就是 createProvider；在这里只构造实例以检查注册表，
    // 不调用 generate/list/status，因此不会产生网络请求或费用。
    if (agentId === "imageAgent" || agentId === "videoAgent") {
      createProvider({
        name: runtime.provider,
        apiKey: runtime.apiKey,
        baseUrl: runtime.baseUrl,
      });
    }
    return { ready: true, reason: "ready", endpointRole };
  } catch (error) {
    return {
      ready: false,
      reason: error instanceof AgentConfigError ? error.message : "Agent 运行配置暂不可用",
    };
  }
}

function comparableAgent(agent: AgentConfig) {
  return JSON.stringify({
    name: agent.name,
    description: agent.description,
    primary: agent.primary,
    fallback: agent.fallback,
    promptVersion: agent.promptVersion,
    enabled: agent.enabled,
  });
}

function withAudit<T extends { audit: Awaited<ReturnType<typeof getAgentStrategy>>["audit"] }>(
  state: T,
  records: T["audit"],
) {
  return { ...state, audit: [...records, ...state.audit].slice(0, MAX_AUDIT_RECORDS) };
}

/** 后台 PUT 的唯一写入面：只改草稿槽，线上/previous 槽保持不变。 */
export async function saveAgents(incoming: AgentConfig[]) {
  return mutateAgentStrategy((state) => {
    const replacements = new Map<AgentId, AgentConfig>();
    for (const value of incoming) {
      const id = value?.id;
      const currentDraft = state.draftAgents.find((agent) => agent.id === id);
      if (!currentDraft) throw new AgentConfigError(`未知 Agent：${String(id || "(空)")}`);
      const sanitized = sanitizeAgentConfig(value, currentDraft, {
        rejectCredentials: true,
        validateEndpoints: true,
      });
      const online = state.agents.find((agent) => agent.id === id);
      // 运行指标由服务端记录计算，不接受浏览器篡改。
      sanitized.successRate = online?.successRate ?? currentDraft.successRate;
      sanitized.avgLatencyMs = online?.avgLatencyMs ?? currentDraft.avgLatencyMs;
      replacements.set(id, sanitized);
    }

    const changedIds = [...replacements.entries()]
      .filter(([id, next]) => comparableAgent(next) !== comparableAgent(state.draftAgents.find((agent) => agent.id === id)!))
      .map(([id]) => id);
    if (!changedIds.length) return state;

    const stamp = nowIso();
    const revision = state.strategyRevision + 1;
    const draftAgents = state.draftAgents.map((agent) => {
      const replacement = replacements.get(agent.id);
      if (!replacement || !changedIds.includes(agent.id)) return agent;
      return { ...replacement, strategyRevision: revision, updatedAt: stamp };
    });
    return withAudit(
      {
        ...state,
        strategyRevision: revision,
        draftVersion: `strategy-draft-r${revision}`,
        draftAgents,
      },
      changedIds.map((agentId) => ({
        id: uid("audit"),
        createdAt: stamp,
        action: "draft_saved" as const,
        revision,
        agentId,
        fromRevision: state.draftAgents.find((agent) => agent.id === agentId)?.strategyRevision,
        summary: `已保存 ${agentId} 草稿，线上槽未变更`,
      })),
    );
  });
}

function codeVersion() {
  return (
    process.env.HUIMAI_CODE_VERSION ||
    process.env.VERCEL_GIT_COMMIT_SHA ||
    process.env.npm_package_version ||
    "unknown"
  ).slice(0, 200);
}

function telemetryUsage(telemetry: AgentOperationTelemetry): AgentTokenUsage | null {
  if (!telemetry.usage) return null;
  const token = (value: unknown) => typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.round(value))
    : null;
  return {
    inputTokens: token(telemetry.usage.inputTokens),
    outputTokens: token(telemetry.usage.outputTokens),
    totalTokens: token(telemetry.usage.totalTokens),
  };
}

function telemetryCost(telemetry: AgentOperationTelemetry) {
  return typeof telemetry.costUsd === "number" && Number.isFinite(telemetry.costUsd)
    ? Math.max(0, telemetry.costUsd)
    : null;
}

function mergeTelemetry(
  current: AgentOperationTelemetry,
  next: AgentOperationTelemetry,
): AgentOperationTelemetry {
  const sum = (left: unknown, right: unknown) => {
    const hasLeft = typeof left === "number" && Number.isFinite(left);
    const hasRight = typeof right === "number" && Number.isFinite(right);
    if (!hasLeft && !hasRight) return undefined;
    return (hasLeft ? left as number : 0) + (hasRight ? right as number : 0);
  };
  const hasUsage = Boolean(current.usage || next.usage);
  const hasCost = current.costUsd !== undefined || next.costUsd !== undefined;
  const effectiveModel = typeof next.effectiveModel === "string" && next.effectiveModel.trim()
    ? next.effectiveModel.trim().slice(0, 300)
    : current.effectiveModel;
  return {
    ...(hasUsage ? {
      usage: {
        inputTokens: sum(current.usage?.inputTokens, next.usage?.inputTokens),
        outputTokens: sum(current.usage?.outputTokens, next.usage?.outputTokens),
        totalTokens: sum(current.usage?.totalTokens, next.usage?.totalTokens),
      },
    } : {}),
    ...(hasCost ? { costUsd: sum(current.costUsd, next.costUsd) } : {}),
    ...(effectiveModel ? { effectiveModel } : {}),
  };
}

function emptyResult(result: unknown) {
  return result == null || (typeof result === "string" && !result.trim());
}

interface AttemptSuccess<T> {
  ok: true;
  value: T;
}

interface AttemptFailure {
  ok: false;
  error: unknown;
  classified: ClassifiedAgentError;
}

export async function runAgentOperation<T>(
  agentId: AgentId,
  userLabel: string,
  operation: (
    config: AgentRuntimeConfig,
    prompt: string,
    usedFallback: boolean,
    context: AgentOperationContext,
  ) => Promise<T>,
) {
  const state = await getAgentStrategy();
  const agent = getAgentOrThrow(state, agentId);
  const prompt = getAgentPrompt(state, agentId);
  const requestId = uid("request");
  const version = codeVersion();

  const executeAttempt = async (
    endpoint: ModelEndpointConfig,
    endpointRole: AgentEndpointRole,
    attempt: number,
    fallbackReason?: string,
  ): Promise<AttemptSuccess<T> | AttemptFailure> => {
    const started = Date.now();
    let telemetry: AgentOperationTelemetry = {};
    let value: T;
    try {
      const reportTelemetry = (next: AgentOperationTelemetry) => {
        telemetry = mergeTelemetry(telemetry, next);
      };
      value = await withModelTelemetryReporter(
        (providerTelemetry) => reportTelemetry({
          ...(providerTelemetry.inputTokens !== undefined
            || providerTelemetry.outputTokens !== undefined
            || providerTelemetry.totalTokens !== undefined ? { usage: {
            inputTokens: providerTelemetry.inputTokens,
            outputTokens: providerTelemetry.outputTokens,
            totalTokens: providerTelemetry.totalTokens,
          } } : {}),
          ...(providerTelemetry.costUsd !== undefined ? { costUsd: providerTelemetry.costUsd } : {}),
          ...(providerTelemetry.effectiveModel ? { effectiveModel: providerTelemetry.effectiveModel } : {}),
        }),
        () => operation(
          toLLMConfig(endpoint),
          prompt,
          endpointRole === "fallback",
          {
            requestId,
            attempt,
            endpointRole,
            reportTelemetry,
          },
        ),
      );
      if (emptyResult(value)) throw new Error("模型未返回内容");
    } catch (error) {
      const classified = classifyAgentError(error);
      const fallbackWillRun = endpointRole === "primary" && classified.fallbackAllowed && endpointReady(agent.fallback);
      await addRunRecord({
        requestId,
        attempt,
        endpointRole,
        userLabel,
        agentId,
        agentName: agent.name,
        provider: endpoint.provider,
        model: telemetry.effectiveModel || endpoint.model,
        strategyRevision: agent.strategyRevision,
        codeVersion: version,
        promptVersion: agent.promptVersion,
        fallbackTriggered: fallbackWillRun || endpointRole === "fallback",
        ...(fallbackReason ? { fallbackReason } : {}),
        errorCategory: classified.category,
        success: false,
        errorReason: classified.reason,
        latencyMs: Date.now() - started,
        usage: telemetryUsage(telemetry),
        costUsd: telemetryCost(telemetry),
      });
      return { ok: false, error, classified };
    }

    await addRunRecord({
      requestId,
      attempt,
      endpointRole,
      userLabel,
      agentId,
      agentName: agent.name,
      provider: endpoint.provider,
      model: telemetry.effectiveModel || endpoint.model,
      strategyRevision: agent.strategyRevision,
      codeVersion: version,
      promptVersion: agent.promptVersion,
      fallbackTriggered: endpointRole === "fallback",
      ...(fallbackReason ? { fallbackReason } : {}),
      success: true,
      latencyMs: Date.now() - started,
      usage: telemetryUsage(telemetry),
      costUsd: telemetryCost(telemetry),
    });
    return { ok: true, value };
  };

  // 主槽本身不就绪不是一次供应商失败；若备槽就绪，直接将它作为唯一可用端点执行。
  if (!endpointReady(agent.primary)) {
    const only = await executeAttempt(agent.fallback, "fallback", 1, "primary_not_ready");
    if (only.ok) return only.value;
    throw only.error;
  }

  const primary = await executeAttempt(agent.primary, "primary", 1);
  if (primary.ok) return primary.value;
  if (!primary.classified.fallbackAllowed || !endpointReady(agent.fallback)) throw primary.error;

  const fallbackReason = `${primary.classified.category}: ${primary.classified.reason}`;
  const fallback = await executeAttempt(agent.fallback, "fallback", 2, fallbackReason);
  if (fallback.ok) return fallback.value;
  throw fallback.error;
}

function modelPromotionGateEnforced() {
  return process.env.NODE_ENV === "production"
    || process.env.HUIMAI_ENFORCE_MODEL_PROMOTION_GATE === "1";
}

function assertCurrentPublishedEvidence(
  state: Awaited<ReturnType<typeof getAgentStrategy>>,
  agent: AgentConfig,
) {
  if (!agent.enabled) return;
  validateEndpointPolicy(agent.primary, { production: true, requireRevision: true });
  validateEndpointPolicy(agent.fallback, { production: true, requireRevision: true });
  validateAgentFaultDomains(agent.primary, agent.fallback);
  const evidence = sanitizePromotionEvidence(agent.promotionEvidence);
  if (!evidence) throw new AgentConfigError(`${agent.name} 没有有效的 Golden 发布证据`);
  const expectedKind = getCapabilityFamilyForAgent(agent.id).requestKind;
  if (evidence.agentId !== agent.id || evidence.requestKind !== expectedKind) {
    throw new AgentConfigError(`${agent.name} 的 Golden 发布证据与 Agent 能力不匹配`);
  }
  if (evidence.codeVersion !== evaluationCodeVersion()) {
    throw new AgentConfigError(`${agent.name} 的 Golden 发布证据不属于当前代码版本`);
  }
  if (evidence.goldenSetSha256 !== goldenSetSha256()) {
    throw new AgentConfigError(`${agent.name} 的 Golden Set 已变更，必须重新评测发布`);
  }
  let primary;
  let fallback;
  try {
    primary = candidateBindingFor(state, agent, "primary", expectedKind);
    fallback = candidateBindingFor(state, agent, "fallback", expectedKind);
  } catch (error) {
    throw new AgentConfigError(
      `${agent.name} 无法复核当前线上配置：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (
    evidence.promptContentSha256 !== primary.promptContentSha256
    || evidence.draftConfigSha256 !== primary.draftConfigSha256
    || evidence.goldenSetSha256 !== primary.goldenSetSha256
    || evidence.codeVersion !== primary.codeVersion
    || evidence.primary.candidateKey !== primary.candidateKey
    || evidence.primary.evaluationFingerprint !== primary.evaluationFingerprint
    || evidence.fallback.candidateKey !== fallback.candidateKey
    || evidence.fallback.evaluationFingerprint !== fallback.evaluationFingerprint
  ) {
    throw new AgentConfigError(`${agent.name} 的 Golden 发布证据与当前线上模型、Prompt 或配置不一致`);
  }
}

export async function publishAgent(agentId: AgentId) {
  const promotionEnforced = modelPromotionGateEnforced();
  let releaseEvidenceLease: (() => Promise<void>) | null = null;
  if (promotionEnforced) {
    try {
      releaseEvidenceLease = await acquireGoldenEvaluationLease();
    } catch (error) {
      if (error instanceof GoldenEvaluationBusyError) {
        throw new AgentConfigError("媒体 Golden 评测/评分正在变更，请稍后重新发布");
      }
      throw error;
    }
  }
  let verifiedRevision: number | null = null;
  try {
    if (promotionEnforced) {
      const preflightState = await getAgentStrategy();
      const preflightDraft = preflightState.draftAgents.find((agent) => agent.id === agentId);
      if (!preflightDraft) throw new AgentConfigError(`未找到 Agent 配置：${agentId}`);
      if (preflightDraft.enabled) {
        validateEndpointPolicy(preflightDraft.primary, { production: true, requireRevision: true });
        validateEndpointPolicy(preflightDraft.fallback, { production: true, requireRevision: true });
        validateAgentFaultDomains(preflightDraft.primary, preflightDraft.fallback);
        const promotion = getPromotionDecisionForDraft(preflightState, agentId, { production: true });
        if (!promotion.passed) {
          throw new AgentConfigError(
            `${agentId} 尚未通过当前草稿主备模型的 Golden Set：${promotion.failures.join("；")}`,
          );
        }
        await verifyDraftPromotionArtifacts(preflightState, agentId).catch((error) => {
          throw new AgentConfigError(
            `${agentId} 媒体 Golden 产物发布前复核失败：${error instanceof Error ? error.message : String(error)}`,
          );
        });
      }
      verifiedRevision = preflightState.strategyRevision;
    }
    return await mutateAgentStrategy((state) => {
      const draft = state.draftAgents.find((agent) => agent.id === agentId);
      const online = state.agents.find((agent) => agent.id === agentId);
      if (!draft || !online) throw new AgentConfigError(`未找到 Agent 配置：${agentId}`);
      validateEndpointPolicy(draft.primary, {
        production: promotionEnforced && draft.enabled,
        requireRevision: promotionEnforced && draft.enabled,
      });
      validateEndpointPolicy(draft.fallback, {
        production: promotionEnforced && draft.enabled,
        requireRevision: promotionEnforced && draft.enabled,
      });
      if (promotionEnforced && draft.enabled) validateAgentFaultDomains(draft.primary, draft.fallback);
      if (draft.enabled && !endpointReady(draft.primary) && !endpointReady(draft.fallback)) {
        throw new AgentConfigError(`${draft.name} 草稿没有可用凭据的模型端点，不能发布`);
      }
      if (promotionEnforced && state.strategyRevision !== verifiedRevision) {
        throw new AgentConfigError("媒体产物复核后 draft/评测状态已变更，请重新发布");
      }
      const promotion = draft.enabled
        ? getPromotionDecisionForDraft(state, agentId, { production: promotionEnforced })
        : null;
      if (promotion?.enforced && !promotion.passed) {
        throw new AgentConfigError(
          `${draft.name} 尚未通过当前草稿主备模型的 Golden Set：${promotion.failures.join("；")}`,
        );
      }

      const stamp = nowIso();
      const revision = state.strategyRevision + 1;
      const published = sanitizeAgentConfig(draft, online, {
        strategyRevision: revision,
        validateEndpoints: true,
      });
      published.successRate = online.successRate;
      published.avgLatencyMs = online.avgLatencyMs;
      published.updatedAt = stamp;
      if (promotionEnforced && draft.enabled) {
        published.promotionEvidence = promotionEvidenceForDraft(state, agentId, stamp);
      } else {
        delete published.promotionEvidence;
      }
      const publishedDraft = { ...published };
      delete publishedDraft.promotionEvidence;
      const previousAgents = { ...state.previousAgents, [agentId]: online };
      const next = {
        ...state,
        strategyRevision: revision,
        onlineVersion: `strategy-r${revision}`,
        draftVersion: `strategy-draft-r${revision}`,
        publishedAt: stamp,
        agents: state.agents.map((agent) => agent.id === agentId ? published : agent),
        draftAgents: state.draftAgents.map((agent) => agent.id === agentId ? publishedDraft : agent),
        previousAgents,
      };
      return withAudit(next, [{
        id: uid("audit"),
        createdAt: stamp,
        action: "published",
        revision,
        agentId,
        fromRevision: online.strategyRevision,
        summary: `已将 ${agentId} 草稿原子发布到线上，其它 Agent 未变更`,
      }]);
    });
  } finally {
    await releaseEvidenceLease?.();
  }
}

export async function rollbackAgent(agentId: AgentId) {
  const promotionEnforced = modelPromotionGateEnforced();
  return mutateAgentStrategy((state) => {
    const previous = state.previousAgents[agentId];
    const online = state.agents.find((agent) => agent.id === agentId);
    if (!online) throw new AgentConfigError(`未找到 Agent 配置：${agentId}`);
    if (!previous) throw new AgentConfigError(`${online.name} 没有可回滚的上一个线上版本`);
    if (promotionEnforced) assertCurrentPublishedEvidence(state, previous);
    validateEndpointPolicy(previous.primary, {
      production: promotionEnforced && previous.enabled,
      requireRevision: promotionEnforced && previous.enabled,
    });
    validateEndpointPolicy(previous.fallback, {
      production: promotionEnforced && previous.enabled,
      requireRevision: promotionEnforced && previous.enabled,
    });
    if (promotionEnforced && previous.enabled) validateAgentFaultDomains(previous.primary, previous.fallback);

    const stamp = nowIso();
    const revision = state.strategyRevision + 1;
    const restored = sanitizeAgentConfig(previous, online, {
      strategyRevision: revision,
      validateEndpoints: true,
      promotionEvidenceSource: "value",
    });
    restored.successRate = online.successRate;
    restored.avgLatencyMs = online.avgLatencyMs;
    restored.updatedAt = stamp;
    const next = {
      ...state,
      strategyRevision: revision,
      onlineVersion: `strategy-r${revision}`,
      publishedAt: stamp,
      agents: state.agents.map((agent) => agent.id === agentId ? restored : agent),
      // 当前线上槽成为新 previous，使回滚本身也可可靠撤销。草稿槽保持独立。
      previousAgents: { ...state.previousAgents, [agentId]: online },
    };
    return withAudit(next, [{
      id: uid("audit"),
      createdAt: stamp,
      action: "rolled_back",
      revision,
      agentId,
      fromRevision: online.strategyRevision,
      summary: `已恢复 ${agentId} 的上一个线上槽，其它 Agent 未变更`,
    }]);
  });
}
