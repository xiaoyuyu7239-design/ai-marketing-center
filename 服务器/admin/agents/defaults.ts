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

const VOLCENGINE_TTS_BASE_URL = "https://openspeech.bytedance.com/api/v3/tts";
const VOLCENGINE_TTS_MODEL = "seed-tts-2.0";
const VOLCENGINE_TTS_VOICE = "zh_female_vv_uranus_bigtts";

function revisionEvidence(prefix: string): Pick<
  ModelEndpointConfig,
  "deploymentRevision" | "revisionEvidenceFile" | "revisionEvidenceSha256"
> {
  const revision = process.env[`${prefix}_DEPLOYMENT_REVISION`]?.trim();
  const file = process.env[`${prefix}_REVISION_EVIDENCE_FILE`]?.trim();
  const sha256 = process.env[`${prefix}_REVISION_EVIDENCE_SHA256`]?.trim().toLowerCase();
  return {
    ...(revision ? { deploymentRevision: revision } : {}),
    ...(file ? { revisionEvidenceFile: file } : {}),
    ...(sha256 ? { revisionEvidenceSha256: sha256 } : {}),
  };
}

function envEndpoint(modelFallback: string, visionFallback?: string): ModelEndpointConfig {
  return {
    provider: process.env.CLIPFORGE_LLM_PROVIDER || "openai-compatible",
    baseUrl: process.env.CLIPFORGE_LLM_BASE_URL || "",
    secretRef: "llm.primary",
    model: process.env.CLIPFORGE_LLM_MODEL || modelFallback,
    visionModel: process.env.CLIPFORGE_LLM_VISION_MODEL || visionFallback,
    ...revisionEvidence("CLIPFORGE_LLM"),
  };
}

function fallbackEndpoint(modelFallback: string): ModelEndpointConfig {
  return {
    provider: process.env.CLIPFORGE_LLM_FALLBACK_PROVIDER || process.env.CLIPFORGE_LLM_PROVIDER || "openai-compatible",
    baseUrl: process.env.CLIPFORGE_LLM_FALLBACK_BASE_URL || process.env.CLIPFORGE_LLM_BASE_URL || "",
    secretRef: "llm.fallback",
    model: process.env.CLIPFORGE_LLM_FALLBACK_MODEL || modelFallback,
    visionModel: process.env.CLIPFORGE_LLM_FALLBACK_VISION_MODEL || process.env.CLIPFORGE_LLM_VISION_MODEL,
    ...revisionEvidence("CLIPFORGE_LLM_FALLBACK"),
  };
}

function mediaEndpoint(kind: "IMAGE" | "VIDEO", modelFallback: string): ModelEndpointConfig {
  return {
    provider: process.env[`CLIPFORGE_${kind}_PROVIDER`] || process.env.CLIPFORGE_AI_PROVIDER || "atlas-cloud",
    baseUrl: process.env[`CLIPFORGE_${kind}_BASE_URL`] || process.env.CLIPFORGE_AI_BASE_URL || ATLAS_BASE_URL,
    secretRef: kind === "IMAGE" ? "image.primary" : "video.primary",
    model: process.env[`CLIPFORGE_${kind}_MODEL`] || modelFallback,
    ...revisionEvidence(`CLIPFORGE_${kind}`),
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
    secretRef: kind === "IMAGE" ? "image.fallback" : "video.fallback",
    model: process.env[`CLIPFORGE_${kind}_FALLBACK_MODEL`] || modelFallback,
    ...revisionEvidence(`CLIPFORGE_${kind}_FALLBACK`),
  };
}

function ttsEndpoint(
  modelFallback = VOLCENGINE_TTS_MODEL,
  voiceFallback = VOLCENGINE_TTS_VOICE,
): ModelEndpointConfig {
  return {
    provider: process.env.CLIPFORGE_TTS_PROVIDER || "volcengine",
    baseUrl: process.env.CLIPFORGE_TTS_BASE_URL || VOLCENGINE_TTS_BASE_URL,
    secretRef: "tts.primary",
    model: process.env.CLIPFORGE_TTS_MODEL || modelFallback,
    ...revisionEvidence("CLIPFORGE_TTS"),
    voice: process.env.CLIPFORGE_TTS_VOICE || voiceFallback,
    ...(process.env.CLIPFORGE_TTS_GROUP_ID ? { groupId: process.env.CLIPFORGE_TTS_GROUP_ID } : {}),
    ...(process.env.CLIPFORGE_TTS_SPEED ? { speed: Number(process.env.CLIPFORGE_TTS_SPEED) } : {}),
  };
}

function ttsFallbackEndpoint(): ModelEndpointConfig {
  return {
    provider: process.env.CLIPFORGE_TTS_FALLBACK_PROVIDER || process.env.CLIPFORGE_TTS_PROVIDER || "openai",
    baseUrl: process.env.CLIPFORGE_TTS_FALLBACK_BASE_URL || process.env.CLIPFORGE_TTS_BASE_URL || "https://api.siliconflow.cn/v1",
    secretRef: "tts.fallback",
    model: process.env.CLIPFORGE_TTS_FALLBACK_MODEL || process.env.CLIPFORGE_TTS_MODEL || "FunAudioLLM/CosyVoice2-0.5B",
    ...revisionEvidence("CLIPFORGE_TTS_FALLBACK"),
    voice: process.env.CLIPFORGE_TTS_FALLBACK_VOICE || process.env.CLIPFORGE_TTS_VOICE || "FunAudioLLM/CosyVoice2-0.5B:alex",
    ...(process.env.CLIPFORGE_TTS_FALLBACK_GROUP_ID ? { groupId: process.env.CLIPFORGE_TTS_FALLBACK_GROUP_ID } : {}),
  };
}

export function defaultPrompt(agentId: AgentId) {
  if (agentId === "topic-script") return TOPIC_SYSTEM_PROMPT;
  if (agentId === "product-analysis") return PRODUCT_ANALYSIS_PROMPT;
  if (agentId === "publish-copy") {
    return [
      "你是短视频发布运营专家，为带货视频生成标题、话题标签和种草文案。",
      "",
      "【创作原则】",
      "- 标题口语化、有吸引力，15字以内，含核心关键词",
      "- 话题标签精准（第一个为品类大标签，后面是场景/卖点标签），3-5个",
      "- 种草文案像真人分享而非广告，50字以内",
      "- 禁止使用\"绝绝子\"\"yyds\"\"家人们\"\"宝子们\"等过时表达",
      "- 互动引导要自然不生硬",
      "",
      "只输出合法 JSON，不输出解释。",
    ].join("\n");
  }
  if (agentId === "publish-ranker") {
    return [
      "你是短视频发布择优 Agent，服务三四线城市中小店铺店主。",
      "",
      "【推荐原则】",
      "- 优先推荐今天最容易看懂、最可能带来咨询或成交的视频",
      "- 结合库存内容、商品卖点、历史发布数据和用户选择的策略",
      "- 避免连续多天推荐同一商品（除非该商品近期转化数据显著走强）",
      "- 平衡多样性：不同品类、不同风格的视频轮流推荐",
      "",
      "只输出合法 JSON，不输出解释。",
      "输出格式：{\"items\":[{\"id\":\"项目ID\",\"reason\":\"12字以内中文理由\"}]}",
    ].join("\n");
  }
  if (agentId === "diagnose") {
    return [
      "你是短视频发布前诊断 Agent，服务三四线城市中小店铺店主，在发布前按维度评审带货短视频脚本。",
      "",
      "【评审原则】",
      "- 按抖音带货短视频的实战标准打分，分数敢高敢低，不和稀泥",
      "- 五个维度：hook 开场钩子（前3秒能不能留住人）、clarity 卖点清晰度（看完知不知道为什么买）、pacing 节奏时长（有没有拖沓/塞太满）、copy 文案可读性（口播是否口语化、字幕好不好读）、cta 行动号召（有没有给出明确下一步）",
      "- 每维 0-100：80+ 达到爆款常见水准，60-79 及格可发，40-59 建议先改，40 以下明显缺陷",
      "- 每维评语 30 字以内点中要害；改进建议每条 30 字以内，直接说怎么改，不讲大道理",
      "- 评语和建议必须说大白话：像老师傅口头指点，不用任何运营术语（如'完播率''转化路径''用户心智'），没做过运营的店主一眼就懂",
      "- 不预测播放量数字，不承诺效果",
      "",
      "只输出合法 JSON，不输出解释。",
      "输出格式：{\"dimensions\":[{\"key\":\"hook\",\"score\":72,\"comment\":\"评语\"}],\"summary\":\"一句话总评\",\"suggestions\":[\"建议1\",\"建议2\"]}",
    ].join("\n");
  }
  if (agentId === "retro") {
    return [
      "你是短视频复盘 Agent，服务三四线城市中小店铺店主：视频发布并回填真实数据后，帮老板总结这条哪里好、哪里差、下一条怎么改。",
      "",
      "【复盘原则】",
      "- 结合发布前体检分、实际数据、账号平时水平一起看，别只盯播放量高低",
      "- 说大白话：像老师傅口头指点，不用任何运营术语（如'完播率''转化路径''用户心智'），没做过运营的店主一眼就懂",
      "- 结论是'下条试试'的建议，不是定论——数据少时留有余地，别把一条视频的偶然当规律",
      "- highlights（做对了什么）/issues（哪里拖后腿）各最多 3 条、每条 25 字以内",
      "- nextActions（下条试试）最多 3 条、每条 25 字以内，要具体到能直接照着做",
      "- summary 一句话 40 字以内",
      "",
      "只输出合法 JSON，不输出解释。",
      "输出格式：{\"highlights\":[\"...\"],\"issues\":[\"...\"],\"nextActions\":[\"...\"],\"summary\":\"...\"}",
    ].join("\n");
  }
  if (agentId === "weekly-report") {
    return [
      "你是账号周报 Agent，服务三四线城市中小店铺店主：把算好的一周数据讲成店主一眼能懂的周报。",
      "",
      "【写作原则】",
      "- 数字都是系统算好的，你只负责讲成人话，不要自己算数、不要编数字",
      "- 说大白话：像老师傅聊天，不用任何运营术语（如'完播率''转化漏斗''自然流量'）",
      "- highlights（这周的亮点）/watchouts（要注意的）各最多 3 条、每条 25 字以内",
      "- nextActions（下周怎么干）最多 3 条、每条 25 字以内，具体到能直接照做；近期复盘经验要优先体现",
      "- summary 一句话 40 字以内，先说结果再说趋势",
      "- 数据少就实话实说'数据还少看不准'，不硬夸也不吓唬",
      "",
      "只输出合法 JSON，不输出解释。",
      "输出格式：{\"highlights\":[\"...\"],\"watchouts\":[\"...\"],\"nextActions\":[\"...\"],\"summary\":\"...\"}",
    ].join("\n");
  }
  if (agentId === "metrics-ocr") {
    return [
      "你是数据截图识别 Agent：从短视频平台（抖音为主）的数据截图里读出这条视频的成绩数字。",
      "",
      "【识别要求】",
      "- 找出：播放/观看量(views)、点赞(likes)、评论(comments)、转发/分享(shares)、成交/销量(orders)",
      "- 数字保留截图原样（如「1.2万」原样返回字符串），认不清、被遮挡的字段返回 null，绝不编造",
      "- 能看出平台就返回其一：douyin/kuaishou/xiaohongshu/tiktok，看不出返回 null",
      "- 如果这不是数据页截图（如聊天记录、商品页），所有字段返回 null",
      "",
      "只输出合法 JSON，不输出解释。",
      "输出格式：{\"platform\":\"douyin\",\"views\":\"1.2万\",\"likes\":345,\"comments\":12,\"shares\":8,\"orders\":null}",
    ].join("\n");
  }
  if (agentId === "imageAgent") {
    return [
      "你是短视频素材生成 Agent，按分镜 prompt 生成竖屏带货素材图。",
      "要求：画面干净、主体突出、竖屏9:16构图、避免出现人脸（除非明确要求真人出镜模式）、商品图保持真实不扭曲。",
    ].join(" ");
  }
  if (agentId === "videoAgent") {
    return [
      "你是短视频动态镜头 Agent，按分镜 prompt 和首帧生成短视频动态素材。",
      "要求：镜头运动流畅、画面平稳、商品主体不变形、避免生成人脸（除非明确要求真人出镜模式）。",
    ].join(" ");
  }
  if (agentId === "ttsAgent") return "你是短视频配音 Agent，为分镜旁白生成语音：发音清晰、语速自然、情感匹配内容基调。";
  return SYSTEM_PROMPT;
}

export function defaultState(): AgentStrategyState {
  const stamp = nowIso();
  const agentSeeds: Omit<AgentConfig, "strategyRevision">[] = [
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
      id: "diagnose",
      name: "发布前诊断 Agent",
      description: "发布前按维度评审脚本给出诊断分与改进建议，结合账号历史回流数据做相对表现预测。",
      primary: envEndpoint("gpt-4o"),
      fallback: fallbackEndpoint("gpt-4o-mini"),
      promptVersion: "diagnose-v1",
      enabled: true,
      successRate: 0.95,
      avgLatencyMs: 2800,
      updatedAt: stamp,
    },
    {
      id: "retro",
      name: "复盘总结 Agent",
      description: "结合发布前诊断、实际回流数据和账号基线，为单条视频生成复盘（亮点/问题/下条怎么改）。",
      primary: envEndpoint("gpt-4o"),
      fallback: fallbackEndpoint("gpt-4o-mini"),
      promptVersion: "retro-v1",
      enabled: true,
      successRate: 0.95,
      avgLatencyMs: 3000,
      updatedAt: stamp,
    },
    {
      id: "weekly-report",
      name: "账号周报 Agent",
      description: "汇总近 7 天回流数据、风格洞察与复盘经验，生成账号级大白话周报。",
      primary: envEndpoint("gpt-4o"),
      fallback: fallbackEndpoint("gpt-4o-mini"),
      promptVersion: "weekly-v1",
      enabled: true,
      successRate: 0.96,
      avgLatencyMs: 2600,
      updatedAt: stamp,
    },
    {
      id: "metrics-ocr",
      name: "数据截图识别 Agent",
      description: "把平台数据截图识别成播放/点赞/评论等数字，预填效果回流表单，降低回填摩擦。",
      primary: envEndpoint("gpt-4o", process.env.CLIPFORGE_LLM_VISION_MODEL || "gpt-4o"),
      fallback: fallbackEndpoint("gpt-4o-mini"),
      promptVersion: "metrics-ocr-v1",
      enabled: true,
      successRate: 0.94,
      avgLatencyMs: 3200,
      updatedAt: stamp,
    },
    {
      id: "imageAgent",
      name: "图片素材 Agent",
      description: "按分镜 prompt 生成图片素材，支持商品保真图生图。",
      primary: mediaEndpoint("IMAGE", ATLAS_ONEKEY_MODELS.image),
      // Golden 商品图用例锁定图生图；默认值也必须是明确的 edit mode，
      // 否则会在付费前的能力预检中拒绝。生产仍必须用环境变量换成跨供应商 fallback。
      fallback: mediaFallbackEndpoint("IMAGE", "openai/gpt-image-2/edit"),
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

  const agents: AgentConfig[] = agentSeeds.map((agent) => ({
    ...agent,
    strategyRevision: 1,
  }));

  const prompts = agents.map<AgentPromptVersion>((agent) => ({
    id: uid("prompt"),
    agentId: agent.id,
    version: agent.promptVersion,
    content: defaultPrompt(agent.id),
    status: "online",
    updatedAt: stamp,
  }));

  return {
    strategyRevision: 1,
    onlineVersion: "strategy-v1",
    draftVersion: "strategy-draft",
    publishedAt: stamp,
    agents,
    draftAgents: agents.map((agent) => ({
      ...agent,
      primary: { ...agent.primary },
      fallback: { ...agent.fallback },
    })),
    previousAgents: {},
    prompts,
    // 不种入伪造的调用/成本数据；运行记录必须来自真实 attempt。
    runs: [],
    evals: [],
    audit: [],
  };
}
