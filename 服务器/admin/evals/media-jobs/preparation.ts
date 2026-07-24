import "server-only";

import { hashGenerationRequest } from "@backend/core/auth/usage";
import {
  endpointReady,
  toLLMConfig,
  type AgentRuntimeConfig,
} from "@server/admin/agents/service";
import { getAgentStrategy } from "@server/admin/agents/store";
import type {
  AgentEndpointRole,
  AgentId,
  AgentStrategyState,
  ModelEndpointConfig,
} from "@server/admin/agents/types";
import { getAgentPrompt } from "@server/admin/prompts";
import {
  getCapabilityFamilyForAgent,
  getGoldenCase,
  type MediaGoldenCase,
} from "../golden-set";
import {
  getGoldenCaseFixtureReadiness,
  resolveGoldenAttachmentDataUrl,
} from "../fixtures";
import {
  assertGoldenMediaCandidateReady,
  candidateBindingFor,
  type GoldenCandidateBinding,
} from "../runner";
import {
  assertDurableGoldenMediaMode,
  assertResumableGoldenMediaMode,
  type GoldenMediaProviderConnection,
  type GoldenMediaProviderRequest,
  type ResumableGoldenMediaRequestKind,
} from "./provider-adapter";
import {
  normalizeGoldenMediaIdempotencyKey,
  type EnqueueGoldenMediaEvalJobInput,
  type GoldenMediaEvalJobRecord,
} from "./repository";

interface GoldenMediaJobPayloadV1 {
  version: 1;
  endpoint: ModelEndpointConfig;
  binding: GoldenCandidateBinding;
  caseVersion: number;
  caseFingerprint: string;
  promptHash: string;
  constraints: GoldenMediaJobConstraints;
}

export interface GoldenMediaJobConstraints {
  caseName: string;
  mediaType: "image" | "video" | "audio";
  minimumArtifacts: number;
  expectedArtifactCount: number;
  aspectRatio: "9:16" | null;
  durationSeconds: number | null;
  durationRangeSeconds: [number, number] | null;
}

export interface GoldenTtsOneShotRequest {
  text: string;
  provider: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  voice: string;
  speed: number;
  groupId?: string;
}

export interface PrepareGoldenMediaEvalJobsInput {
  operationKey: string;
  agentId: AgentId;
  caseId: string;
  candidateRoles: readonly AgentEndpointRole[];
  promptVersion?: string;
  state?: AgentStrategyState;
}

function exactString(data: Record<string, unknown>, key: string) {
  const value = data[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`Golden case 缺少 ${key}`);
  return value;
}

function exactNumber(data: Record<string, unknown>, key: string) {
  const value = data[key];
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`Golden case 缺少 ${key}`);
  return value;
}

function caseFingerprint(goldenCase: MediaGoldenCase) {
  return hashGenerationRequest({
    id: goldenCase.id,
    version: goldenCase.version,
    agentId: goldenCase.agentId,
    familyId: goldenCase.familyId,
    input: goldenCase.input,
    requiredShape: goldenCase.requiredShape,
  });
}

function caseConstraints(goldenCase: MediaGoldenCase): GoldenMediaJobConstraints {
  const data = goldenCase.input.data as Record<string, unknown>;
  const mediaType = goldenCase.requiredShape.mediaType;
  if (mediaType === "audio") {
    const range = data.expectedDurationSeconds;
    if (
      !Array.isArray(range)
      || range.length !== 2
      || typeof range[0] !== "number"
      || typeof range[1] !== "number"
      || !Number.isFinite(range[0])
      || !Number.isFinite(range[1])
      || range[0] <= 0
      || range[1] < range[0]
    ) throw new Error("TTS Golden case 缺少合法的冻结时长范围");
    return {
      caseName: goldenCase.name,
      mediaType,
      minimumArtifacts: goldenCase.requiredShape.minimumArtifacts,
      expectedArtifactCount: 1,
      aspectRatio: null,
      durationSeconds: null,
      durationRangeSeconds: [range[0], range[1]],
    };
  }
  if (mediaType !== "image" && mediaType !== "video") throw new Error("持久媒体 job 产物类型不受支持");
  if (data.aspectRatio !== "9:16") throw new Error("Golden 媒体 case 必须锁定 9:16 产物");
  const expectedArtifactCount = mediaType === "image" ? exactNumber(data, "count") : 1;
  if (!Number.isInteger(expectedArtifactCount) || expectedArtifactCount < goldenCase.requiredShape.minimumArtifacts) {
    throw new Error("Golden 媒体 case 产物数量约束不合法");
  }
  return {
    caseName: goldenCase.name,
    mediaType,
    minimumArtifacts: goldenCase.requiredShape.minimumArtifacts,
    expectedArtifactCount,
    aspectRatio: "9:16",
    durationSeconds: mediaType === "video" ? exactNumber(data, "durationSeconds") : null,
    durationRangeSeconds: null,
  };
}

function endpointSnapshot(endpoint: ModelEndpointConfig): ModelEndpointConfig {
  return {
    provider: endpoint.provider,
    model: endpoint.model,
    baseUrl: endpoint.baseUrl,
    secretRef: endpoint.secretRef,
    ...(endpoint.visionModel ? { visionModel: endpoint.visionModel } : {}),
    ...(endpoint.voice ? { voice: endpoint.voice } : {}),
    ...(endpoint.speed !== undefined ? { speed: endpoint.speed } : {}),
    ...(endpoint.groupId ? { groupId: endpoint.groupId } : {}),
  };
}

function parseEndpoint(value: unknown): ModelEndpointConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("评测任务候选快照缺失");
  const raw = value as Record<string, unknown>;
  if (
    typeof raw.provider !== "string"
    || typeof raw.model !== "string"
    || typeof raw.baseUrl !== "string"
    || typeof raw.secretRef !== "string"
  ) throw new Error("评测任务候选快照不完整");
  return raw as unknown as ModelEndpointConfig;
}

function parseConstraints(value: unknown): GoldenMediaJobConstraints {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("媒体 Golden 任务缺少产物约束快照");
  }
  const raw = value as Record<string, unknown>;
  const durationRange = raw.durationRangeSeconds;
  const validDurationRange = durationRange === null
    || (Array.isArray(durationRange)
      && durationRange.length === 2
      && durationRange.every((item) => typeof item === "number" && Number.isFinite(item))
      && durationRange[0] > 0
      && durationRange[1] >= durationRange[0]);
  if (
    typeof raw.caseName !== "string"
    || !raw.caseName.trim()
    || (raw.mediaType !== "image" && raw.mediaType !== "video" && raw.mediaType !== "audio")
    || typeof raw.minimumArtifacts !== "number"
    || !Number.isInteger(raw.minimumArtifacts)
    || raw.minimumArtifacts < 1
    || typeof raw.expectedArtifactCount !== "number"
    || !Number.isInteger(raw.expectedArtifactCount)
    || raw.expectedArtifactCount < raw.minimumArtifacts
    || (raw.aspectRatio !== "9:16" && raw.aspectRatio !== null)
    || (raw.durationSeconds !== null
      && (typeof raw.durationSeconds !== "number" || !Number.isFinite(raw.durationSeconds) || raw.durationSeconds <= 0))
    || !validDurationRange
    || (raw.mediaType === "audio" && (raw.aspectRatio !== null || !Array.isArray(durationRange)))
    || (raw.mediaType !== "audio" && (raw.aspectRatio !== "9:16" || durationRange !== null))
  ) throw new Error("媒体 Golden 任务产物约束快照不完整");
  return raw as unknown as GoldenMediaJobConstraints;
}

function parsePayload(job: GoldenMediaEvalJobRecord): GoldenMediaJobPayloadV1 {
  const raw = job.payload;
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || raw.version !== 1) {
    throw new Error("媒体 Golden 任务 payload 版本不受支持");
  }
  if (
    typeof raw.caseVersion !== "number"
    || typeof raw.caseFingerprint !== "string"
    || typeof raw.promptHash !== "string"
    || !raw.binding
    || typeof raw.binding !== "object"
    || Array.isArray(raw.binding)
  ) throw new Error("媒体 Golden 任务指纹不完整");
  const binding = raw.binding as Record<string, unknown>;
  for (const key of [
    "candidateKey",
    "evaluationFingerprint",
    "promptContentSha256",
    "draftConfigSha256",
    "goldenSetSha256",
    "codeVersion",
  ]) {
    if (typeof binding[key] !== "string" || !binding[key]) {
      throw new Error("媒体 Golden 任务候选绑定指纹不完整");
    }
  }
  return {
    version: 1,
    endpoint: parseEndpoint(raw.endpoint),
    binding: binding as unknown as GoldenCandidateBinding,
    caseVersion: raw.caseVersion,
    caseFingerprint: raw.caseFingerprint,
    promptHash: raw.promptHash,
    constraints: parseConstraints(raw.constraints),
  };
}

export function goldenMediaJobBinding(job: GoldenMediaEvalJobRecord): GoldenCandidateBinding {
  return parsePayload(job).binding;
}

export function goldenMediaJobConstraints(job: GoldenMediaEvalJobRecord): GoldenMediaJobConstraints {
  return parsePayload(job).constraints;
}

function dedicatedPrompt(goldenCase: MediaGoldenCase, systemPrompt: string) {
  return [
    systemPrompt.trim(),
    goldenCase.input.userPrompt,
    `Golden Set 锁定参数：${JSON.stringify(goldenCase.input.data)}`,
  ].filter(Boolean).join("\n\n");
}

function ensureLockedCaseParameters(
  goldenCase: MediaGoldenCase,
  requestKind: ResumableGoldenMediaRequestKind,
  imageDataUrls: string[],
) {
  const data = goldenCase.input.data as Record<string, unknown>;
  if (data.aspectRatio !== "9:16" || imageDataUrls.length !== 1) {
    throw new Error("Golden 媒体 case 的 9:16 锁定参数或参考图不完整");
  }
  if (requestKind === "image-generation") {
    if (exactNumber(data, "count") !== 1 || data.safetyMode !== "no-face") {
      throw new Error("生图 Golden case 锁定参数不完整");
    }
    return { count: 1 };
  }
  const durationSeconds = exactNumber(data, "durationSeconds");
  if (durationSeconds !== 5 || data.cameraMotion !== "slow-orbit" || data.safetyMode !== "no-face") {
    throw new Error("生视频 Golden case 锁定参数不完整");
  }
  return { durationSeconds };
}

function operationCandidateKey(operationKey: string, role: AgentEndpointRole) {
  return `golden:${hashGenerationRequest({ operationKey, role })}`;
}

/**
 * 入队前整组预检：fixture SHA、prompt 版本、无密钥 endpoint 快照、可恢复模式缺一不可。
 * 返回的 payload 没有 apiKey；worker 执行时再用 secretRef 在服务端解析。
 */
export async function prepareGoldenMediaEvalJobs(
  input: PrepareGoldenMediaEvalJobsInput,
): Promise<EnqueueGoldenMediaEvalJobInput[]> {
  const operationKey = normalizeGoldenMediaIdempotencyKey(input.operationKey);
  const state = input.state ?? await getAgentStrategy();
  const goldenCase = getGoldenCase(input.caseId);
  if (goldenCase.outputKind !== "media" || goldenCase.agentId !== input.agentId) {
    throw new Error("Golden case 不是所选 Agent 的媒体评测");
  }
  const family = getCapabilityFamilyForAgent(goldenCase.agentId);
  if (
    family.requestKind !== "image-generation"
    && family.requestKind !== "video-generation"
    && family.requestKind !== "tts-generation"
  ) {
    throw new Error("Golden case 不是可持久调度的媒体能力");
  }
  const requestKind = family.requestKind;

  const readiness = await getGoldenCaseFixtureReadiness(goldenCase);
  if (!readiness.ready) {
    throw new Error(readiness.fixtures.filter((item) => !item.ready).map((item) => item.reason).join("；"));
  }
  const agent = state.draftAgents.find((item) => item.id === input.agentId);
  if (!agent) throw new Error("未找到 Agent draft 候选");
  if (input.promptVersion && input.promptVersion !== agent.promptVersion) {
    throw new Error("只能评测当前 draft prompt 版本");
  }
  const prompt = getAgentPrompt(state, input.agentId, agent.promptVersion);
  const promptHash = hashGenerationRequest(prompt);
  const fingerprint = caseFingerprint(goldenCase);
  const constraints = caseConstraints(goldenCase);
  const roles = [...new Set(input.candidateRoles)];
  if (!roles.length || roles.some((role) => role !== "primary" && role !== "fallback")) {
    throw new Error("必须选择 primary/fallback 候选槽");
  }

  return roles.map((role) => {
    const endpoint = agent[role];
    if (!endpointReady(endpoint)) throw new Error(`draft ${role} 候选端点或凭据未就绪`);
    assertDurableGoldenMediaMode(endpoint.provider, requestKind);
    // 在整批入队前同时验证凭据可解析、供应商主机白名单、固定模型与用例参数；
    // 避免 primary 已入队后才发现 fallback 根本不允许付费执行。
    assertGoldenMediaCandidateReady(goldenCase, toLLMConfig(endpoint));
    const binding = candidateBindingFor(state, agent, role, requestKind);
    const payload: GoldenMediaJobPayloadV1 = {
      version: 1,
      endpoint: endpointSnapshot(endpoint),
      binding,
      caseVersion: goldenCase.version,
      caseFingerprint: fingerprint,
      promptHash,
      constraints,
    };
    return {
      idempotencyKey: operationCandidateKey(operationKey, role),
      agentId: input.agentId,
      caseId: goldenCase.id,
      candidateRole: role,
      candidateKey: binding.candidateKey,
      provider: endpoint.provider,
      model: endpoint.model,
      promptVersion: agent.promptVersion,
      strategyRevision: agent.strategyRevision,
      requestKind,
      payload: payload as unknown as Record<string, unknown>,
      requestHash: hashGenerationRequest(payload),
    };
  });
}

function verifiedPayload(job: GoldenMediaEvalJobRecord) {
  if (hashGenerationRequest(job.payload) !== job.requestHash) throw new Error("评测任务 payload 指纹不一致");
  const payload = parsePayload(job);
  if (
    payload.endpoint.provider !== job.provider
    || payload.endpoint.model !== job.model
    || payload.binding.candidateKey !== job.candidateKey
  ) throw new Error("评测任务列与候选快照不一致");
  const requestKind = job.requestKind;
  assertDurableGoldenMediaMode(job.provider, requestKind);
  return { payload, requestKind };
}

function sameBinding(left: GoldenCandidateBinding, right: GoldenCandidateBinding) {
  return left.candidateKey === right.candidateKey
    && left.evaluationFingerprint === right.evaluationFingerprint
    && left.promptContentSha256 === right.promptContentSha256
    && left.draftConfigSha256 === right.draftConfigSha256
    && left.goldenSetSha256 === right.goldenSetSha256
    && left.codeVersion === right.codeVersion;
}

/**
 * taskId 已持久化后的 GET 轮询只重放冻结端点，不再依赖可变 draft/prompt/case。
 * 否则管理员在付费后编辑草稿，会让已收费的远程产物无法被收集。
 */
export function buildGoldenMediaProviderConnection(
  job: GoldenMediaEvalJobRecord,
): GoldenMediaProviderConnection {
  const { payload, requestKind } = verifiedPayload(job);
  assertResumableGoldenMediaMode(job.provider, requestKind);
  const runtime: AgentRuntimeConfig = toLLMConfig(payload.endpoint);
  return {
    provider: runtime.provider,
    baseUrl: runtime.baseUrl,
    apiKey: runtime.apiKey,
    model: runtime.model,
    requestKind,
  };
}

/** 仅在唯一一次付费 submit 前重放入队指纹；draft/code/case/prompt 已漂移就终止。 */
export async function buildGoldenMediaProviderRequest(
  job: GoldenMediaEvalJobRecord,
  state?: AgentStrategyState,
): Promise<GoldenMediaProviderRequest> {
  const { payload, requestKind } = verifiedPayload(job);
  assertResumableGoldenMediaMode(job.provider, requestKind);

  const goldenCase = getGoldenCase(job.caseId);
  if (goldenCase.outputKind !== "media" || goldenCase.agentId !== job.agentId) {
    throw new Error("评测任务引用的 Golden case 已不匹配");
  }
  if (
    goldenCase.version !== payload.caseVersion
    || caseFingerprint(goldenCase) !== payload.caseFingerprint
  ) throw new Error("Golden case 已变更，旧任务不能继续付费执行");

  const currentState = state ?? await getAgentStrategy();
  const currentAgent = currentState.draftAgents.find((item) => item.id === job.agentId);
  if (!currentAgent) throw new Error("Golden 任务对应的 draft 候选已不存在");
  const currentBinding = candidateBindingFor(currentState, currentAgent, job.candidateRole, requestKind);
  if (!sameBinding(currentBinding, payload.binding)) {
    throw new Error("Golden 任务入队后 draft、prompt、Golden Set 或代码版本已变更，未发起付费提交");
  }
  const prompt = getAgentPrompt(currentState, job.agentId as AgentId, job.promptVersion);
  if (hashGenerationRequest(prompt) !== payload.promptHash) {
    throw new Error("Golden 任务锁定的 prompt 指纹已变更");
  }
  const imageDataUrls = await Promise.all(
    (goldenCase.input.attachments ?? []).map(resolveGoldenAttachmentDataUrl),
  );
  const locked = ensureLockedCaseParameters(goldenCase, requestKind, imageDataUrls);
  const runtime: AgentRuntimeConfig = toLLMConfig(payload.endpoint);
  assertGoldenMediaCandidateReady(goldenCase, runtime);
  return {
    provider: runtime.provider,
    baseUrl: runtime.baseUrl,
    apiKey: runtime.apiKey,
    model: runtime.model,
    requestKind,
    prompt: dedicatedPrompt(goldenCase, prompt),
    referenceImageUrl: exactString({ image: imageDataUrls[0] }, "image"),
    width: 1080,
    height: 1920,
    ...locked,
  };
}

/** 同步 TTS 的唯一一次付费执行前，与异步媒体使用相同的冻结候选/指纹重放。 */
export async function buildGoldenTtsOneShotRequest(
  job: GoldenMediaEvalJobRecord,
  state?: AgentStrategyState,
): Promise<GoldenTtsOneShotRequest> {
  const { payload, requestKind } = verifiedPayload(job);
  if (requestKind !== "tts-generation") throw new Error("该 Golden job 不是 TTS one-shot 任务");

  const goldenCase = getGoldenCase(job.caseId);
  if (goldenCase.outputKind !== "media" || goldenCase.agentId !== job.agentId) {
    throw new Error("TTS 评测任务引用的 Golden case 已不匹配");
  }
  if (
    goldenCase.version !== payload.caseVersion
    || caseFingerprint(goldenCase) !== payload.caseFingerprint
  ) throw new Error("TTS Golden case 已变更，旧任务不能继续付费执行");

  const currentState = state ?? await getAgentStrategy();
  const currentAgent = currentState.draftAgents.find((item) => item.id === job.agentId);
  if (!currentAgent) throw new Error("TTS Golden 任务对应的 draft 候选已不存在");
  const currentBinding = candidateBindingFor(currentState, currentAgent, job.candidateRole, requestKind);
  if (!sameBinding(currentBinding, payload.binding)) {
    throw new Error("TTS Golden 任务入队后 draft、prompt、Golden Set 或代码版本已变更，未发起付费提交");
  }
  const prompt = getAgentPrompt(currentState, job.agentId as AgentId, job.promptVersion);
  if (hashGenerationRequest(prompt) !== payload.promptHash) {
    throw new Error("TTS Golden 任务锁定的 prompt 指纹已变更");
  }

  const runtime: AgentRuntimeConfig = toLLMConfig(payload.endpoint);
  assertGoldenMediaCandidateReady(goldenCase, runtime);
  const data = goldenCase.input.data as Record<string, unknown>;
  const text = exactString(data, "text");
  const speed = exactNumber(data, "speed");
  if (
    data.locale !== "zh-CN"
    || speed !== 1
    || (goldenCase.input.attachments?.length ?? 0) !== 0
    || !runtime.voice?.trim()
  ) throw new Error("TTS Golden case 锁定参数不完整");
  return {
    text,
    provider: runtime.provider,
    baseUrl: runtime.baseUrl,
    apiKey: runtime.apiKey,
    model: runtime.model,
    voice: runtime.voice,
    speed,
    ...(runtime.groupId ? { groupId: runtime.groupId } : {}),
  };
}
