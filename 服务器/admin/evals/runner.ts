import "server-only";

import { createHash } from "node:crypto";
import OpenAI from "openai";
import { createSafeOpenAIClient } from "@backend/shared/openai-client";

import { generateSpeech, type TTSConfig } from "@backend/core/media/tts";
import { createProvider, type ImageResult, type VideoResult } from "@backend/providers";
import type {
  AgentConfig,
  AgentEndpointRole,
  AgentEvalRecord,
  AgentEvalRequestKind,
  AgentEvalArtifactMetadata,
  AgentId,
  AgentPromotionEvidence,
  AgentStrategyState,
  GoldenEvalCaseDto,
  GoldenEvalPromotionDto,
} from "@server/admin/agents/types";
import type { AgentRuntimeConfig } from "@server/admin/agents/service";
import {
  GOLDEN_CASES,
  getCapabilityFamilyForAgent,
  getGoldenCase,
  getGoldenCasesForAgent,
  type GoldenCase,
  type JsonGoldenCase,
  type MediaGoldenCase,
} from "./golden-set";
import {
  getGoldenCaseFixtureReadiness,
  resolveGoldenAttachmentDataUrl,
} from "./fixtures";
import {
  INVITE_BETA_PROMOTION_THRESHOLDS,
  aggregatePromotionMetrics,
  evaluatePromotion,
  scoreGoldenOutput,
  type GoldenTrialResult,
  type JsonCaseScore,
} from "./scoring";
import {
  deleteGoldenArtifacts,
  storeGoldenAudioArtifact,
  storeGoldenRemoteArtifacts,
  verifyGoldenArtifacts,
} from "./artifacts";

const SHA256 = /^[0-9a-f]{64}$/;

const REQUEST_KINDS = new Set<AgentEvalRequestKind>([
  "chat-json",
  "vision-json",
  "image-generation",
  "video-generation",
  "tts-generation",
]);

export interface GoldenCaseReadinessResult {
  ready: boolean;
  reason: string;
}

export async function getGoldenCaseReadiness(goldenCase: GoldenCase): Promise<GoldenCaseReadinessResult> {
  const fixtureReadiness = await getGoldenCaseFixtureReadiness(goldenCase);
  if (!fixtureReadiness.ready) {
    return {
      ready: false,
      reason: fixtureReadiness.fixtures.filter((item) => !item.ready).map((item) => item.reason).join("；"),
    };
  }
  return {
    ready: true,
    reason: goldenCase.outputKind === "media"
      ? "Golden case、锁定 fixture 与专用媒体执行器已就绪"
      : "Golden case 与锁定 fixture 已就绪",
  };
}

export async function listGoldenCaseDtos(): Promise<GoldenEvalCaseDto[]> {
  return Promise.all(GOLDEN_CASES.map(async (goldenCase) => {
    const family = getCapabilityFamilyForAgent(goldenCase.agentId);
    const fixtureReadiness = await getGoldenCaseFixtureReadiness(goldenCase);
    const readiness = await getGoldenCaseReadiness(goldenCase);
    return {
      id: goldenCase.id,
      agentId: goldenCase.agentId,
      familyId: goldenCase.familyId,
      name: goldenCase.name,
      weight: goldenCase.weight,
      requestKind: family.requestKind,
      outputKind: goldenCase.outputKind,
      ready: readiness.ready,
      readinessReason: readiness.reason,
      fixtures: fixtureReadiness.fixtures,
      rubric: goldenCase.rubric.map((criterion) => ({
        id: criterion.id,
        label: criterion.label,
        weight: criterion.weight,
        evaluator: criterion.evaluator,
        ...(criterion.evaluator === "human"
          ? { guidance: criterion.guidance, anchors: criterion.anchors }
          : {}),
      })),
    };
  }));
}

function goldenUserText(goldenCase: JsonGoldenCase): string {
  return [
    goldenCase.input.userPrompt,
    "",
    "【Golden Set 固定输入】",
    JSON.stringify(goldenCase.input.data),
    "",
    "严格只输出一个合法 JSON 值，不要 Markdown 代码块或解释。",
  ].join("\n");
}

function finiteUsd(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/** 只读取明确标注 USD 的供应商字段，不按 token/时延自行猜测。 */
export function extractActualCostUsd(response: unknown): number | null {
  if (!response || typeof response !== "object") return null;
  const root = response as Record<string, unknown>;
  const usage = root.usage && typeof root.usage === "object"
    ? root.usage as Record<string, unknown>
    : {};
  const extra = root.extra && typeof root.extra === "object"
    ? root.extra as Record<string, unknown>
    : {};
  const extraUsage = extra.usage && typeof extra.usage === "object"
    ? extra.usage as Record<string, unknown>
    : {};
  return finiteUsd(usage.cost_usd)
    ?? finiteUsd(usage.costUsd)
    ?? finiteUsd(root.cost_usd)
    ?? finiteUsd(root.costUsd)
    ?? finiteUsd(extraUsage.cost_usd)
    ?? finiteUsd(extraUsage.costUsd)
    ?? finiteUsd(extra.cost_usd)
    ?? finiteUsd(extra.costUsd);
}

export interface GoldenJsonExecutionResult {
  output: string;
  score: JsonCaseScore;
  latencyMs: number;
  actualCostUsd: number | null;
}

type GoldenChatExecutor = (input: {
  config: AgentRuntimeConfig;
  systemPrompt: string;
  goldenCase: JsonGoldenCase;
  imageDataUrls: string[];
}) => Promise<{ output: string; response: unknown }>;

async function executeOpenAiChat(input: Parameters<GoldenChatExecutor>[0]) {
  const family = getCapabilityFamilyForAgent(input.goldenCase.agentId);
  const client = createSafeOpenAIClient({
    baseURL: input.config.baseUrl,
    apiKey: input.config.apiKey,
    timeout: family.requestKind === "vision-json" ? 60_000 : 30_000,
    maxRetries: 0,
  });
  const userText = goldenUserText(input.goldenCase);
  const userContent: OpenAI.Chat.Completions.ChatCompletionUserMessageParam["content"] =
    family.requestKind === "vision-json"
      ? [
          // 与生产 analyzeProduct 保持一致：视觉指令和固定输入放在同一条 user 多模态消息。
          { type: "text", text: `${input.systemPrompt}\n\n${userText}` },
          ...input.imageDataUrls.map((url) => ({
            type: "image_url" as const,
            image_url: { url, detail: "high" as const },
          })),
        ]
      : userText;
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = family.requestKind === "vision-json"
    ? [{ role: "user", content: userContent }]
    : [
        { role: "system", content: input.systemPrompt },
        { role: "user", content: userContent },
      ];
  const response = await client.chat.completions.create({
    model: family.requestKind === "vision-json"
      ? input.config.visionModel || input.config.model
      : input.config.model,
    messages,
    temperature: 0.2,
    max_tokens: 2_400,
  });
  return {
    output: response.choices[0]?.message?.content || "",
    response,
  };
}

/**
 * 只执行 JSON 能力。所有 fixture 在 executor 之前解析，因此缺失/篡改时不会产生付费请求。
 * 候选端点由调用方精确传入，本执行器永不触发 fallback。
 */
export async function runGoldenJsonCase(
  goldenCase: JsonGoldenCase,
  config: AgentRuntimeConfig,
  systemPrompt: string,
  executor: GoldenChatExecutor = executeOpenAiChat,
): Promise<GoldenJsonExecutionResult> {
  const family = getCapabilityFamilyForAgent(goldenCase.agentId);
  if (family.requestKind !== "chat-json" && family.requestKind !== "vision-json") {
    throw new Error(`Case ${goldenCase.id} 不是 JSON 评测能力`);
  }
  const readiness = await getGoldenCaseReadiness(goldenCase);
  if (!readiness.ready) throw new Error(readiness.reason);
  const imageDataUrls = await Promise.all(
    (goldenCase.input.attachments ?? []).map(resolveGoldenAttachmentDataUrl),
  );
  const started = Date.now();
  const result = await executor({ config, systemPrompt, goldenCase, imageDataUrls });
  const score = scoreGoldenOutput(goldenCase, result.output);
  if (score.evaluator !== "automatic-json") throw new Error(`Case ${goldenCase.id} 评分器类型错误`);
  return {
    output: result.output,
    score,
    latencyMs: Date.now() - started,
    actualCostUsd: extractActualCostUsd(result.response),
  };
}

const IMAGE_TO_IMAGE_MODELS: Readonly<Record<string, RegExp>> = {
  "atlas-cloud": /(?:\/edit\b|image-to-image)/i,
  "fal-ai": /(?:\/edit\b|image-to-image)/i,
  volcengine: /seedream/i,
  alibaba: /(?:image[-_]?edit|image-to-image|wanx.*edit)/i,
  siliconflow: /edit/i,
  replicate: /(?:kontext|\/edit\b|image-to-image)/i,
};
const IMAGE_TO_VIDEO_MODELS: Readonly<Record<string, RegExp>> = {
  "atlas-cloud": /(?:image-to-video|reference-to-video|start-end-to-video)/i,
  "fal-ai": /image-to-video/i,
  volcengine: /(?:seedance|kling)/i,
  alibaba: /(?:image-to-video|\bi2v\b)/i,
  zhipu: /cogvideox/i,
};
const TTS_PROVIDERS = new Set(["volcengine", "openai", "atlas", "minimax", "falai"]);

const PROVIDER_HOSTS: Readonly<Record<string, readonly string[]>> = {
  "atlas-cloud": ["api.atlascloud.ai"],
  "fal-ai": ["api.fal.ai", "queue.fal.run"],
  volcengine: ["ark.cn-beijing.volces.com", "openspeech.bytedance.com"],
  alibaba: ["dashscope.aliyuncs.com"],
  siliconflow: ["api.siliconflow.cn"],
  replicate: ["api.replicate.com"],
  zhipu: ["open.bigmodel.cn"],
  atlas: ["api.atlascloud.ai"],
  minimax: ["api.minimax.chat", "api.minimaxi.com"],
  falai: ["queue.fal.run"],
};

/** 与线上生图路由的 imageModelForMode 保持同一转换语义。 */
function imageCandidateModelForLockedMode(provider: string, model: string) {
  if (provider === "atlas-cloud" && model === "openai/gpt-image-2/text-to-image") {
    return "openai/gpt-image-2/edit";
  }
  if (provider === "fal-ai" && model === "openai/gpt-image-2") {
    return "openai/gpt-image-2/image-to-image";
  }
  if (model === "fal-ai/gpt-image-1.5") return "fal-ai/gpt-image-1.5/edit";
  if (model.startsWith("black-forest-labs/flux") && !model.includes("kontext")) {
    return "black-forest-labs/flux-kontext-pro";
  }
  if (model.endsWith("/text-to-image")) return model.replace(/\/text-to-image$/, "/image-to-image");
  return model;
}

/** 与线上生视频路由的 videoModelForMode 保持同一转换语义。 */
function videoCandidateModelForLockedMode(model: string) {
  return model.includes("/text-to-video")
    ? model.replace("/text-to-video", "/image-to-video")
    : model;
}

function caseData(goldenCase: MediaGoldenCase) {
  return goldenCase.input.data as Record<string, unknown>;
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

function assertVerticalCase(data: Record<string, unknown>) {
  if (data.aspectRatio !== "9:16") throw new Error("Golden 媒体 case 当前只支持锁定的 9:16 参数");
  return { width: 1080, height: 1920 };
}

function assertCandidateOrigin(config: AgentRuntimeConfig) {
  const allowed = PROVIDER_HOSTS[config.provider];
  // openai 是显式的兼容协议，可在全局模型端点白名单中使用多家主机。
  if (!allowed) return;
  const hostname = new URL(config.baseUrl).hostname.toLowerCase();
  if (!allowed.includes(hostname)) {
    throw new Error(`${config.provider} 不允许向 ${hostname} 发送候选凭据`);
  }
}

function assertPinnedMediaModel(model: string) {
  if (/(?:^|[-_/.])latest(?:$|[-_/.])/i.test(model)) {
    throw new Error("媒体 Golden 评测必须使用固定模型 ID，不允许 latest");
  }
}

function dedicatedPrompt(goldenCase: MediaGoldenCase, systemPrompt: string) {
  return [
    systemPrompt.trim(),
    goldenCase.input.userPrompt,
    `Golden Set 锁定参数：${JSON.stringify(goldenCase.input.data)}`,
  ].filter(Boolean).join("\n\n");
}

/**
 * 付费请求前的纯配置预检。路由会先把所有选中槽位都跑完本检查，
 * 防止 primary 已花费后才发现 fallback 压根不能执行。
 */
export function assertGoldenMediaCandidateReady(
  goldenCase: MediaGoldenCase,
  config: AgentRuntimeConfig,
) {
  const family = getCapabilityFamilyForAgent(goldenCase.agentId);
  const data = caseData(goldenCase);
  assertCandidateOrigin(config);
  assertPinnedMediaModel(config.model);
  if (family.requestKind === "image-generation") {
    assertVerticalCase(data);
    if (data.count !== 1 || data.safetyMode !== "no-face" || goldenCase.input.attachments?.length !== 1) {
      throw new Error("生图 Golden case 参数或锁定参考图不完整");
    }
    const effectiveModel = imageCandidateModelForLockedMode(config.provider, config.model);
    assertPinnedMediaModel(effectiveModel);
    const modelPattern = IMAGE_TO_IMAGE_MODELS[config.provider];
    if (!modelPattern?.test(effectiveModel)) {
      throw new Error(`Provider/model ${config.provider}/${config.model} 未明确支持锁定的商品图生图参数`);
    }
  } else if (family.requestKind === "video-generation") {
    assertVerticalCase(data);
    const duration = exactNumber(data, "durationSeconds");
    if (duration !== 5 || data.cameraMotion !== "slow-orbit" || data.safetyMode !== "no-face" || goldenCase.input.attachments?.length !== 1) {
      throw new Error("生视频 Golden case 锁定参数不完整");
    }
    const effectiveModel = videoCandidateModelForLockedMode(config.model);
    assertPinnedMediaModel(effectiveModel);
    const modelPattern = IMAGE_TO_VIDEO_MODELS[config.provider];
    if (!modelPattern?.test(effectiveModel)) {
      throw new Error(`Provider/model ${config.provider}/${config.model} 未明确支持 9:16、5 秒、首帧图生视频`);
    }
  } else if (family.requestKind === "tts-generation") {
    if (!TTS_PROVIDERS.has(config.provider)) {
      throw new Error(`TTS Provider ${config.provider} 未被专用执行器支持`);
    }
    if (!config.voice?.trim()) throw new Error("TTS 候选未配置 voice，未发起付费请求");
    const text = exactString(data, "text");
    const speed = exactNumber(data, "speed");
    if (!text || data.locale !== "zh-CN" || speed !== 1 || (goldenCase.input.attachments?.length ?? 0) !== 0) {
      throw new Error("TTS Golden case 锁定参数不完整");
    }
    if (config.provider === "minimax" && new URL(config.baseUrl).hostname === "api.minimax.chat" && !config.groupId?.trim()) {
      throw new Error("MiniMax 国内候选必须配置 GroupId，未发起付费请求");
    }
  } else {
    throw new Error(`Case ${goldenCase.id} 不是媒体评测能力`);
  }
  if (!config.apiKey.trim() || !config.baseUrl.trim() || !config.model.trim()) {
    throw new Error("媒体候选配置不完整，未发起付费请求");
  }
}

export type GoldenMediaProviderExecution =
  | {
      mediaType: "image" | "video";
      remoteUrls: string[];
      response: ImageResult | VideoResult | Record<string, unknown>;
    }
  | {
      mediaType: "audio";
      audio: Buffer;
      response: Record<string, unknown> | null;
    };

export type GoldenMediaExecutor = (input: {
  config: AgentRuntimeConfig;
  systemPrompt: string;
  goldenCase: MediaGoldenCase;
  imageDataUrls: string[];
}) => Promise<GoldenMediaProviderExecution>;

/** 媒体 case 只调用同能力的专用 API，不存在 chat completion 代理路径。 */
export async function executeGoldenMediaProvider(
  input: Parameters<GoldenMediaExecutor>[0],
): Promise<GoldenMediaProviderExecution> {
  assertGoldenMediaCandidateReady(input.goldenCase, input.config);
  const family = getCapabilityFamilyForAgent(input.goldenCase.agentId);
  const data = caseData(input.goldenCase);

  if (family.requestKind === "image-generation") {
    const dimensions = assertVerticalCase(data);
    if (data.count !== 1 || data.safetyMode !== "no-face" || input.imageDataUrls.length !== 1) {
      throw new Error("生图 Golden case 参数或锁定参考图不完整");
    }
    const provider = createProvider({
      name: input.config.provider,
      apiKey: input.config.apiKey,
      baseUrl: input.config.baseUrl,
      timeout: 120_000,
    });
    const response = await provider.generateImage({
      modelId: imageCandidateModelForLockedMode(input.config.provider, input.config.model),
      mode: "image-to-image",
      prompt: dedicatedPrompt(input.goldenCase, input.systemPrompt),
      width: dimensions.width,
      height: dimensions.height,
      count: 1,
      referenceImageUrl: input.imageDataUrls[0],
    });
    return { mediaType: "image", remoteUrls: response.imageUrls, response };
  }

  if (family.requestKind === "video-generation") {
    const dimensions = assertVerticalCase(data);
    const duration = exactNumber(data, "durationSeconds");
    if (duration !== 5 || data.cameraMotion !== "slow-orbit" || data.safetyMode !== "no-face" || input.imageDataUrls.length !== 1) {
      throw new Error("生视频 Golden case 参数或锁定首帧不完整");
    }
    const provider = createProvider({
      name: input.config.provider,
      apiKey: input.config.apiKey,
      baseUrl: input.config.baseUrl,
      timeout: 120_000,
    });
    const response = await provider.generateVideo({
      modelId: videoCandidateModelForLockedMode(input.config.model),
      mode: "image-to-video",
      prompt: dedicatedPrompt(input.goldenCase, input.systemPrompt),
      width: dimensions.width,
      height: dimensions.height,
      duration,
      firstFrameUrl: input.imageDataUrls[0],
      audioEnabled: false,
    });
    return { mediaType: "video", remoteUrls: response.videoUrls, response };
  }

  const text = exactString(data, "text");
  const speed = exactNumber(data, "speed");
  if (data.locale !== "zh-CN" || speed !== 1 || input.imageDataUrls.length !== 0) {
    throw new Error("TTS Golden case 锁定参数不完整");
  }
  const ttsConfig: TTSConfig = {
    provider: input.config.provider as TTSConfig["provider"],
    baseUrl: input.config.baseUrl,
    apiKey: input.config.apiKey,
    model: input.config.model,
    voice: input.config.voice!,
    speed,
    groupId: input.config.groupId,
  };
  const audio = await generateSpeech(text, ttsConfig, { bypassCache: true });
  return { mediaType: "audio", audio, response: null };
}

export interface GoldenMediaExecutionResult {
  output: string;
  artifactUrls: string[];
  artifactMetadata: AgentEvalArtifactMetadata[];
  latencyMs: number;
  actualCostUsd: number | null;
}

function assertGoldenOutputMediaConstraints(
  goldenCase: MediaGoldenCase,
  artifacts: readonly AgentEvalArtifactMetadata[],
) {
  const data = caseData(goldenCase);
  for (const artifact of artifacts) {
    if (artifact.mediaType !== goldenCase.requiredShape.mediaType) {
      throw new Error("评测产物媒体类型与 Golden case 不一致");
    }
    if (artifact.mediaType === "image" || artifact.mediaType === "video") {
      const width = artifact.probe.width;
      const height = artifact.probe.height;
      if (!width || !height) throw new Error("评测产物缺少实际尺寸");
      if (data.aspectRatio === "9:16") {
        const target = 9 / 16;
        const relativeError = Math.abs(width / height - target) / target;
        if (relativeError > 0.04) throw new Error("评测产物实际比例不是可接受的 9:16");
      }
    }
    if (artifact.mediaType === "video") {
      const expected = exactNumber(data, "durationSeconds");
      const duration = artifact.probe.durationSeconds;
      if (!duration || Math.abs(duration - expected) > 1) {
        throw new Error(`评测视频实际时长应为 ${expected}±1 秒`);
      }
    }
    if (artifact.mediaType === "audio") {
      const range = data.expectedDurationSeconds;
      const duration = artifact.probe.durationSeconds;
      if (!Array.isArray(range) || range.length !== 2
        || typeof range[0] !== "number" || typeof range[1] !== "number"
        || !duration || duration < range[0] || duration > range[1]) {
        throw new Error("评测 TTS 实际时长不在 Golden case 锁定范围内");
      }
    }
  }
}

/**
 * fixture 完整性校验和 data URL 解析都发生在 executor 之前；任何缺失/篡改
 * 都会保证付费执行器的调用次数为 0。
 */
export async function runGoldenMediaCase(
  goldenCase: MediaGoldenCase,
  config: AgentRuntimeConfig,
  systemPrompt: string,
  evalId: string,
  executor: GoldenMediaExecutor = executeGoldenMediaProvider,
): Promise<GoldenMediaExecutionResult> {
  const family = getCapabilityFamilyForAgent(goldenCase.agentId);
  if (family.requestKind !== "image-generation" && family.requestKind !== "video-generation" && family.requestKind !== "tts-generation") {
    throw new Error(`Case ${goldenCase.id} 不是媒体评测能力`);
  }
  const readiness = await getGoldenCaseReadiness(goldenCase);
  if (!readiness.ready) throw new Error(readiness.reason);
  const imageDataUrls = await Promise.all(
    (goldenCase.input.attachments ?? []).map(resolveGoldenAttachmentDataUrl),
  );

  const started = Date.now();
  const result = await executor({ config, systemPrompt, goldenCase, imageDataUrls });
  if (result.mediaType !== goldenCase.requiredShape.mediaType) {
    throw new Error("专用执行器返回了错误的媒体类型");
  }

  let stored: AgentEvalArtifactMetadata[] = [];
  try {
    if (result.mediaType === "audio") {
      stored = await storeGoldenAudioArtifact(evalId, result.audio);
    } else {
      const expectedCount = result.mediaType === "image" ? exactNumber(caseData(goldenCase), "count") : 1;
      if (!Number.isInteger(expectedCount) || result.remoteUrls.length !== expectedCount) {
        throw new Error(`专用执行器应返回 ${expectedCount} 个真实产物`);
      }
      stored = await storeGoldenRemoteArtifacts(evalId, result.mediaType, result.remoteUrls);
    }
    if (stored.length < goldenCase.requiredShape.minimumArtifacts) {
      throw new Error("真实评测产物数量不足");
    }
    assertGoldenOutputMediaConstraints(goldenCase, stored);
  } catch (error) {
    await deleteGoldenArtifacts(evalId, stored.map((artifact) => artifact.url));
    throw error;
  }
  return {
    output: `已生成 ${stored.length} 个 ${goldenCase.requiredShape.mediaType} 评测产物，等待人工 rubric 评审`,
    artifactUrls: stored.map((artifact) => artifact.url),
    artifactMetadata: stored,
    latencyMs: Date.now() - started,
    actualCostUsd: extractActualCostUsd(result.response),
  };
}

export function effectiveCandidateModel(
  agent: AgentConfig,
  role: AgentEndpointRole,
  requestKind: AgentEvalRequestKind,
): string {
  const endpoint = agent[role];
  if (requestKind === "image-generation") {
    return imageCandidateModelForLockedMode(endpoint.provider, endpoint.model);
  }
  if (requestKind === "video-generation") return videoCandidateModelForLockedMode(endpoint.model);
  return requestKind === "vision-json" ? endpoint.visionModel || endpoint.model : endpoint.model;
}

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalJsonValue(item));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, item]) => [key, canonicalJsonValue(item)]),
  );
}

function sha256Json(value: unknown) {
  return createHash("sha256").update(JSON.stringify(canonicalJsonValue(value))).digest("hex");
}

export function goldenSetSha256() {
  return sha256Json(GOLDEN_CASES);
}

export function evaluationCodeVersion() {
  return (
    process.env.HUIMAI_CODE_VERSION ||
    process.env.VERCEL_GIT_COMMIT_SHA ||
    process.env.npm_package_version ||
    "unknown"
  ).trim().slice(0, 200) || "unknown";
}

export interface GoldenCandidateBinding {
  candidateKey: string;
  evaluationFingerprint: string;
  promptContentSha256: string;
  draftConfigSha256: string;
  goldenSetSha256: string;
  codeVersion: string;
}

/**
 * 将候选槽绑定到完整 draft、prompt 实际内容、Golden Set 和可得的代码版本。
 * 任一内容变更都会生成新 candidateKey，旧记录无法参与发布。
 */
export function candidateBindingFor(
  state: AgentStrategyState,
  agent: AgentConfig,
  role: AgentEndpointRole,
  requestKind: AgentEvalRequestKind,
): GoldenCandidateBinding {
  const promptMatches = state.prompts.filter(
    (prompt) => prompt.agentId === agent.id && prompt.version === agent.promptVersion,
  );
  if (promptMatches.length !== 1 || !promptMatches[0].content.trim()) {
    throw new Error(`${agent.id} draft prompt ${agent.promptVersion} 缺失、重复或为空`);
  }
  const promptContentSha256 = sha256Json({
    agentId: agent.id,
    version: agent.promptVersion,
    content: promptMatches[0].content,
  });
  const draftConfigSha256 = sha256Json({
    id: agent.id,
    name: agent.name,
    description: agent.description,
    primary: agent.primary,
    fallback: agent.fallback,
    promptVersion: agent.promptVersion,
    enabled: agent.enabled,
  });
  const goldenHash = goldenSetSha256();
  const codeVersion = evaluationCodeVersion();
  const endpoint = agent[role];
  const evaluationFingerprint = sha256Json({
    agentId: agent.id,
    role,
    requestKind,
    effectiveModel: effectiveCandidateModel(agent, role, requestKind),
    provider: endpoint.provider,
    promptContentSha256,
    draftConfigSha256,
    goldenSetSha256: goldenHash,
    codeVersion,
  });
  return {
    candidateKey: `${role}:${endpoint.provider}/${effectiveCandidateModel(agent, role, requestKind)}@${evaluationFingerprint}`,
    evaluationFingerprint,
    promptContentSha256,
    draftConfigSha256,
    goldenSetSha256: goldenHash,
    codeVersion,
  };
}

export function candidateKeyFor(
  state: AgentStrategyState,
  agent: AgentConfig,
  role: AgentEndpointRole,
  requestKind: AgentEvalRequestKind,
): string {
  return candidateBindingFor(state, agent, role, requestKind).candidateKey;
}

/**
 * 只供通过门禁后的发布事务调用。证据来自当前 state 的真实 candidate binding，
 * 不接受浏览器或调用方传入 candidateKey/hash。
 */
export function promotionEvidenceForDraft(
  state: AgentStrategyState,
  agentId: AgentId,
  verifiedAt: string,
): AgentPromotionEvidence {
  const parsedAt = Date.parse(verifiedAt);
  if (!Number.isFinite(parsedAt) || new Date(parsedAt).toISOString() !== verifiedAt) {
    throw new Error("promotion evidence verifiedAt 必须是标准 ISO 时间");
  }
  const agent = state.draftAgents.find((item) => item.id === agentId);
  if (!agent) throw new Error(`未找到 ${agentId} draft 配置`);
  const requestKind = getCapabilityFamilyForAgent(agentId).requestKind;
  const primary = candidateBindingFor(state, agent, "primary", requestKind);
  const fallback = candidateBindingFor(state, agent, "fallback", requestKind);
  if (primary.promptContentSha256 !== fallback.promptContentSha256
    || primary.draftConfigSha256 !== fallback.draftConfigSha256
    || primary.goldenSetSha256 !== fallback.goldenSetSha256
    || primary.codeVersion !== fallback.codeVersion) {
    throw new Error("主备候选 binding 不一致，拒绝写入发布证据");
  }
  return {
    schemaVersion: 1,
    agentId,
    requestKind,
    primary: {
      candidateKey: primary.candidateKey,
      evaluationFingerprint: primary.evaluationFingerprint,
    },
    fallback: {
      candidateKey: fallback.candidateKey,
      evaluationFingerprint: fallback.evaluationFingerprint,
    },
    promptContentSha256: primary.promptContentSha256,
    draftConfigSha256: primary.draftConfigSha256,
    goldenSetSha256: primary.goldenSetSha256,
    codeVersion: primary.codeVersion,
    verifiedAt,
  };
}

function isCompleteGoldenRecord(record: AgentEvalRecord): record is AgentEvalRecord & {
  evaluationKind: "golden";
  caseId: string;
  candidateKey: string;
  requestKind: AgentEvalRequestKind;
  structurePassed: boolean | null;
  qualityScore: number | null;
  actualCostUsd: number | null;
  evaluationFingerprint: string;
  promptContentSha256: string;
  draftConfigSha256: string;
  goldenSetSha256: string;
  codeVersion: string;
} {
  return record.evaluationKind === "golden"
    && typeof record.caseId === "string"
    && typeof record.candidateKey === "string"
    && typeof record.requestKind === "string"
    && REQUEST_KINDS.has(record.requestKind as AgentEvalRequestKind)
    && (typeof record.structurePassed === "boolean" || record.structurePassed === null)
    && (typeof record.qualityScore === "number" || record.qualityScore === null)
    && (typeof record.actualCostUsd === "number" || record.actualCostUsd === null)
    && typeof record.status === "string"
    && ((record.status === "failed" && record.errored)
      || (record.status === "completed" && !record.errored)
      || (record.status === "awaiting-human-review" && !record.errored && record.qualityScore === null))
    && typeof record.evaluationFingerprint === "string" && SHA256.test(record.evaluationFingerprint)
    && typeof record.promptContentSha256 === "string" && SHA256.test(record.promptContentSha256)
    && typeof record.draftConfigSha256 === "string" && SHA256.test(record.draftConfigSha256)
    && typeof record.goldenSetSha256 === "string" && SHA256.test(record.goldenSetSha256)
    && typeof record.codeVersion === "string" && Boolean(record.codeVersion.trim());
}

export function buildPromotionSummaries(state: AgentStrategyState): GoldenEvalPromotionDto[] {
  const groups = new Map<string, Array<ReturnType<typeof toTrial>>>();
  for (const record of state.evals) {
    if (!isCompleteGoldenRecord(record)) continue;
    let goldenCase: GoldenCase;
    try {
      goldenCase = getGoldenCase(record.caseId);
    } catch {
      continue;
    }
    if (goldenCase.agentId !== record.agentId) continue;
    const expectedRequestKind = getCapabilityFamilyForAgent(record.agentId).requestKind;
    if (record.requestKind !== expectedRequestKind) continue;
    if (record.candidateRole !== "primary" && record.candidateRole !== "fallback") continue;
    const draft = state.draftAgents.find((agent) => agent.id === record.agentId);
    if (!draft) continue;
    let binding: GoldenCandidateBinding;
    try {
      binding = candidateBindingFor(state, draft, record.candidateRole, record.requestKind);
    } catch {
      continue;
    }
    if (record.candidateKey !== binding.candidateKey
      || record.evaluationFingerprint !== binding.evaluationFingerprint
      || record.promptContentSha256 !== binding.promptContentSha256
      || record.draftConfigSha256 !== binding.draftConfigSha256
      || record.goldenSetSha256 !== binding.goldenSetSha256
      || record.codeVersion !== binding.codeVersion
      || record.provider !== draft[record.candidateRole].provider
      || record.candidateModel !== effectiveCandidateModel(draft, record.candidateRole, record.requestKind)
      || record.promptVersion !== draft.promptVersion) continue;
    if (goldenCase.outputKind === "media" && !record.errored) {
      const metadata = record.artifactMetadata;
      if (!Array.isArray(metadata) || metadata.length < goldenCase.requiredShape.minimumArtifacts) continue;
      if (!Array.isArray(record.artifactUrls)
        || metadata.some((artifact) => !record.artifactUrls?.includes(artifact.url))) continue;
    }
    const groupKey = `${record.agentId}\u0000${record.candidateKey}`;
    const trials = groups.get(groupKey) ?? [];
    trials.push(toTrial(record));
    groups.set(groupKey, trials);
  }

  const summaries: GoldenEvalPromotionDto[] = [];
  for (const trialsWithRecord of groups.values()) {
    const trials = trialsWithRecord.map((item) => item.trial);
    const first = trialsWithRecord[0].record;
    let metrics;
    let decision;
    try {
      metrics = aggregatePromotionMetrics(trials);
      decision = evaluatePromotion(metrics, INVITE_BETA_PROMOTION_THRESHOLDS[first.requestKind]);
    } catch {
      // 旧版/损坏记录不能让整个管理页失效，也绝不把它算作通过。
      continue;
    }
    const coveredCaseIds = [...new Set(trials.map((trial) => trial.caseId))].sort();
    const requiredCaseIds = getGoldenCasesForAgent(first.agentId).map((item) => item.id).sort();
    const missingCases = requiredCaseIds.filter((caseId) => !coveredCaseIds.includes(caseId));
    summaries.push({
      agentId: first.agentId,
      candidateKey: first.candidateKey,
      requestKind: first.requestKind,
      sampleCount: metrics.sampleCount,
      distinctCaseCount: metrics.distinctCaseCount,
      successRate: metrics.successRate,
      structurePassRate: metrics.structurePassRate,
      qualityCoverageRate: metrics.qualityCoverageRate,
      qualityScore: metrics.qualityScore,
      p95LatencyMs: metrics.p95LatencyMs,
      costCoverageRate: metrics.costCoverageRate,
      averageActualCostUsd: metrics.averageActualCostUsd,
      coveredCaseIds,
      requiredCaseIds,
      passed: decision.passed && missingCases.length === 0,
      failures: [
        ...decision.failures.map((failure) => failure.message),
        ...(missingCases.length ? [`Golden case 覆盖不足：${missingCases.join(", ")}`] : []),
      ],
    });
  }
  return summaries.sort((left, right) =>
    left.agentId.localeCompare(right.agentId) || left.candidateKey.localeCompare(right.candidateKey));
}

export interface DraftPromotionCandidateDecision {
  role: AgentEndpointRole;
  candidateKey: string;
  passed: boolean;
  summary: GoldenEvalPromotionDto | null;
  failures: string[];
}

export interface DraftPromotionDecision {
  agentId: AgentId;
  enforced: boolean;
  passed: boolean;
  candidates: DraftPromotionCandidateDecision[];
  failures: string[];
}

/**
 * 供发布服务调用的无写入决策函数。生产默认 fail-closed：当前 draft
 * primary 和 fallback 都必须有与当前修订精确匹配的通过记录。开发环境可跳过门禁，
 * 但仍返回真实候选决策便于 UI/测试观察。
 */
export function getPromotionDecisionForDraft(
  state: AgentStrategyState,
  agentId: AgentId,
  options: { production?: boolean } = {},
): DraftPromotionDecision {
  const production = options.production ?? process.env.NODE_ENV === "production";
  const agent = state.draftAgents.find((item) => item.id === agentId);
  if (!agent) {
    return {
      agentId,
      enforced: production,
      passed: !production,
      candidates: [],
      failures: [`未找到 ${agentId} draft 配置`],
    };
  }
  const requestKind = getCapabilityFamilyForAgent(agentId).requestKind;
  const summaries = buildPromotionSummaries(state);
  const candidates = (["primary", "fallback"] as const).map((role): DraftPromotionCandidateDecision => {
    const candidateKey = candidateKeyFor(state, agent, role, requestKind);
    const summary = summaries.find((item) => item.agentId === agentId && item.candidateKey === candidateKey) ?? null;
    return {
      role,
      candidateKey,
      passed: summary?.passed === true,
      summary,
      failures: summary ? summary.failures : ["当前 draft 候选没有通过 Golden Set 的评测记录"],
    };
  });
  const failures = candidates.flatMap((candidate) => candidate.passed
    ? []
    : candidate.failures.map((failure) => `${candidate.role}: ${failure}`));
  return {
    agentId,
    enforced: production,
    passed: production ? failures.length === 0 : true,
    candidates,
    failures,
  };
}

/**
 * 生产发布前对所有参与当前候选晋级的媒体记录重算文件哈希并 ffprobe。
 * 评分后被替换、截断或删除的产物不得继续放行。
 */
export async function verifyDraftPromotionArtifacts(
  state: AgentStrategyState,
  agentId: AgentId,
) {
  const agent = state.draftAgents.find((item) => item.id === agentId);
  if (!agent) throw new Error(`未找到 ${agentId} draft 配置`);
  const requestKind = getCapabilityFamilyForAgent(agentId).requestKind;
  if (requestKind !== "image-generation" && requestKind !== "video-generation" && requestKind !== "tts-generation") return;

  for (const role of ["primary", "fallback"] as const) {
    const binding = candidateBindingFor(state, agent, role, requestKind);
    const records = state.evals.filter((record) =>
      isCompleteGoldenRecord(record)
      && record.agentId === agentId
      && record.candidateKey === binding.candidateKey
      && record.status === "completed"
      && !record.errored
      && record.qualityScore !== null);
    if (!records.length) throw new Error(`${role} 候选没有可复核的媒体评测记录`);
    for (const record of records) {
      const goldenCase = getGoldenCase(record.caseId!);
      if (goldenCase.outputKind !== "media") throw new Error("媒体候选关联了非媒体 case");
      await verifyGoldenArtifacts(
        record.id,
        record.artifactUrls ?? [],
        goldenCase.requiredShape.mediaType,
        record.artifactMetadata ?? [],
      );
    }
  }
}

function toTrial(record: AgentEvalRecord & {
  evaluationKind: "golden";
  caseId: string;
  candidateKey: string;
  requestKind: AgentEvalRequestKind;
  structurePassed: boolean | null;
  qualityScore: number | null;
  actualCostUsd: number | null;
}) {
  const trial: GoldenTrialResult = {
    candidateKey: record.candidateKey,
    caseId: record.caseId,
    runId: record.id,
    success: !record.errored,
    structurePassed: record.structurePassed,
    qualityScore: record.qualityScore,
    latencyMs: record.latencyMs,
    actualCostUsd: record.actualCostUsd,
  };
  return { trial, record };
}
