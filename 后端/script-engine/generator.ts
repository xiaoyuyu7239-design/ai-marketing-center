/**
 * 脚本生成器
 * 使用 OpenAI 兼容格式调用 LLM 生成带货短视频脚本
 * 支持自定义 LLM endpoint、流式输出、商品图片分析
 */

import OpenAI from "openai";
import {
  SYSTEM_PROMPT,
  PRODUCT_ANALYSIS_PROMPT,
  TOPIC_SYSTEM_PROMPT,
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
function createClient(config: LLMConfig): OpenAI {
  return new OpenAI({
    baseURL: config.baseUrl,
    // 本地/免费 OpenAI 兼容端点（Ollama、Pollinations）无需真 Key；SDK 要求非空，缺省给占位符
    apiKey: config.apiKey || "no-key",
  });
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

function sameLanguageHint(text: string) {
  return text.trim() && !/[一-鿿]/.test(text)
    ? "Write title and voiceover in the same language as the product/topic. Keep searchTerms in English."
    : "标题、画面描述、镜头、旁白使用中文；searchTerms 和 prompt 使用英文。";
}

function quickProductPrompt(input: ScriptInput): string {
  const duration = clampInt(input.targetDuration, 12, 40, 20);
  const shotCount = duration <= 18 ? 4 : 5;
  const productText = `${input.productName || ""} ${input.productDescription || ""} ${input.usageAdvantage || ""}`;
  const visualSource = input.videoMode === "scene_demo" ? "ai_generate" : "product_image";
  const analysis = input.productAnalysis ? `\n商品图片分析摘要：${input.productAnalysis.slice(0, 600)}` : "";
  const performance = input.performanceHint ? `\n${input.performanceHint}` : "";

  return `为商品生成 1 套短视频带货脚本，只输出合法 JSON，不要 markdown。

商品名称：${input.productName}
商品品类：${input.category}
核心卖点：${input.productDescription || "根据商品名称自行提炼"}
目标时长：${duration} 秒，分镜数量：${shotCount} 个
视频模式：${input.videoMode || "product_closeup"}
${analysis}
${performance}

要求：
- 第 1 镜必须 hook，最后 1 镜必须 cta
- 旁白口语化、短句，适合短视频
- 商品展示镜头 visualSource 用 "${visualSource}"；需要场景补充时才用 "ai_generate"
- prompt/searchTerms 用英文，prompt 简短具体
- ${sameLanguageHint(productText)}

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
          "camera": "特写/推近等",
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
  const shotCount = duration <= 18 ? 4 : 5;

  return `围绕主题生成 1 套竖屏短视频脚本，只输出合法 JSON，不要 markdown。

主题：${input.topic}
旁白风格：${input.narrationStyle || "knowledge"}
目标时长：${duration} 秒，分镜数量：${shotCount} 个

要求：
- 没有商品，不要出现购买、价格、下单
- 第 1 镜必须 hook，最后 1 镜用 cta 表示收尾升华
- 每镜必须有 searchTerms，且为英文
- ${sameLanguageHint(input.topic)}

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
  const text = `${input.productName || ""} ${input.productDescription || ""} ${input.usageAdvantage || ""}`;
  return text.trim() && !/[一-鿿]/.test(text) ? "en" : "zh";
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
  const sellingPoint = input.productDescription || input.usageAdvantage || (lang === "zh" ? "实用、好上手，适合日常场景" : "practical, easy to use, and made for everyday routines");
  const source = input.videoMode === "scene_demo" ? "ai_generate" : "product_image";

  const zh = [
    {
      type: "hook" as const,
      description: `${name} 的核心细节快速特写，画面干净、有冲击力`,
      camera: "微距特写，缓慢推进",
      voiceover: `别划走，${name}这个细节真的很实用。`,
    },
    {
      type: "pain_point" as const,
      description: "日常使用痛点场景，画面突出麻烦和对比",
      camera: "中近景切换，节奏稍快",
      voiceover: `很多人买同类产品，最怕的就是不好用、不耐用。`,
    },
    {
      type: "product_reveal" as const,
      description: `${name} 正面展示，突出外观和卖点`,
      camera: "产品全貌展示，轻微横移",
      voiceover: `${name}主打${sellingPoint}。`,
    },
    {
      type: "demo" as const,
      description: "模拟真实使用过程，展示上手效果",
      camera: "细节特写，跟随动作",
      voiceover: "实际用起来步骤简单，新手也能很快上手。",
    },
    {
      type: "cta" as const,
      description: "商品定格展示，叠加核心卖点文字",
      camera: "静止定格，突出购买引导",
      voiceover: "想省心选一款日常好物，可以先收藏再对比。",
    },
  ];
  const en = [
    {
      type: "hook" as const,
      description: `Fast close-up of ${name}, clean background and strong visual focus`,
      camera: "macro close-up, slow push in",
      voiceover: `Wait, this detail on ${name} is actually useful.`,
    },
    {
      type: "pain_point" as const,
      description: "Everyday pain point scene with clear before-and-after contrast",
      camera: "medium close-up cuts, quick rhythm",
      voiceover: "Most products like this look fine, but the real question is whether they work every day.",
    },
    {
      type: "product_reveal" as const,
      description: `Front product reveal of ${name}, highlighting the main selling point`,
      camera: "full product reveal with gentle pan",
      voiceover: `${name} is made for ${sellingPoint}.`,
    },
    {
      type: "demo" as const,
      description: "Realistic usage demo showing the product in action",
      camera: "detail close-up following the action",
      voiceover: "It is simple to use, easy to understand, and fits into a normal routine.",
    },
    {
      type: "cta" as const,
      description: "Final product still with key benefit text overlay",
      camera: "static hero shot",
      voiceover: "Save this first if you want an easier pick for daily use.",
    },
  ];
  const copy = lang === "zh" ? zh : en;
  const selected = copy.slice(0, shotCount);

  return [{
    title: lang === "zh" ? `${name}种草` : `${name} pick`,
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
      prompt: `vertical product video shot, ${name}, clean commercial lighting, premium composition`,
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
  const shots = zh
    ? [
        ["hook", `用一个反差画面引出「${topic}」`, "特写快速推进", `你有没有发现，${topic}其实比想象中更简单？`],
        ["demo", "展示第一个关键场景或动作", "中景跟拍", "先抓住最关键的一步，画面马上就顺了。"],
        ["demo", "展示第二个细节，形成节奏变化", "细节特写", "再补上这个细节，整个感觉会更完整。"],
        ["cta", "用干净画面收尾，留出字幕空间", "缓慢拉远", "收藏起来，下次照着做就行。"],
      ]
    : [
        ["hook", `A contrast shot introducing ${topic}`, "quick close-up push in", `${topic} is simpler than it looks.`],
        ["demo", "Show the first key scene or action", "medium tracking shot", "Start with the one step that makes the whole idea click."],
        ["demo", "Show a second detail with a different rhythm", "detail close-up", "Add this small detail and the story feels complete."],
        ["cta", "Clean closing shot with space for captions", "slow pull back", "Save this and come back to it when you need it."],
      ];

  return [{
    title: zh ? topic.slice(0, 10) : topic.slice(0, 24),
    styleType: "custom",
    totalDuration: durations.reduce((sum, n) => sum + n, 0),
    shots: shots.slice(0, shotCount).map(([type, description, camera, voiceover], index) => ({
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
    camera: shot.camera || "固定镜头",
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
  const shots = Array.isArray(raw.shots)
    ? (raw.shots as Partial<Shot>[]).map((s, i) => validateShot(s, i))
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
  const client = createClient(input.llmConfig);
  const count = clampInt(input.count, 1, 5, 3);
  const quick = input.quick || count === 1;
  const userPrompt = quick ? quickProductPrompt(input) : buildBatchPrompt(input, count);
  const systemPrompt = quick
    ? "你是短视频编导。严格只输出可解析 JSON，不要解释，不要 markdown。"
    : input.systemPrompt || SYSTEM_PROMPT;
  const maxTokens = input.maxTokens ?? input.llmConfig.maxTokens ?? (quick ? 2500 : 10000);
  const timeoutMs = input.timeoutMs ?? input.llmConfig.timeoutMs ?? (count === 1 ? 30000 : 60000);

  // 调用 LLM 生成脚本
  let response;
  const req = requestSignal(timeoutMs);
  try {
    response = await client.chat.completions.create({
      model: input.llmConfig.model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.8,
      max_tokens: maxTokens,
    }, {
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
  const client = createClient(input.llmConfig);
  const count = clampInt(input.count, 1, 5, 3);
  const quick = input.quick || count === 1;
  const userPrompt = quick ? quickTopicPrompt(input) : buildTopicBatchPrompt(input, count);
  const systemPrompt = quick
    ? "你是短视频内容编导。严格只输出可解析 JSON，不要解释，不要 markdown。"
    : input.systemPrompt || TOPIC_SYSTEM_PROMPT;
  const maxTokens = input.maxTokens ?? input.llmConfig.maxTokens ?? (quick ? 2500 : 10000);
  const timeoutMs = input.timeoutMs ?? input.llmConfig.timeoutMs ?? (count === 1 ? 30000 : 60000);

  let response;
  const req = requestSignal(timeoutMs);
  try {
    response = await client.chat.completions.create({
      model: input.llmConfig.model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.85,
      max_tokens: maxTokens,
    }, {
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
  const client = createClient(input.llmConfig);
  const userPrompt = buildUserPrompt(input);
  const systemPrompt = input.systemPrompt || SYSTEM_PROMPT;

  const response = await client.chat.completions.create({
    model: input.llmConfig.model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    temperature: 0.8,
  });

  const content = response.choices[0]?.message?.content;
  if (!content) {
    throw new Error("LLM 未返回有效内容");
  }

  const jsonStr = extractJSON(content);
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(jsonStr);
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
    const client = createClient(input.llmConfig);
    const userPrompt = buildUserPrompt(input);
    const systemPrompt = input.systemPrompt || SYSTEM_PROMPT;

    let fullContent = "";

    try {
      const stream = await client.chat.completions.create({
          model: input.llmConfig.model,
          messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.8,
        stream: true,
      }, {
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
      const client = createClient(input.llmConfig);
      const userPrompt = buildUserPrompt(input);
      const systemPrompt = input.systemPrompt || SYSTEM_PROMPT;

      try {
        const stream = await client.chat.completions.create({
          model: input.llmConfig.model,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
          temperature: 0.8,
          stream: true,
        });

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
  const client = createClient(config);
  const model = config.visionModel || config.model;
  const timeoutMs = config.timeoutMs ?? 12000;
  const maxTokens = config.maxTokens ?? 1200;

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
    response = await client.chat.completions.create({
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
    }, {
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
    return JSON.parse(jsonStr) as ProductAnalysisResult;
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
    parsed = JSON.parse(jsonStr);
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
