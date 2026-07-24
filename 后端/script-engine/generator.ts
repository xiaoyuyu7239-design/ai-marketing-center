/**
 * 脚本生成器
 * 使用 OpenAI 兼容格式调用 LLM 生成带货短视频脚本
 * 支持自定义 LLM endpoint、流式输出、商品图片分析
 */

import OpenAI from "openai";
import { createSafeOpenAIClient } from "@backend/shared/openai-client";
import {
  SYSTEM_PROMPT,
  PRODUCT_ANALYSIS_PROMPT,
  TOPIC_SYSTEM_PROMPT,
  CONTENT_STRATEGY_GUIDE,
  CATEGORY_VISUAL_GUIDE,
  PACING_GUIDE,
  buildTrendGuide,
  buildLocalStoreGuide,
  MOOD_FILM_GUIDE,
  buildUserPrompt,
  buildBatchPrompt,
  buildTopicBatchPrompt,
  type ScriptGenerationInput,
  type TopicScriptInput,
} from "./prompts";
import type { Shot } from "@backend/db/schema";

// ==================== 类型定义 ====================

/** LLM 配置 */
export interface LLMConfig {
  /** API 地址（兼容 OpenAI 格式的任意 endpoint） */
  baseUrl: string;
  /** API 密钥 */
  apiKey: string;
  /** 文本模型名称 */
  model: string;
  /** 视觉模型名称（用于商品图片分析，不指定则使用 model） */
  visionModel?: string;
  /** 单次请求超时时间（毫秒） */
  timeoutMs?: number;
  /** 单次请求最大输出 token */
  maxTokens?: number;
}

/** 脚本生成输入参数 */
export interface ScriptInput extends ScriptGenerationInput {
  /** LLM 配置 */
  llmConfig: LLMConfig;
  /** 后台 Agent 发布的系统提示词版本；缺省时使用代码内置提示词 */
  systemPrompt?: string;
  /** 生成几套方案；首页快速入口可传 1 提速 */
  count?: number;
  /** 本次生成最大输出 token */
  maxTokens?: number;
  /** 本次生成超时时间（毫秒） */
  timeoutMs?: number;
  /** 轻量快速生成：用于首页首轮出稿，减少提示词与输出体积 */
  quick?: boolean;
}

/** 生成的脚本结果 */
export interface GeneratedScript {
  /** 脚本标题 */
  title: string;
  /** 脚本风格 */
  styleType: string;
  /** 总时长（秒） */
  totalDuration: number;
  /** 分镜列表 */
  shots: Shot[];
}

/** 流式输出回调 */
export interface StreamCallbacks {
  /** 收到文本片段时触发 */
  onToken?: (token: string) => void;
  /** 生成完成时触发 */
  onComplete?: (scripts: GeneratedScript[]) => void;
  /** 发生错误时触发 */
  onError?: (error: Error) => void;
}

/** 商品分析结果 */
export interface ProductAnalysisResult {
  /** 商品名称 */
  productName: string;
  /** 品类 */
  category: string;
  /** 品牌 */
  brand: string;
  /** 视觉特征 */
  visualFeatures: {
    mainColor: string;
    designStyle: string;
    productForm: string;
    texture: string;
  };
  /** 卖点列表 */
  sellingPoints: string[];
  /** 目标用户 */
  targetAudience: string;
  /** 使用场景 */
  usageScenarios: string[];
  /** 痛点 */
  painPoints: string[];
  /** 视频建议 */
  videoSuggestions: {
    recommendedAngles: string[];
    keyVisuals: string[];
    suggestedStyle: string;
  };
}

// ==================== 工具函数 ====================

/** 创建 OpenAI 客户端 */
function createClient(config: LLMConfig, timeoutMs?: number): OpenAI {
  const effectiveTimeoutMs = timeoutMs ?? config.timeoutMs;
  return createSafeOpenAIClient({
    baseURL: config.baseUrl,
    // 本地/免费 OpenAI 兼容端点（Ollama、Pollinations）无需真 Key；SDK 要求非空，缺省给占位符
    apiKey: config.apiKey || "no-key",
    ...(effectiveTimeoutMs ? { timeout: effectiveTimeoutMs } : {}),
  });
}

/**
 * 火山方舟「深度思考」模型默认会先输出长思维链再答，简单请求也要 12s+，常撞脚本/分析的超时墙。
 * 带货脚本、商品分析都不需要模型"思考"，对火山 baseUrl 注入 thinking:disabled，同款接入点响应从 ~12s 降到 ~3s。
 * 仅影响火山（ark…volces.com）；OpenAI / Ollama / Pollinations 等其它端点原样透传，不加此字段。
 * thinking 是火山对 OpenAI 协议的扩展字段，不在 SDK 类型内，故用泛型 as 注入。
 */
export function arkThinkingOff<T extends object>(body: T, baseUrl: string): T {
  const isArk = /ark\.cn-.*volces\.com|volces\.com\/api\/v3/i.test(baseUrl);
  return isArk ? ({ ...body, thinking: { type: "disabled" } } as T) : body;
}

function providerErrorHint(config: LLMConfig, message: string): string {
  const isArk = /ark\.cn-.*volces\.com|volces\.com\/api\/v3/i.test(config.baseUrl);
  if (
    isArk &&
    /InvalidEndpointOrModel|endpoint|model|not found|not exist|does not exist|\b404\b/i.test(message)
  ) {
    return "。火山方舟的 model 字段通常要填写控制台创建的「推理接入点 ID」（一般以 ep- 开头），不是模型展示名；请把文本模型/视觉模型改成你的接入点 ID。";
  }
  return "";
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function requestSignal(timeoutMs?: number): { signal?: AbortSignal; cleanup: () => void } {
  if (!timeoutMs || timeoutMs <= 0) return { cleanup: () => undefined };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    cleanup: () => clearTimeout(timer),
  };
}

function timeoutMessage(e: unknown, timeoutMs?: number) {
  if (e instanceof Error && e.name === "AbortError" && timeoutMs) {
    return `请求超时（${Math.round(timeoutMs / 1000)} 秒），请稍后重试或换用更快的模型接入点`;
  }
  return e instanceof Error ? e.message : String(e);
}

/** 输出语言指令：跟随界面语言（locale），不再按商品/主题文本猜测——英文品名不代表用户要英文脚本 */
function localeHint(locale?: "zh" | "en") {
  return locale === "en"
    ? "Write title, description, camera and voiceover in English. Keep searchTerms in English."
    : "标题、画面描述、镜头、旁白使用中文；searchTerms 和 prompt 使用英文。";
}

/** 抖音节奏：约 1.7 秒一镜、1-3 秒混排（LLM 生成路径用；模板兜底路径仍走 splitDurations 的 4-5 镜） */
function shotCountFor(duration: number) {
  return Math.min(12, Math.max(7, Math.round(duration / 1.7)));
}

function quickProductPrompt(input: ScriptInput): string {
  const duration = clampInt(input.targetDuration, 12, 40, 20);
  const shotCount = shotCountFor(duration);
  const visualSource = input.videoMode === "scene_demo" ? "ai_generate" : "product_image";
  const analysis = input.productAnalysis ? `\n商品图片分析摘要：${input.productAnalysis.slice(0, 600)}` : "";
  const performance = input.performanceHint ? `\n${input.performanceHint}` : "";

  return `为商品生成 1 套短视频带货脚本，只输出合法 JSON，不要 markdown。

商品名称：${input.productName}
商品品类：${input.category}（仅供参考，若与商品图/名称不符，以你判断的真实品类为准）
核心卖点：${input.productDescription || "根据商品名称自行提炼"}
目标时长：${duration} 秒，分镜数量：${shotCount} 个
视频模式：${input.videoMode || "product_closeup"}
${analysis}
${performance}

${input.styleType === "mood" ? MOOD_FILM_GUIDE : CONTENT_STRATEGY_GUIDE}

${input.localStore ? buildLocalStoreGuide(input.localStore, input.category) : buildTrendGuide(input.category)}

${CATEGORY_VISUAL_GUIDE}

${PACING_GUIDE}

要求：
- 第 1 镜必须 hook，最后 1 镜必须 cta
- 单镜 duration 只能是 1、2 或 3 秒：以 2 秒为主，高冲击碎镜可用 1 秒，重点镜最多 3 秒；所有分镜之和 = ${duration}
- ${input.styleType === "mood" ? "文字极简：最多 2 镜有 voiceover（情绪短句），其余留空" : "旁白口语化、短句，适合短视频"}
- 商品展示镜头 visualSource 用 "${visualSource}"；需要场景补充时才用 "ai_generate"
- prompt/searchTerms 用英文，prompt 简短具体
- ${localeHint(input.locale)}

输出 JSON 格式：
{
  "scripts": [
    {
      "title": "10字以内标题",
      "styleType": "${input.styleType || "pain_point"}",
      "totalDuration": ${duration},
      "shots": [
        {
          "shotId": 1,
          "type": "hook",
          "duration": 3,
          "description": "具体画面",
          "camera": "运镜（纯静物镜别写推近/放大，写光影流动或平移；有人镜可写跟拍/环绕）",
          "visualSource": "${visualSource}",
          "transition": "direct_concat",
          "voiceover": "短旁白",
          "prompt": "English visual prompt",
          "searchTerms": ["english keyword"]
        }
      ]
    }
  ]
}

只输出 1 个 scripts 元素，shots 必须有 ${shotCount} 个。`;
}

function quickTopicPrompt(input: TopicScriptGenInput): string {
  const duration = clampInt(input.targetDuration, 12, 40, 20);
  const shotCount = shotCountFor(duration);

  return `围绕主题生成 1 套竖屏短视频脚本，只输出合法 JSON，不要 markdown。

主题：${input.topic}
旁白风格：${input.narrationStyle || "knowledge"}
目标时长：${duration} 秒，分镜数量：${shotCount} 个

要求：
- 没有商品，不要出现购买、价格、下单
- 第 1 镜必须 hook，最后 1 镜用 cta 表示收尾升华
- 单镜 duration 只能是 1、2 或 3 秒且以 2 秒为主；description 写进行中的动作，camera 写明显的镜头运动，不要静态画面
- 每镜必须有 searchTerms，且为英文
- ${localeHint((input as { locale?: "zh" | "en" }).locale)}

输出 JSON 格式：
{
  "scripts": [
    {
      "title": "10字以内标题",
      "styleType": "custom",
      "totalDuration": ${duration},
      "shots": [
        {
          "shotId": 1,
          "type": "hook",
          "duration": 3,
          "description": "具体画面",
          "camera": "镜头运动",
          "visualSource": "ai_generate",
          "transition": "direct_concat",
          "voiceover": "短旁白",
          "searchTerms": ["english keyword"]
        }
      ]
    }
  ]
}

只输出 1 个 scripts 元素，shots 必须有 ${shotCount} 个。`;
}

function productScriptLanguage(input: ScriptInput) {
  return input.locale === "en" ? "en" : "zh";
}

function splitDurations(total: number, count: number) {
  if (count === 4) {
    const last = Math.max(3, total - 12);
    return [3, 4, 5, last];
  }
  const last = Math.max(3, total - 17);
  return [3, 4, 5, 5, last];
}

export function buildTemplateProductScript(input: ScriptInput): GeneratedScript[] {
  const duration = clampInt(input.targetDuration, 12, 40, 20);
  const shotCount = duration <= 18 ? 4 : 5;
  const durations = splitDurations(duration, shotCount);
  const lang = productScriptLanguage(input);
  const name = input.productName || (lang === "zh" ? "这款商品" : "this product");
  const source = input.videoMode === "scene_demo" ? "ai_generate" : "product_image";
  const category = input.category || "beauty";

  // 这里是模型发生“允许降级”的异常时才会使用的结构骨架，不是事实生成器。
  // 禁止根据商品名/品类臆造功效、性能、价格、材质、使用体验或优惠；每句都故意保留
  // 明显的人工补充标记，避免模板草稿被误当成可直接投放的成稿。
  type ShotType = "hook" | "pain_point" | "product_reveal" | "demo" | "cta" | "social_proof";
  type DraftShot = { type: ShotType; description: string; camera: string; voiceover: string };
  const zhMarker = "【待人工补充｜不可直接发布】";
  const enMarker = "[REVIEW REQUIRED — DO NOT PUBLISH]";
  const zh: DraftShot[] = [
    {
      type: "hook",
      description: `${zhMarker} 用真实素材展示${name}外观；只写能够从素材确认的内容。`,
      camera: "商品特写，缓慢推进",
      voiceover: `${zhMarker} 请根据已核实的商品资料填写开场，不得臆造功效或体验。`,
    },
    {
      type: "pain_point",
      description: `${zhMarker} 仅在有用户调研或商品资料支持时补充真实使用场景。`,
      camera: "场景中景，保持主体清晰",
      voiceover: `${zhMarker} 请填写有依据的用户需求；没有依据时删除本镜。`,
    },
    {
      type: "product_reveal",
      description: `${zhMarker} 展示${name}真实包装、规格或细节，不添加素材中不存在的特征。`,
      camera: "商品全貌展示，轻微横移",
      voiceover: `${zhMarker} 请从商品详情或检测资料中选择一条可核验信息。`,
    },
    {
      type: "demo",
      description: `${zhMarker} 按真实说明演示${name}，避免未经验证的前后对比。`,
      camera: "手部操作特写，跟随真实动作",
      voiceover: `${zhMarker} 请填写真实操作步骤和限制条件，不得承诺效果。`,
    },
    {
      type: "cta",
      description: `${zhMarker} 用真实商品画面收尾；价格、优惠和库存必须发布前复核。`,
      camera: "商品定格，保留字幕空间",
      voiceover: `${zhMarker} 请填写合规行动引导，并核对价格、活动和适用条件。`,
    },
  ];
  const en: DraftShot[] = [
    {
      type: "hook",
      description: `${enMarker} Show the real appearance of ${name}; include only details visible in verified source material.`,
      camera: "product close-up, slow push in",
      voiceover: `${enMarker} Add an opening based on verified product information; do not invent benefits or experiences.`,
    },
    {
      type: "pain_point",
      description: `${enMarker} Add a real use case only when supported by product material or user research.`,
      camera: "medium contextual shot, subject clearly visible",
      voiceover: `${enMarker} Add a supported customer need, or remove this shot when no evidence exists.`,
    },
    {
      type: "product_reveal",
      description: `${enMarker} Show the real packaging, specifications, or details of ${name}; add no unseen features.`,
      camera: "full product reveal, gentle pan",
      voiceover: `${enMarker} Add one verifiable fact from the product listing or supporting documentation.`,
    },
    {
      type: "demo",
      description: `${enMarker} Demonstrate ${name} according to verified instructions; avoid unsupported before-and-after claims.`,
      camera: "hand close-up following the real action",
      voiceover: `${enMarker} Add the real steps and limitations; do not promise an outcome.`,
    },
    {
      type: "cta",
      description: `${enMarker} Close on the real product; recheck price, promotion, and availability before publishing.`,
      camera: "static product shot with caption space",
      voiceover: `${enMarker} Add a compliant call to action and verify every offer condition.`,
    },
  ];
  const copy = lang === "zh" ? zh : en;
  const selected = shotCount === 4 ? [copy[0], copy[1], copy[2], copy[4]] : copy;

  // 按品类定制的英文 prompt 风格
  const promptStyleByCategory: Record<string, string> = {
    beauty: "clean beauty product photography, soft natural light, premium skincare aesthetic, shallow depth of field",
    food: "appetizing food photography, warm lighting, steam and texture visible, overhead and macro composition",
    home: "cozy home interior, natural window light, tidy and minimal styling, lifestyle product photography",
    fashion: "fashion product detail shot, natural texture visible, soft directional light, editorial style",
    tech: "tech product photography, clean studio lighting, sleek and modern, sharp focus on design details",
  };

  return [{
    title: lang === "zh" ? `【占位草稿】${name}` : `[DRAFT] ${name}`,
    styleType: input.styleType || "pain_point",
    totalDuration: durations.reduce((sum, n) => sum + n, 0),
    shots: selected.map((shot, index) => ({
      shotId: index + 1,
      type: shot.type,
      duration: durations[index],
      description: shot.description,
      camera: shot.camera,
      visualSource: shot.type === "pain_point" && input.videoMode === "scene_demo" ? "ai_generate" : source,
      transition: "direct_concat",
      voiceover: shot.voiceover,
      prompt: `vertical product video shot, ${name}, ${promptStyleByCategory[category] || promptStyleByCategory.beauty}`,
      stockKeywords: [`${name} product`, "product closeup"],
      ...(shot.type === "product_reveal" || shot.type === "cta" ? { motion: "ken_burns" as const } : {}),
    })),
  }];
}

export function buildTemplateTopicScript(input: TopicScriptGenInput): GeneratedScript[] {
  const duration = clampInt(input.targetDuration, 12, 40, 20);
  const shotCount = duration <= 18 ? 4 : 5;
  const durations = splitDurations(duration, shotCount);
  const zh = /[一-鿿]/.test(input.topic);
  const topic = input.topic || (zh ? "这个主题" : "this topic");
  const marker = zh ? "【待人工补充｜不可直接发布】" : "[REVIEW REQUIRED — DO NOT PUBLISH]";
  const allShots = zh
    ? [
        ["hook", `${marker} 用已核实素材引出「${topic}」。`, "特写快速推进", `${marker} 请依据可靠资料填写开场，不要把主题表述直接当成事实。`],
        ["demo", `${marker} 展示第一条有来源支持的信息或场景。`, "中景跟拍", `${marker} 请补充第一条可核验内容并保留来源。`],
        ["demo", `${marker} 展示第二条有来源支持的信息或场景。`, "细节特写", `${marker} 请补充第二条可核验内容；没有依据时删除本镜。`],
        ["demo", `${marker} 补充必要的限制条件、反例或上下文。`, "稳定横移", `${marker} 请补充适用边界，避免绝对化结论。`],
        ["cta", `${marker} 用中性画面收尾，留出字幕空间。`, "缓慢拉远", `${marker} 请填写不含未经核实承诺的收尾。`],
      ]
    : [
        ["hook", `${marker} Introduce ${topic} using verified source material.`, "quick close-up push in", `${marker} Add an opening grounded in reliable sources; do not present the topic wording itself as fact.`],
        ["demo", `${marker} Show the first sourced point or scene.`, "medium tracking shot", `${marker} Add the first verifiable point and retain its source.`],
        ["demo", `${marker} Show the second sourced point or scene.`, "detail close-up", `${marker} Add a second verifiable point, or remove this shot when no evidence exists.`],
        ["demo", `${marker} Add necessary limitations, counterexamples, or context.`, "steady lateral move", `${marker} Add the scope and avoid absolute conclusions.`],
        ["cta", `${marker} Close on a neutral scene with caption space.`, "slow pull back", `${marker} Add a closing line without unsupported promises.`],
      ];
  const shots = shotCount === 4
    ? [allShots[0], allShots[1], allShots[2], allShots[4]]
    : allShots;

  return [{
    title: zh ? `【占位草稿】${topic.slice(0, 10)}` : `[DRAFT] ${topic.slice(0, 24)}`,
    styleType: "custom",
    totalDuration: durations.reduce((sum, n) => sum + n, 0),
    shots: shots.map(([type, description, camera, voiceover], index) => ({
      shotId: index + 1,
      type: type as Shot["type"],
      duration: durations[index],
      description,
      camera,
      visualSource: "ai_generate",
      transition: "direct_concat",
      voiceover,
      stockKeywords: [topic, "vertical video"],
    })),
  }];
}

/**
 * 从 LLM 返回的文本中提取 JSON
 * 兼容直接输出 JSON 和包裹在 markdown 代码块中的情况
 */
export function extractJSON(text: string): string {
  // 尝试移除 markdown 代码块标记
  const codeBlockMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (codeBlockMatch) {
    return codeBlockMatch[1].trim();
  }

  // 尝试找到第一个 { 或 [ 开头的 JSON
  const jsonMatch = text.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
  if (jsonMatch) {
    return jsonMatch[1].trim();
  }

  return text.trim();
}

/**
 * 转义 JSON 字符串值内部的裸控制字符（换行/制表符等）。
 * LLM（尤其火山关闭思考后直出 JSON）常在 voiceover/description 里塞裸换行，标准 JSON 不允许 → JSON.parse 抛
 * "Invalid control character"。用状态机只处理「字符串内」的控制字符，不动结构性空白，避免误伤合法 JSON。
 */
function sanitizeJsonControlChars(raw: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (escaped) { out += ch; escaped = false; continue; }
    if (ch === "\\") { out += ch; escaped = true; continue; }
    if (ch === '"') { inString = !inString; out += ch; continue; }
    if (inString && ch.charCodeAt(0) <= 0x1f) {
      out += ch === "\n" ? "\\n" : ch === "\r" ? "\\r" : ch === "\t" ? "\\t"
        : "\\u" + ch.charCodeAt(0).toString(16).padStart(4, "0");
      continue;
    }
    out += ch;
  }
  return out;
}

/**
 * 容错 JSON 解析：正常 JSON 直接 parse；失败则先清洗字符串内裸控制字符再重试一次。
 * 让"AI 内容其实生成对了、只是格式有裸换行"的情况不再白白降级到兜底模板。
 */
export function parseJsonLoose(jsonStr: string): unknown {
  try {
    return JSON.parse(jsonStr);
  } catch {
    return JSON.parse(sanitizeJsonControlChars(jsonStr));
  }
}

/**
 * 给「JSON 解析失败」的错误补一句可操作提示：以 {/[ 开头却未以 }/] 收尾，
 * 多半是 max_tokens 截断了输出——提示增大 token 上限，而非干巴巴的「非法 JSON」。
 */
function truncationHint(jsonStr: string): string {
  return /^[{[]/.test(jsonStr) && !/[}\]]\s*$/.test(jsonStr) ? "（输出疑似被截断，请增大 max_tokens 后重试）" : "";
}

/**
 * 验证并修正单个 Shot 数据
 * 确保所有必填字段都有合法值
 */
function validateShot(shot: Partial<Shot>, index: number): Shot {
  const validTypes: Shot["type"][] = ["hook", "pain_point", "product_reveal", "demo", "social_proof", "cta"];
  const validTransitions: Shot["transition"][] = ["ai_start_end", "ai_reference", "direct_concat", "ffmpeg_fade"];
  const validSources: Shot["visualSource"][] = ["ai_generate", "product_image", "user_upload"];

  const validMotions: NonNullable<Shot["motion"]>[] = ["zoom_in_slow", "pan_left", "pan_right", "ken_burns", "static"];

  // 解析 LLM 产出的英文素材检索词（字段名 searchTerms 或 stockKeywords），取前 3 个非空字符串
  const rawTerms = (shot as Record<string, unknown>).searchTerms ?? shot.stockKeywords;
  const stockKeywords = Array.isArray(rawTerms)
    ? rawTerms.filter((t): t is string => typeof t === "string" && t.trim().length > 0).map((t) => t.trim()).slice(0, 3)
    : undefined;

  return {
    shotId: shot.shotId || index + 1,
    type: validTypes.includes(shot.type as Shot["type"]) ? (shot.type as Shot["type"]) : "demo",
    duration: typeof shot.duration === "number" && shot.duration > 0 ? shot.duration : 3,
    description: shot.description || "",
    camera: shot.camera || "镜头缓慢推近",
    visualSource: validSources.includes(shot.visualSource as Shot["visualSource"]) ? (shot.visualSource as Shot["visualSource"]) : "ai_generate",
    // 默认转场与 schema(videoClips.transitionType) 及 UI 默认保持一致（ai_start_end）
    transition: validTransitions.includes(shot.transition as Shot["transition"]) ? (shot.transition as Shot["transition"]) : "ai_start_end",
    voiceover: shot.voiceover || "",
    prompt: shot.prompt || undefined,
    // 透传 LLM 按视频模式生成的扩展字段，避免被静默丢弃
    ...(stockKeywords?.length && { stockKeywords }),
    ...(shot.characterId && { characterId: shot.characterId }),
    ...(validMotions.includes(shot.motion as NonNullable<Shot["motion"]>) && { motion: shot.motion }),
    ...(shot.textOverlay?.text && {
      textOverlay: {
        text: shot.textOverlay.text,
        style: shot.textOverlay.style ?? "subtitle",
      },
    }),
  };
}

/**
 * 验证并修正完整的脚本数据
 */
function validateScript(raw: Record<string, unknown>, fallbackStyleType: string): GeneratedScript {
  // 先滤掉 null/非对象元素：LLM 偶尔产出 shots:[{...}, null]，validateShot 首行就访问 shot.xxx 会抛 TypeError
  // → 整次（可能含多套有效脚本的）付费生成 500 作废。与 parseScriptResponse 的脚本级过滤同口径。
  const shots = Array.isArray(raw.shots)
    ? (raw.shots as Partial<Shot>[])
        .filter((s): s is Partial<Shot> => typeof s === "object" && s !== null)
        .map((s, i) => validateShot(s, i))
    : [];

  const totalDuration = typeof raw.totalDuration === "number"
    ? raw.totalDuration
    : shots.reduce((sum, s) => sum + s.duration, 0);

  return {
    title: (raw.title as string) || "未命名脚本",
    styleType: (raw.styleType as string) || fallbackStyleType,
    totalDuration,
    shots,
  };
}

// ==================== 核心功能 ====================

/**
 * 生成带货脚本（单次调用，返回完整结果）
 * @param input - 脚本生成输入参数
 * @returns 生成的脚本数组
 */
export async function generateScript(input: ScriptInput): Promise<GeneratedScript[]> {
  const count = clampInt(input.count, 1, 5, 3);
  const quick = input.quick || count === 1;
  const userPrompt = quick ? quickProductPrompt(input) : buildBatchPrompt(input, count);
  const systemPrompt = quick
    ? "你是短视频编导。创作原则：①前3秒必须有强钩子（画面/声音/文字任一）②旁白说人话不播音腔 ③每镜只讲一件事 ④prompt/searchTerms用英文且具体 ⑤禁止使用\"家人们\"/\"绝绝子\"/\"yyds\"等过时表达。只输出可解析JSON。"
    : input.systemPrompt || SYSTEM_PROMPT;
  const maxTokens = input.maxTokens ?? input.llmConfig.maxTokens ?? (quick ? 5000 : 10000);
  const timeoutMs = input.timeoutMs ?? input.llmConfig.timeoutMs ?? (count === 1 ? 30000 : 60000);
  const client = createClient(input.llmConfig, timeoutMs);

  // 调用 LLM 生成脚本
  let response;
  const req = requestSignal(timeoutMs);
  try {
    response = await client.chat.completions.create(arkThinkingOff({
      model: input.llmConfig.model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.85,
      max_tokens: maxTokens,
    }, input.llmConfig.baseUrl), {
      signal: req.signal,
    });
  } catch (e: unknown) {
    const msg = timeoutMessage(e, timeoutMs);
    throw new Error(`LLM 请求失败（模型: ${input.llmConfig.model}，地址: ${input.llmConfig.baseUrl}）: ${msg}${providerErrorHint(input.llmConfig, msg)}`);
  } finally {
    req.cleanup();
  }

  const content = response.choices[0]?.message?.content;
  if (!content) {
    throw new Error("LLM 未返回有效内容");
  }

  // 主题成片没有带货风格概念，统一回退为 "custom"
  return parseScriptResponse(content, input.styleType);
}

/** 主题成片脚本生成输入（一句话主题 + LLM 配置） */
export interface TopicScriptGenInput extends TopicScriptInput {
  llmConfig: LLMConfig;
  /** 后台 Agent 发布的系统提示词版本；缺省时使用代码内置提示词 */
  systemPrompt?: string;
  /** 生成几套方案，默认 3 */
  count?: number;
  /** 本次生成最大输出 token */
  maxTokens?: number;
  /** 本次生成超时时间（毫秒） */
  timeoutMs?: number;
  /** 轻量快速生成：用于首页首轮出稿，减少提示词与输出体积 */
  quick?: boolean;
}

/**
 * 生成「一句话主题成片」脚本（去商品化，每个分镜带英文检索词供自动配画面）
 * @param input - 主题 + LLM 配置
 * @returns 生成的脚本数组（含 stockKeywords，可直接喂给 stock-fill 配齐画面）
 */
export async function generateTopicScript(input: TopicScriptGenInput): Promise<GeneratedScript[]> {
  const count = clampInt(input.count, 1, 5, 3);
  const quick = input.quick || count === 1;
  const userPrompt = quick ? quickTopicPrompt(input) : buildTopicBatchPrompt(input, count);
  const systemPrompt = quick
    ? "你是短视频内容编导。原则：①前3秒留人 ②旁白说人话 ③每镜只讲一件事 ④searchTerms用英文且具象 ⑤禁止空洞形容词和播音腔。只输出可解析JSON。"
    : input.systemPrompt || TOPIC_SYSTEM_PROMPT;
  const maxTokens = input.maxTokens ?? input.llmConfig.maxTokens ?? (quick ? 5000 : 10000);
  const timeoutMs = input.timeoutMs ?? input.llmConfig.timeoutMs ?? (count === 1 ? 30000 : 60000);
  const client = createClient(input.llmConfig, timeoutMs);

  let response;
  const req = requestSignal(timeoutMs);
  try {
    response = await client.chat.completions.create(arkThinkingOff({
      model: input.llmConfig.model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.9,
      max_tokens: maxTokens,
    }, input.llmConfig.baseUrl), {
      signal: req.signal,
    });
  } catch (e: unknown) {
    const msg = timeoutMessage(e, timeoutMs);
    throw new Error(`LLM 请求失败（模型: ${input.llmConfig.model}，地址: ${input.llmConfig.baseUrl}）: ${msg}${providerErrorHint(input.llmConfig, msg)}`);
  } finally {
    req.cleanup();
  }

  const content = response.choices[0]?.message?.content;
  if (!content) {
    throw new Error("LLM 未返回有效内容");
  }

  // 主题成片没有带货风格概念，统一回退为 "custom"
  return parseScriptResponse(content, "custom");
}

/**
 * 生成单个脚本（更快的响应）
 * @param input - 脚本生成输入参数
 * @returns 单个生成的脚本
 */
export async function generateSingleScript(input: ScriptInput): Promise<GeneratedScript> {
  const client = createClient(input.llmConfig, input.timeoutMs);
  const userPrompt = buildUserPrompt(input);
  const systemPrompt = input.systemPrompt || SYSTEM_PROMPT;

  const response = await client.chat.completions.create(arkThinkingOff({
    model: input.llmConfig.model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    temperature: 0.85,
  }, input.llmConfig.baseUrl));

  const content = response.choices[0]?.message?.content;
  if (!content) {
    throw new Error("LLM 未返回有效内容");
  }

  const jsonStr = extractJSON(content);
  let parsed: Record<string, unknown>;
  try {
    parsed = parseJsonLoose(jsonStr) as Record<string, unknown>;
  } catch {
    throw new Error(`LLM 返回的内容不是合法 JSON${truncationHint(jsonStr)}: ${jsonStr.substring(0, 200)}`);
  }
  return validateScript(parsed, input.styleType);
}

/**
 * 流式生成脚本
 * 支持实时获取生成进度，适合前端流式展示
 * @param input - 脚本生成输入参数
 * @param callbacks - 流式回调函数
 * @returns AbortController 用于取消生成
 */
export function generateScriptStream(
  input: ScriptInput,
  callbacks: StreamCallbacks,
): AbortController {
  const abortController = new AbortController();

  const run = async () => {
    const client = createClient(input.llmConfig, input.timeoutMs);
    const userPrompt = buildUserPrompt(input);
    const systemPrompt = input.systemPrompt || SYSTEM_PROMPT;

    let fullContent = "";

    try {
      const stream = await client.chat.completions.create(arkThinkingOff({
          model: input.llmConfig.model,
          messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.85,
        stream: true,
      }, input.llmConfig.baseUrl), {
        signal: abortController.signal,
      });

      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta?.content;
        if (delta) {
          fullContent += delta;
          callbacks.onToken?.(delta);
        }
      }

      // 流式结束后解析完整结果
      const scripts = parseScriptResponse(fullContent, input.styleType);
      callbacks.onComplete?.(scripts);
    } catch (error) {
      // 用户主动取消不算错误
      if (abortController.signal.aborted) return;
      callbacks.onError?.(error instanceof Error ? error : new Error(String(error)));
    }
  };

  run();
  return abortController;
}

/**
 * 创建流式生成的 ReadableStream
 * 用于 Next.js API Route 的流式响应
 * @param input - 脚本生成输入参数
 * @returns ReadableStream
 */
export function createScriptStream(input: ScriptInput): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();

  return new ReadableStream({
    async start(controller) {
      const client = createClient(input.llmConfig, input.timeoutMs);
      const userPrompt = buildUserPrompt(input);
      const systemPrompt = input.systemPrompt || SYSTEM_PROMPT;

      try {
        const stream = await client.chat.completions.create(arkThinkingOff({
          model: input.llmConfig.model,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
          temperature: 0.8,
          stream: true,
        }, input.llmConfig.baseUrl));

        for await (const chunk of stream) {
          const delta = chunk.choices[0]?.delta?.content;
          if (delta) {
            controller.enqueue(encoder.encode(delta));
          }
        }

        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });
}

// ==================== 商品图片分析 ====================

/**
 * 分析商品图片
 * 调用视觉模型提取商品信息、卖点、目标用户等
 * @param imageUrls - 商品图片 URL 列表（支持 http/https 和 base64 data URI）
 * @param config - LLM 配置
 * @returns 商品分析结果的 JSON 字符串
 */
export async function analyzeProduct(
  imageUrls: string[],
  config: LLMConfig,
  systemPrompt = PRODUCT_ANALYSIS_PROMPT,
): Promise<string> {
  const model = config.visionModel || config.model;
  const timeoutMs = config.timeoutMs ?? 12000;
  const maxTokens = config.maxTokens ?? 1200;
  const client = createClient(config, timeoutMs);

  // 构建带图片的消息内容
  const imageContent: OpenAI.Chat.Completions.ChatCompletionContentPart[] = imageUrls.map(
    (url) => ({
      type: "image_url" as const,
      image_url: { url, detail: "high" as const },
    }),
  );

  const req = requestSignal(timeoutMs);
  let response;
  try {
    response = await client.chat.completions.create(arkThinkingOff({
      model,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: systemPrompt },
            ...imageContent,
          ],
        },
      ],
      temperature: 0.3,
      max_tokens: maxTokens,
    }, config.baseUrl), {
      signal: req.signal,
    });
  } catch (e: unknown) {
    throw new Error(timeoutMessage(e, timeoutMs));
  } finally {
    req.cleanup();
  }

  return response.choices[0]?.message?.content || "";
}

/**
 * 分析商品图片并返回结构化数据
 * @param imageUrls - 商品图片 URL 列表
 * @param config - LLM 配置
 * @returns 结构化的商品分析结果
 */
export async function analyzeProductStructured(
  imageUrls: string[],
  config: LLMConfig,
  systemPrompt = PRODUCT_ANALYSIS_PROMPT,
): Promise<ProductAnalysisResult> {
  const rawResult = await analyzeProduct(imageUrls, config, systemPrompt);
  const jsonStr = extractJSON(rawResult);
  try {
    return parseJsonLoose(jsonStr) as ProductAnalysisResult;
  } catch {
    throw new Error(`商品分析结果不是合法 JSON${truncationHint(jsonStr)}: ${jsonStr.substring(0, 200)}`);
  }
}

// ==================== 解析工具 ====================

/**
 * 解析 LLM 返回的脚本内容
 * 兼容多种返回格式（单个对象、数组、嵌套对象等）
 */
export function parseScriptResponse(content: string, fallbackStyleType: string): GeneratedScript[] {
  const jsonStr = extractJSON(content);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let parsed: any;
  try {
    parsed = parseJsonLoose(jsonStr);
  } catch {
    throw new Error(`LLM 返回的内容不是合法 JSON${truncationHint(jsonStr)}: ${jsonStr.substring(0, 200)}`);
  }

  // 处理不同的返回格式
  let rawScripts: Record<string, unknown>[];

  if (Array.isArray(parsed)) {
    // 直接返回数组
    rawScripts = parsed;
  } else if (parsed.scripts && Array.isArray(parsed.scripts)) {
    // { scripts: [...] } 格式
    rawScripts = parsed.scripts;
  } else if (parsed.shots && Array.isArray(parsed.shots)) {
    // 单个脚本对象
    rawScripts = [parsed];
  } else {
    throw new Error("无法解析 LLM 返回的脚本格式");
  }

  // 丢弃没有任何分镜的脚本（LLM 偶尔返回只有 title、缺 shots 的残缺条目）；
  // 全部为空则抛错——否则会把「零分镜脚本」当成功落库，下游配画面/合成无米可炊却不报错。
  // 先滤掉 null/非对象元素：LLM 偶尔产出 [null, {...}]，validateScript 首行读 raw.shots 会对 null 抛错、连累整次解析。
  const scripts = rawScripts
    .filter((raw): raw is Record<string, unknown> => typeof raw === "object" && raw !== null)
    .map((raw) => validateScript(raw, fallbackStyleType))
    .filter((s) => s.shots.length > 0);
  if (scripts.length === 0) {
    throw new Error("LLM 未生成有效分镜（脚本为空），请重试或调整输入");
  }
  return scripts;
}
