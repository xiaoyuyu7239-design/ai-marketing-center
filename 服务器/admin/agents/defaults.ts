import "server-only";

import {
  ATLAS_BASE_URL,
  ATLAS_ONEKEY_MODELS,
} from "@backend/core/stock/atlas-onekey";
import {
  PRODUCT_ANALYSIS_PROMPT,
  SYSTEM_PROMPT,
  TOPIC_SYSTEM_PROMPT,
} from "@backend/script-engine/prompts";
import type {
  AgentConfig,
  AgentId,
  AgentPromptVersion,
  AgentStrategyState,
  ModelEndpointConfig,
} from "./types";
import { nowIso, uid } from "./utils";

function envEndpoint(modelFallback: string, visionFallback?: string): ModelEndpointConfig {
  return {
    provider: process.env.CLIPFORGE_LLM_PROVIDER || "openai-compatible",
    baseUrl: process.env.CLIPFORGE_LLM_BASE_URL || "",
    apiKey: process.env.CLIPFORGE_LLM_API_KEY || "",
    model: process.env.CLIPFORGE_LLM_MODEL || modelFallback,
    visionModel: process.env.CLIPFORGE_LLM_VISION_MODEL || visionFallback,
  };
}

function fallbackEndpoint(modelFallback: string): ModelEndpointConfig {
  return {
    provider: process.env.CLIPFORGE_LLM_FALLBACK_PROVIDER || process.env.CLIPFORGE_LLM_PROVIDER || "openai-compatible",
    baseUrl: process.env.CLIPFORGE_LLM_FALLBACK_BASE_URL || process.env.CLIPFORGE_LLM_BASE_URL || "",
    apiKey: process.env.CLIPFORGE_LLM_FALLBACK_API_KEY || process.env.CLIPFORGE_LLM_API_KEY || "",
    model: process.env.CLIPFORGE_LLM_FALLBACK_MODEL || modelFallback,
    visionModel: process.env.CLIPFORGE_LLM_FALLBACK_VISION_MODEL || process.env.CLIPFORGE_LLM_VISION_MODEL,
  };
}

function mediaEndpoint(kind: "IMAGE" | "VIDEO", modelFallback: string): ModelEndpointConfig {
  return {
    provider: process.env[`CLIPFORGE_${kind}_PROVIDER`] || process.env.CLIPFORGE_AI_PROVIDER || "atlas-cloud",
    baseUrl: process.env[`CLIPFORGE_${kind}_BASE_URL`] || process.env.CLIPFORGE_AI_BASE_URL || ATLAS_BASE_URL,
    apiKey: process.env[`CLIPFORGE_${kind}_API_KEY`] || process.env.CLIPFORGE_AI_API_KEY || process.env.ATLAS_API_KEY || "",
    model: process.env[`CLIPFORGE_${kind}_MODEL`] || modelFallback,
  };
}

function mediaFallbackEndpoint(kind: "IMAGE" | "VIDEO", modelFallback: string): ModelEndpointConfig {
  return {
    provider:
      process.env[`CLIPFORGE_${kind}_FALLBACK_PROVIDER`] ||
      process.env[`CLIPFORGE_${kind}_PROVIDER`] ||
      process.env.CLIPFORGE_AI_PROVIDER ||
      "atlas-cloud",
    baseUrl:
      process.env[`CLIPFORGE_${kind}_FALLBACK_BASE_URL`] ||
      process.env[`CLIPFORGE_${kind}_BASE_URL`] ||
      process.env.CLIPFORGE_AI_BASE_URL ||
      ATLAS_BASE_URL,
    apiKey:
      process.env[`CLIPFORGE_${kind}_FALLBACK_API_KEY`] ||
      process.env[`CLIPFORGE_${kind}_API_KEY`] ||
      process.env.CLIPFORGE_AI_API_KEY ||
      process.env.ATLAS_API_KEY ||
      "",
    model: process.env[`CLIPFORGE_${kind}_FALLBACK_MODEL`] || modelFallback,
  };
}

function ttsEndpoint(modelFallback = "xai/tts-v1", voiceFallback = "eve"): ModelEndpointConfig {
  return {
    provider: process.env.CLIPFORGE_TTS_PROVIDER || "atlas",
    baseUrl: process.env.CLIPFORGE_TTS_BASE_URL || ATLAS_BASE_URL,
    apiKey: process.env.CLIPFORGE_TTS_API_KEY || process.env.ATLAS_API_KEY || "",
    model: process.env.CLIPFORGE_TTS_MODEL || modelFallback,
    voice: process.env.CLIPFORGE_TTS_VOICE || voiceFallback,
    ...(process.env.CLIPFORGE_TTS_GROUP_ID ? { groupId: process.env.CLIPFORGE_TTS_GROUP_ID } : {}),
    ...(process.env.CLIPFORGE_TTS_SPEED ? { speed: Number(process.env.CLIPFORGE_TTS_SPEED) } : {}),
  };
}

function ttsFallbackEndpoint(): ModelEndpointConfig {
  return {
    provider: process.env.CLIPFORGE_TTS_FALLBACK_PROVIDER || process.env.CLIPFORGE_TTS_PROVIDER || "openai",
    baseUrl: process.env.CLIPFORGE_TTS_FALLBACK_BASE_URL || process.env.CLIPFORGE_TTS_BASE_URL || "https://api.siliconflow.cn/v1",
    apiKey: process.env.CLIPFORGE_TTS_FALLBACK_API_KEY || process.env.CLIPFORGE_TTS_API_KEY || "",
    model: process.env.CLIPFORGE_TTS_FALLBACK_MODEL || process.env.CLIPFORGE_TTS_MODEL || "FunAudioLLM/CosyVoice2-0.5B",
    voice: process.env.CLIPFORGE_TTS_FALLBACK_VOICE || process.env.CLIPFORGE_TTS_VOICE || "FunAudioLLM/CosyVoice2-0.5B:alex",
    ...(process.env.CLIPFORGE_TTS_FALLBACK_GROUP_ID ? { groupId: process.env.CLIPFORGE_TTS_FALLBACK_GROUP_ID } : {}),
  };
}

export function defaultPrompt(agentId: AgentId) {
  if (agentId === "topic-script") return TOPIC_SYSTEM_PROMPT;
  if (agentId === "product-analysis") return PRODUCT_ANALYSIS_PROMPT;
  if (agentId === "publish-copy") return "你是短视频发布运营，只输出合法 JSON，不输出解释。";
  if (agentId === "publish-ranker") {
    return [
      "你是短视频发布择优 Agent，只输出合法 JSON，不输出解释。",
      "你服务三四线城市中小店铺店主：优先选择今天最容易看懂、最可能带来咨询或成交的视频。",
      "你要结合库存内容、商品卖点、历史发布数据、用户选择的策略，推荐今日待发布视频。",
      "输出格式：{\"items\":[{\"id\":\"项目ID\",\"reason\":\"12字以内中文理由\"}]}。",
    ].join("\n");
  }
  if (agentId === "imageAgent") return "你是短视频素材生成 Agent，负责按分镜 prompt 生成竖屏带货素材图。";
  if (agentId === "videoAgent") return "你是短视频动态镜头 Agent，负责按分镜 prompt 和首帧生成短视频素材。";
  if (agentId === "ttsAgent") return "你是短视频配音 Agent，负责为分镜旁白生成清晰自然的音频。";
  return SYSTEM_PROMPT;
}

export function defaultState(): AgentStrategyState {
  const stamp = nowIso();
  const agents: AgentConfig[] = [
    {
      id: "script",
      name: "带货脚本 Agent",
      description: "根据商品资料生成多套带货短视频分镜脚本。",
      primary: envEndpoint("gpt-4o", process.env.CLIPFORGE_LLM_VISION_MODEL || "gpt-4o"),
      fallback: fallbackEndpoint("gpt-4o-mini"),
      promptVersion: "script-v1",
      enabled: true,
      successRate: 0.96,
      avgLatencyMs: 5200,
      updatedAt: stamp,
    },
    {
      id: "topic-script",
      name: "主题成片 Agent",
      description: "把一句话主题扩写为旁白脚本，并给每个分镜生成素材检索词。",
      primary: envEndpoint("gpt-4o"),
      fallback: fallbackEndpoint("gpt-4o-mini"),
      promptVersion: "topic-v1",
      enabled: true,
      successRate: 0.94,
      avgLatencyMs: 4800,
      updatedAt: stamp,
    },
    {
      id: "product-analysis",
      name: "商品理解 Agent",
      description: "分析商品图片与卖点，给脚本生成提供结构化商品洞察。",
      primary: envEndpoint("gpt-4o", process.env.CLIPFORGE_LLM_VISION_MODEL || "gpt-4o"),
      fallback: fallbackEndpoint("gpt-4o-mini"),
      promptVersion: "analysis-v1",
      enabled: true,
      successRate: 0.93,
      avgLatencyMs: 3600,
      updatedAt: stamp,
    },
    {
      id: "publish-copy",
      name: "发布文案 Agent",
      description: "生成标题、话题标签与种草文案，服务导出发布流程。",
      primary: envEndpoint("gpt-4o"),
      fallback: fallbackEndpoint("gpt-4o-mini"),
      promptVersion: "publish-v1",
      enabled: true,
      successRate: 0.97,
      avgLatencyMs: 2200,
      updatedAt: stamp,
    },
    {
      id: "publish-ranker",
      name: "发布择优 Agent",
      description: "结合生成库存、发布效果回流和今日目标，挑选待发布视频。",
      primary: envEndpoint("gpt-4o"),
      fallback: fallbackEndpoint("gpt-4o-mini"),
      promptVersion: "ranker-v1",
      enabled: true,
      successRate: 0.95,
      avgLatencyMs: 2600,
      updatedAt: stamp,
    },
    {
      id: "imageAgent",
      name: "图片素材 Agent",
      description: "按分镜 prompt 生成图片素材，支持商品保真图生图。",
      primary: mediaEndpoint("IMAGE", ATLAS_ONEKEY_MODELS.image),
      fallback: mediaFallbackEndpoint("IMAGE", "bytedance/seedream-v5.0-lite"),
      promptVersion: "image-v1",
      enabled: true,
      successRate: 0.95,
      avgLatencyMs: 12000,
      updatedAt: stamp,
    },
    {
      id: "videoAgent",
      name: "动态镜头 Agent",
      description: "把静态图或文本分镜生成动态视频镜头。",
      primary: mediaEndpoint("VIDEO", ATLAS_ONEKEY_MODELS.video),
      fallback: mediaFallbackEndpoint("VIDEO", "bytedance/seedance-2.0-fast/image-to-video"),
      promptVersion: "video-v1",
      enabled: true,
      successRate: 0.9,
      avgLatencyMs: 45000,
      updatedAt: stamp,
    },
    {
      id: "ttsAgent",
      name: "配音 Agent",
      description: "为分镜旁白生成付费 TTS 音频，未配置时用户端仍可走免费配音兜底。",
      primary: ttsEndpoint(),
      fallback: ttsFallbackEndpoint(),
      promptVersion: "tts-v1",
      enabled: true,
      successRate: 0.96,
      avgLatencyMs: 3000,
      updatedAt: stamp,
    },
  ];

  const prompts = agents.map<AgentPromptVersion>((agent) => ({
    id: uid("prompt"),
    agentId: agent.id,
    version: agent.promptVersion,
    content: defaultPrompt(agent.id),
    status: "online",
    updatedAt: stamp,
  }));

  return {
    onlineVersion: "strategy-v1",
    draftVersion: "strategy-draft",
    publishedAt: stamp,
    agents,
    prompts,
    runs: [
      {
        id: uid("run"),
        createdAt: stamp,
        userLabel: "system-seed",
        agentId: "script",
        agentName: "带货脚本 Agent",
        provider: "openai-compatible",
        model: "strategy-default",
        promptVersion: "script-v1",
        fallbackTriggered: false,
        success: true,
        latencyMs: 5100,
        costEstimateUsd: 0.024,
      },
    ],
    evals: [],
  };
}
