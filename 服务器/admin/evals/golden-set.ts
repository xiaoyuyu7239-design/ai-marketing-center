import "server-only";

/**
 * 模型评测不按“Agent 名称”重复配置候选模型，而是按能力族共享候选池。
 * 同一能力族里的 Agent 仍然必须逐任务跑 Golden Set，不能用某一个 Agent
 * 的高分替代其他任务的验收。
 */
export const GOLDEN_AGENT_IDS = [
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
] as const;

export type GoldenAgentId = (typeof GOLDEN_AGENT_IDS)[number];

export const CAPABILITY_FAMILY_IDS = [
  "script-topic",
  "structured-short",
  "vision-ocr",
  "image-generation",
  "video-generation",
  "tts",
] as const;

export type CapabilityFamilyId = (typeof CAPABILITY_FAMILY_IDS)[number];

export type EvaluationRequestKind =
  | "chat-json"
  | "vision-json"
  | "image-generation"
  | "video-generation"
  | "tts-generation";

export interface CapabilityFamilyDefinition {
  id: CapabilityFamilyId;
  name: string;
  /** 后台候选模型表用这个稳定 key 共享候选池。 */
  candidatePoolId: string;
  requestKind: EvaluationRequestKind;
  agentIds: readonly GoldenAgentId[];
}

export const CAPABILITY_FAMILIES: readonly CapabilityFamilyDefinition[] = [
  {
    id: "script-topic",
    name: "长结构化脚本 / 主题成片",
    candidatePoolId: "pool.text.long-structured.v1",
    requestKind: "chat-json",
    agentIds: ["script", "topic-script"],
  },
  {
    id: "structured-short",
    name: "短结构化文案 / 诊断 / 复盘 / 周报",
    candidatePoolId: "pool.text.short-structured.v1",
    requestKind: "chat-json",
    agentIds: ["publish-copy", "publish-ranker", "diagnose", "retro", "weekly-report"],
  },
  {
    id: "vision-ocr",
    name: "视觉理解 / OCR",
    candidatePoolId: "pool.vision.structured.v1",
    requestKind: "vision-json",
    agentIds: ["product-analysis", "metrics-ocr"],
  },
  {
    id: "image-generation",
    name: "图片生成",
    candidatePoolId: "pool.media.image.v1",
    requestKind: "image-generation",
    agentIds: ["imageAgent"],
  },
  {
    id: "video-generation",
    name: "视频生成",
    candidatePoolId: "pool.media.video.v1",
    requestKind: "video-generation",
    agentIds: ["videoAgent"],
  },
  {
    id: "tts",
    name: "TTS 配音",
    candidatePoolId: "pool.audio.tts.v1",
    requestKind: "tts-generation",
    agentIds: ["ttsAgent"],
  },
];

export interface StringShape {
  type: "string";
  minLength?: number;
  maxLength?: number;
  pattern?: string;
}

export interface NumberShape {
  type: "number";
  integer?: boolean;
  min?: number;
  max?: number;
}

export interface BooleanShape {
  type: "boolean";
}

export interface NullShape {
  type: "null";
}

export interface LiteralShape {
  type: "literal";
  value: string | number | boolean | null;
}

export interface EnumShape {
  type: "enum";
  values: readonly (string | number | boolean | null)[];
}

export interface ArrayShape {
  type: "array";
  items: RequiredShape;
  minItems?: number;
  maxItems?: number;
}

export interface ObjectShape {
  type: "object";
  required: Readonly<Record<string, RequiredShape>>;
  optional?: Readonly<Record<string, RequiredShape>>;
  /** 默认 false：结构化输出的合同应该稳定。 */
  allowUnknown?: boolean;
}

export interface UnionShape {
  type: "union";
  variants: readonly RequiredShape[];
}

export type RequiredShape =
  | StringShape
  | NumberShape
  | BooleanShape
  | NullShape
  | LiteralShape
  | EnumShape
  | ArrayShape
  | ObjectShape
  | UnionShape;

export type AutomatedRubricCheck =
  | { kind: "non-empty"; path: string }
  | { kind: "length"; path: string; min?: number; max?: number }
  | { kind: "equals"; path: string; value: unknown }
  | { kind: "one-of"; path: string; values: readonly unknown[] }
  | { kind: "matches"; path: string; pattern: string; flags?: string }
  | { kind: "unique"; path: string; by?: string }
  | { kind: "set-equals"; path: string; values: readonly unknown[] }
  | { kind: "sum-equals-path"; arrayPath: string; field: string; targetPath: string; tolerance?: number }
  | { kind: "excludes-terms"; path: string; terms: readonly string[] }
  | { kind: "number-range"; path: string; min: number; max: number };

export interface AutomaticRubricCriterion {
  id: string;
  label: string;
  weight: number;
  evaluator: "automatic";
  check: AutomatedRubricCheck;
}

export interface HumanRubricCriterion {
  id: string;
  label: string;
  weight: number;
  evaluator: "human";
  guidance: string;
  anchors: {
    1: string;
    3: string;
    5: string;
  };
}

export type RubricCriterion = AutomaticRubricCriterion | HumanRubricCriterion;

export interface GoldenAttachment {
  /** 不把二进制样本塞进记录；执行器用这个稳定 ID 解析只读 fixture。 */
  fixtureId: string;
  mediaType: "image" | "video" | "audio";
  mimeType: string;
  description: string;
}

export interface GoldenCaseInput {
  userPrompt: string;
  data: Readonly<Record<string, unknown>>;
  attachments?: readonly GoldenAttachment[];
}

export interface JsonGoldenCase {
  id: string;
  version: 1;
  agentId: GoldenAgentId;
  familyId: CapabilityFamilyId;
  name: string;
  /** 同一 Agent 的 case 权重之和必须为 100。 */
  weight: number;
  input: GoldenCaseInput;
  outputKind: "json";
  requiredShape: RequiredShape;
  rubric: readonly AutomaticRubricCriterion[];
}

export interface MediaGoldenCase {
  id: string;
  version: 1;
  agentId: GoldenAgentId;
  familyId: CapabilityFamilyId;
  name: string;
  weight: number;
  input: GoldenCaseInput;
  outputKind: "media";
  requiredShape: {
    mediaType: "image" | "video" | "audio";
    minimumArtifacts: number;
    humanReviewRequired: true;
  };
  rubric: readonly HumanRubricCriterion[];
}

export type GoldenCase = JsonGoldenCase | MediaGoldenCase;

const text = (maxLength = 500): StringShape => ({ type: "string", minLength: 1, maxLength });
const nullableText: RequiredShape = { type: "union", variants: [{ type: "null" }, { type: "string", minLength: 1, maxLength: 100 }] };
const metricValue: RequiredShape = {
  type: "union",
  variants: [
    { type: "null" },
    { type: "number", integer: true, min: 0 },
    { type: "string", minLength: 1, maxLength: 30 },
  ],
};
const shortStringList = (minItems: number, maxItems: number, maxLength: number): ArrayShape => ({
  type: "array",
  minItems,
  maxItems,
  items: { type: "string", minLength: 1, maxLength },
});

const shotShape: ObjectShape = {
  type: "object",
  required: {
    shotId: { type: "number", integer: true, min: 1, max: 20 },
    type: { type: "enum", values: ["hook", "pain_point", "product_reveal", "demo", "social_proof", "cta"] },
    duration: { type: "number", min: 1, max: 12 },
    description: text(240),
    camera: text(120),
    visualSource: { type: "enum", values: ["ai_generate", "product_image", "user_upload"] },
    transition: { type: "enum", values: ["ai_start_end", "ai_reference", "direct_concat", "ffmpeg_fade"] },
    voiceover: text(80),
    prompt: text(600),
    searchTerms: shortStringList(1, 3, 80),
  },
  optional: { characterId: text(80) },
};

const topicShotShape: ObjectShape = {
  type: "object",
  required: {
    shotId: { type: "number", integer: true, min: 1, max: 20 },
    type: { type: "enum", values: ["hook", "demo", "cta"] },
    duration: { type: "number", min: 1, max: 12 },
    description: text(240),
    camera: text(120),
    visualSource: { type: "literal", value: "ai_generate" },
    transition: { type: "enum", values: ["direct_concat", "ffmpeg_fade"] },
    voiceover: text(80),
    searchTerms: shortStringList(1, 3, 80),
  },
};

const scriptOutputShape: ObjectShape = {
  type: "object",
  required: {
    title: text(20),
    totalDuration: { type: "number", min: 15, max: 30 },
    shots: { type: "array", minItems: 5, maxItems: 8, items: shotShape },
  },
  optional: {
    seo: {
      type: "object",
      required: {
        title: text(30),
        hashtags: shortStringList(3, 5, 30),
        coverText: text(16),
        interactionGuide: text(80),
        description: text(100),
      },
    },
  },
};

const topicOutputShape: ObjectShape = {
  type: "object",
  required: {
    title: text(20),
    totalDuration: { type: "number", min: 15, max: 40 },
    shots: { type: "array", minItems: 5, maxItems: 9, items: topicShotShape },
  },
};

export const GOLDEN_CASES: readonly GoldenCase[] = [
  {
    id: "script.tech-earbuds.zh.v1",
    version: 1,
    agentId: "script",
    familyId: "script-topic",
    name: "科技品带货 20 秒分镜",
    weight: 100,
    input: {
      userPrompt: "为一款无线降噪耳机生成 20 秒中文带货短视频分镜，只输出 JSON。",
      data: {
        productName: "清音 Pro 无线降噪耳机",
        category: "tech",
        sellingPoints: ["40dB 主动降噪", "36 小时续航", "通透模式"],
        targetDurationSeconds: 20,
        locale: "zh",
      },
    },
    outputKind: "json",
    requiredShape: scriptOutputShape,
    rubric: [
      { id: "opening-hook", label: "首镜是 hook", weight: 15, evaluator: "automatic", check: { kind: "equals", path: "shots.0.type", value: "hook" } },
      { id: "closing-cta", label: "尾镜是 cta", weight: 15, evaluator: "automatic", check: { kind: "equals", path: "shots.-1.type", value: "cta" } },
      { id: "shot-count", label: "5-8 个分镜", weight: 10, evaluator: "automatic", check: { kind: "length", path: "shots", min: 5, max: 8 } },
      { id: "duration-range", label: "总时长 15-30 秒", weight: 10, evaluator: "automatic", check: { kind: "number-range", path: "totalDuration", min: 15, max: 30 } },
      { id: "duration-sum", label: "分镜时长和与总时长一致", weight: 15, evaluator: "automatic", check: { kind: "sum-equals-path", arrayPath: "shots", field: "duration", targetPath: "totalDuration", tolerance: 0.1 } },
      { id: "voiceover-length", label: "每镜口播可直接配音", weight: 15, evaluator: "automatic", check: { kind: "length", path: "shots.*.voiceover", min: 1, max: 40 } },
      { id: "search-terms", label: "每镜有 1-3 个素材检索词", weight: 10, evaluator: "automatic", check: { kind: "length", path: "shots.*.searchTerms", min: 1, max: 3 } },
      { id: "no-stale-slang", label: "不用过时话术", weight: 10, evaluator: "automatic", check: { kind: "excludes-terms", path: "$", terms: ["绝绝子", "yyds", "家人们", "宝子们"] } },
    ],
  },
  {
    id: "topic.commute-sun.zh.v1",
    version: 1,
    agentId: "topic-script",
    familyId: "script-topic",
    name: "夏日通勤防晒主题成片",
    weight: 100,
    input: {
      userPrompt: "围绕“夏天通勤如何防晒”生成 25 秒非带货主题分镜，只输出 JSON。",
      data: { topic: "夏天通勤如何防晒", style: "knowledge", targetDurationSeconds: 25, locale: "zh" },
    },
    outputKind: "json",
    requiredShape: topicOutputShape,
    rubric: [
      { id: "opening-hook", label: "首镜是 hook", weight: 10, evaluator: "automatic", check: { kind: "equals", path: "shots.0.type", value: "hook" } },
      { id: "closing", label: "尾镜用 cta 表示收束", weight: 10, evaluator: "automatic", check: { kind: "equals", path: "shots.-1.type", value: "cta" } },
      { id: "shot-count", label: "5-9 个分镜", weight: 10, evaluator: "automatic", check: { kind: "length", path: "shots", min: 5, max: 9 } },
      { id: "duration", label: "时长在 15-40 秒", weight: 10, evaluator: "automatic", check: { kind: "number-range", path: "totalDuration", min: 15, max: 40 } },
      { id: "duration-sum", label: "分镜时长和正确", weight: 15, evaluator: "automatic", check: { kind: "sum-equals-path", arrayPath: "shots", field: "duration", targetPath: "totalDuration", tolerance: 0.1 } },
      { id: "search-terms", label: "每镜有可检索英文词", weight: 20, evaluator: "automatic", check: { kind: "length", path: "shots.*.searchTerms", min: 1, max: 3 } },
      { id: "voiceover", label: "口播长度可用", weight: 10, evaluator: "automatic", check: { kind: "length", path: "shots.*.voiceover", min: 1, max: 40 } },
      { id: "non-commercial", label: "不出现商品和下单引导", weight: 15, evaluator: "automatic", check: { kind: "excludes-terms", path: "$", terms: ["下单", "购买", "券后", "链接", "购物车"] } },
    ],
  },
  {
    id: "product-analysis.juicer.zh.v1",
    version: 1,
    agentId: "product-analysis",
    familyId: "vision-ocr",
    name: "便携榨汁杯外观与卖点结构化",
    weight: 100,
    input: {
      userPrompt: "根据商品图和已知资料做结构化分析，看不出的信息不要编造，只输出 JSON。",
      data: { declaredName: "BlendJet 便携榨汁杯", declaredBrand: "BlendJet", declaredCategory: "home" },
      attachments: [{ fixtureId: "golden.product.juicer.v1", mediaType: "image", mimeType: "image/png", description: "厨房场景中的 BlendJet 便携榨汁杯商品图" }],
    },
    outputKind: "json",
    requiredShape: {
      type: "object",
      required: {
        productName: text(80),
        category: { type: "enum", values: ["beauty", "food", "home", "fashion", "tech"] },
        brand: { type: "string", maxLength: 80 },
        visualFeatures: {
          type: "object",
          required: { mainColor: text(40), designStyle: text(80), productForm: text(80), texture: text(80) },
        },
        sellingPoints: shortStringList(2, 5, 80),
        targetAudience: text(160),
        usageScenarios: shortStringList(2, 5, 80),
        painPoints: shortStringList(1, 5, 80),
        videoSuggestions: {
          type: "object",
          required: {
            recommendedAngles: shortStringList(2, 5, 80),
            keyVisuals: shortStringList(2, 5, 80),
            suggestedStyle: { type: "enum", values: ["pain_point", "scene", "comparison", "story"] },
          },
        },
      },
    },
    rubric: [
      { id: "declared-name", label: "商品名不偏离已知资料", weight: 20, evaluator: "automatic", check: { kind: "equals", path: "productName", value: "BlendJet 便携榨汁杯" } },
      { id: "declared-brand", label: "品牌与已知资料一致", weight: 15, evaluator: "automatic", check: { kind: "equals", path: "brand", value: "BlendJet" } },
      { id: "category", label: "品类正确", weight: 15, evaluator: "automatic", check: { kind: "equals", path: "category", value: "home" } },
      { id: "visual-complete", label: "可见外观信息完整", weight: 15, evaluator: "automatic", check: { kind: "non-empty", path: "visualFeatures.*" } },
      { id: "selling-points", label: "2-5 个卖点", weight: 15, evaluator: "automatic", check: { kind: "length", path: "sellingPoints", min: 2, max: 5 } },
      { id: "scenarios", label: "有可用场景", weight: 10, evaluator: "automatic", check: { kind: "length", path: "usageScenarios", min: 2, max: 5 } },
      { id: "video-angles", label: "有可执行拍摄角度", weight: 10, evaluator: "automatic", check: { kind: "length", path: "videoSuggestions.recommendedAngles", min: 2, max: 5 } },
    ],
  },
  {
    id: "publish-copy.oat.zh.v1",
    version: 1,
    agentId: "publish-copy",
    familyId: "structured-short",
    name: "轻食燕麦杯发布文案",
    weight: 100,
    input: {
      userPrompt: "为一款无额外添加糖的即食燕麦杯生成抖音发布文案，只输出 JSON。",
      data: { productName: "谷日燕麦杯", category: "food", platform: "douyin", locale: "zh" },
    },
    outputKind: "json",
    requiredShape: {
      type: "object",
      required: {
        titles: shortStringList(3, 3, 30),
        hashtags: shortStringList(3, 5, 30),
        caption: text(100),
      },
    },
    rubric: [
      { id: "title-count", label: "正好 3 个标题", weight: 20, evaluator: "automatic", check: { kind: "length", path: "titles", min: 3, max: 3 } },
      { id: "title-length", label: "标题不超 15 字", weight: 20, evaluator: "automatic", check: { kind: "length", path: "titles.*", min: 1, max: 15 } },
      { id: "tag-count", label: "3-5 个话题", weight: 15, evaluator: "automatic", check: { kind: "length", path: "hashtags", min: 3, max: 5 } },
      { id: "tag-format", label: "话题以 # 开头", weight: 10, evaluator: "automatic", check: { kind: "matches", path: "hashtags.*", pattern: "^#\\S+$", flags: "u" } },
      { id: "caption-length", label: "种草文案不超 50 字", weight: 20, evaluator: "automatic", check: { kind: "length", path: "caption", min: 1, max: 50 } },
      { id: "no-stale-slang", label: "不用过时话术", weight: 15, evaluator: "automatic", check: { kind: "excludes-terms", path: "$", terms: ["绝绝子", "yyds", "家人们", "宝子们"] } },
    ],
  },
  {
    id: "publish-ranker.inventory.zh.v1",
    version: 1,
    agentId: "publish-ranker",
    familyId: "structured-short",
    name: "有真实数据的库存视频择优",
    weight: 100,
    input: {
      userPrompt: "从候选视频中选 2 条今天发布，不要重复 ID，只输出 JSON。",
      data: {
        count: 2,
        strategy: "data",
        candidates: [
          { id: "proj-a", category: "food", views: 1200, orders: 0, diversityPenalty: 5 },
          { id: "proj-b", category: "home", views: 920, orders: 8, diversityPenalty: 0 },
          { id: "proj-c", category: "beauty", views: 1500, orders: 2, diversityPenalty: 1 },
        ],
      },
    },
    outputKind: "json",
    requiredShape: {
      type: "object",
      required: {
        items: {
          type: "array",
          minItems: 2,
          maxItems: 2,
          items: {
            type: "object",
            required: { id: { type: "enum", values: ["proj-a", "proj-b", "proj-c"] }, reason: text(24) },
          },
        },
      },
    },
    rubric: [
      { id: "count", label: "选出 2 条", weight: 15, evaluator: "automatic", check: { kind: "length", path: "items", min: 2, max: 2 } },
      { id: "allowed-ids", label: "ID 都来自候选池", weight: 20, evaluator: "automatic", check: { kind: "one-of", path: "items.*.id", values: ["proj-a", "proj-b", "proj-c"] } },
      { id: "unique-ids", label: "不重复选择", weight: 20, evaluator: "automatic", check: { kind: "unique", path: "items", by: "id" } },
      { id: "reason-length", label: "理由不超 12 字", weight: 15, evaluator: "automatic", check: { kind: "length", path: "items.*.reason", min: 1, max: 12 } },
      { id: "orders-first", label: "数据优先策略先选高成交内容", weight: 30, evaluator: "automatic", check: { kind: "equals", path: "items.0.id", value: "proj-b" } },
    ],
  },
  {
    id: "diagnose.weak-hook.zh.v1",
    version: 1,
    agentId: "diagnose",
    familyId: "structured-short",
    name: "弱开场脚本发布前诊断",
    weight: 100,
    input: {
      userPrompt: "诊断这条带货脚本：首镜直接介绍参数，结尾有明确到店引导。只输出 JSON。",
      data: { platform: "douyin", totalDuration: 25, knownWeakness: "hook", hasCta: true },
    },
    outputKind: "json",
    requiredShape: {
      type: "object",
      required: {
        dimensions: {
          type: "array",
          minItems: 5,
          maxItems: 5,
          items: {
            type: "object",
            required: {
              key: { type: "enum", values: ["hook", "clarity", "pacing", "copy", "cta"] },
              score: { type: "number", integer: true, min: 0, max: 100 },
              comment: text(60),
            },
          },
        },
        summary: text(80),
        suggestions: shortStringList(1, 3, 60),
      },
    },
    rubric: [
      { id: "all-dimensions", label: "五个维度齐全且不重复", weight: 25, evaluator: "automatic", check: { kind: "set-equals", path: "dimensions.*.key", values: ["hook", "clarity", "pacing", "copy", "cta"] } },
      { id: "score-range", label: "所有分数在 0-100", weight: 15, evaluator: "automatic", check: { kind: "number-range", path: "dimensions.*.score", min: 0, max: 100 } },
      { id: "weak-hook", label: "识别弱开场", weight: 25, evaluator: "automatic", check: { kind: "number-range", path: "dimensions.0.score", min: 0, max: 59 } },
      { id: "comments", label: "评语不超 30 字", weight: 15, evaluator: "automatic", check: { kind: "length", path: "dimensions.*.comment", min: 1, max: 30 } },
      { id: "suggestions", label: "建议 1-3 条且可执行", weight: 10, evaluator: "automatic", check: { kind: "length", path: "suggestions", min: 1, max: 3 } },
      { id: "plain-language", label: "不用运营术语", weight: 10, evaluator: "automatic", check: { kind: "excludes-terms", path: "$", terms: ["完播率", "转化路径", "用户心智"] } },
    ],
  },
  {
    id: "metrics-ocr.douyin-clear.zh.v1",
    version: 1,
    agentId: "metrics-ocr",
    familyId: "vision-ocr",
    name: "清晰抖音数据截图识别",
    weight: 60,
    input: {
      userPrompt: "读取这张数据截图，认不清的字段返回 null，只输出 JSON。",
      data: { fixtureGroundTruth: { platform: "douyin", views: "1.2万", likes: 345, comments: 12, shares: 8, orders: null } },
      attachments: [{ fixtureId: "golden.metrics.douyin-clear.v1", mediaType: "image", mimeType: "image/png", description: "清晰抖音单条作品数据页" }],
    },
    outputKind: "json",
    requiredShape: {
      type: "object",
      required: {
        platform: { type: "union", variants: [{ type: "null" }, { type: "enum", values: ["douyin", "kuaishou", "xiaohongshu", "tiktok"] }] },
        views: metricValue,
        likes: metricValue,
        comments: metricValue,
        shares: metricValue,
        orders: metricValue,
      },
    },
    rubric: [
      { id: "platform", label: "平台正确", weight: 15, evaluator: "automatic", check: { kind: "equals", path: "platform", value: "douyin" } },
      { id: "views", label: "播放数保留原样", weight: 25, evaluator: "automatic", check: { kind: "equals", path: "views", value: "1.2万" } },
      { id: "likes", label: "点赞正确", weight: 15, evaluator: "automatic", check: { kind: "equals", path: "likes", value: 345 } },
      { id: "comments", label: "评论正确", weight: 15, evaluator: "automatic", check: { kind: "equals", path: "comments", value: 12 } },
      { id: "shares", label: "转发正确", weight: 15, evaluator: "automatic", check: { kind: "equals", path: "shares", value: 8 } },
      { id: "orders-null", label: "截图无成交数时不编 0", weight: 15, evaluator: "automatic", check: { kind: "equals", path: "orders", value: null } },
    ],
  },
  {
    id: "metrics-ocr.non-metrics.zh.v1",
    version: 1,
    agentId: "metrics-ocr",
    familyId: "vision-ocr",
    name: "非数据页截图不应幻觉",
    weight: 40,
    input: {
      userPrompt: "读取这张截图；如果不是视频数据页，所有字段返回 null。只输出 JSON。",
      data: { fixtureGroundTruth: { platform: null, views: null, likes: null, comments: null, shares: null, orders: null } },
      attachments: [{ fixtureId: "golden.metrics.chat-page.v1", mediaType: "image", mimeType: "image/png", description: "不含作品数据的聊天页" }],
    },
    outputKind: "json",
    requiredShape: {
      type: "object",
      required: { platform: nullableText, views: metricValue, likes: metricValue, comments: metricValue, shares: metricValue, orders: metricValue },
    },
    rubric: [
      { id: "platform-null", label: "不猜平台", weight: 15, evaluator: "automatic", check: { kind: "equals", path: "platform", value: null } },
      { id: "views-null", label: "不编播放数", weight: 25, evaluator: "automatic", check: { kind: "equals", path: "views", value: null } },
      { id: "likes-null", label: "不编点赞", weight: 15, evaluator: "automatic", check: { kind: "equals", path: "likes", value: null } },
      { id: "comments-null", label: "不编评论", weight: 15, evaluator: "automatic", check: { kind: "equals", path: "comments", value: null } },
      { id: "shares-null", label: "不编转发", weight: 15, evaluator: "automatic", check: { kind: "equals", path: "shares", value: null } },
      { id: "orders-null", label: "不编成交", weight: 15, evaluator: "automatic", check: { kind: "equals", path: "orders", value: null } },
    ],
  },
  {
    id: "retro.low-data.zh.v1",
    version: 1,
    agentId: "retro",
    familyId: "structured-short",
    name: "小样本单条视频复盘",
    weight: 100,
    input: {
      userPrompt: "根据真实数据复盘这条视频，数据少时不要下定论，只输出 JSON。",
      data: { accountSamples: 2, views: 830, likes: 41, comments: 3, shares: 2, orders: 1, diagnosisScore: 68 },
    },
    outputKind: "json",
    requiredShape: {
      type: "object",
      required: {
        highlights: shortStringList(0, 3, 50),
        issues: shortStringList(0, 3, 50),
        nextActions: shortStringList(1, 3, 50),
        summary: text(80),
      },
    },
    rubric: [
      { id: "highlights", label: "亮点最多 3 条", weight: 15, evaluator: "automatic", check: { kind: "length", path: "highlights", min: 0, max: 3 } },
      { id: "issues", label: "问题最多 3 条", weight: 15, evaluator: "automatic", check: { kind: "length", path: "issues", min: 0, max: 3 } },
      { id: "actions", label: "下条行动 1-3 条", weight: 25, evaluator: "automatic", check: { kind: "length", path: "nextActions", min: 1, max: 3 } },
      { id: "item-length", label: "每条不超 25 字", weight: 15, evaluator: "automatic", check: { kind: "length", path: "nextActions.*", min: 1, max: 25 } },
      { id: "summary", label: "总结不超 40 字", weight: 15, evaluator: "automatic", check: { kind: "length", path: "summary", min: 1, max: 40 } },
      { id: "plain-language", label: "不用运营术语", weight: 15, evaluator: "automatic", check: { kind: "excludes-terms", path: "$", terms: ["完播率", "转化路径", "用户心智"] } },
    ],
  },
  {
    id: "weekly-report.low-data.zh.v1",
    version: 1,
    agentId: "weekly-report",
    familyId: "structured-short",
    name: "低数据量账号周报",
    weight: 100,
    input: {
      userPrompt: "把系统算好的一周数据讲成店主看得懂的周报，不自己编数字，只输出 JSON。",
      data: { publishedCount: 2, views: 1760, likes: 86, comments: 7, shares: 5, orders: 1, previousWeekViews: 0 },
    },
    outputKind: "json",
    requiredShape: {
      type: "object",
      required: {
        highlights: shortStringList(0, 3, 50),
        watchouts: shortStringList(0, 3, 50),
        nextActions: shortStringList(1, 3, 50),
        summary: text(80),
      },
    },
    rubric: [
      { id: "highlights", label: "亮点最多 3 条", weight: 15, evaluator: "automatic", check: { kind: "length", path: "highlights", min: 0, max: 3 } },
      { id: "watchouts", label: "注意项最多 3 条", weight: 15, evaluator: "automatic", check: { kind: "length", path: "watchouts", min: 0, max: 3 } },
      { id: "actions", label: "下周行动 1-3 条", weight: 25, evaluator: "automatic", check: { kind: "length", path: "nextActions", min: 1, max: 3 } },
      { id: "action-length", label: "行动建议不超 25 字", weight: 15, evaluator: "automatic", check: { kind: "length", path: "nextActions.*", min: 1, max: 25 } },
      { id: "summary", label: "总结不超 40 字", weight: 15, evaluator: "automatic", check: { kind: "length", path: "summary", min: 1, max: 40 } },
      { id: "plain-language", label: "不用运营术语", weight: 15, evaluator: "automatic", check: { kind: "excludes-terms", path: "$", terms: ["完播率", "转化漏斗", "自然流量"] } },
    ],
  },
  {
    id: "image.product-still-life.v1",
    version: 1,
    agentId: "imageAgent",
    familyId: "image-generation",
    name: "商品主体保真的竖屏素材图",
    weight: 100,
    input: {
      userPrompt: "生成 9:16 竖屏清新厨房商品图，保持杯体造型、商标与颜色不变，不生成人脸和文字。",
      data: { aspectRatio: "9:16", count: 1, safetyMode: "no-face" },
      attachments: [{ fixtureId: "golden.product.juicer.v1", mediaType: "image", mimeType: "image/png", description: "商品参考图" }],
    },
    outputKind: "media",
    requiredShape: { mediaType: "image", minimumArtifacts: 1, humanReviewRequired: true },
    rubric: [
      { id: "identity", label: "商品一致性", weight: 35, evaluator: "human", guidance: "对照参考图检查造型、商标、颜色和材质。", anchors: { 1: "主体或商标明显变形", 3: "整体相似但有小偏差", 5: "关键外观与参考图一致" } },
      { id: "composition", label: "9:16 商用构图", weight: 20, evaluator: "human", guidance: "主体突出，上下留有安全区，可用于短视频。", anchors: { 1: "裁切主体或构图失衡", 3: "可用但安全区一般", 5: "主体和安全区均清晰合理" } },
      { id: "artifacts", label: "画面完整度", weight: 20, evaluator: "human", guidance: "检查重影、融化、无关物和伪字。", anchors: { 1: "明显破图或伪文字", 3: "局部轻微瑕疵", 5: "无可见生成瑕疵" } },
      { id: "prompt-fit", label: "场景符合度", weight: 15, evaluator: "human", guidance: "清新厨房场景与商品合理融合。", anchors: { 1: "场景偏题", 3: "场景大致正确", 5: "场景准确且完成度高" } },
      { id: "safety", label: "人脸与版权风险", weight: 10, evaluator: "human", guidance: "不应出现人脸、额外品牌或可识别受保护角色。", anchors: { 1: "出现明显风险内容", 3: "存在疑似元素需复核", 5: "无可见风险元素" } },
    ],
  },
  {
    id: "video.product-orbit.v1",
    version: 1,
    agentId: "videoAgent",
    familyId: "video-generation",
    name: "商品环绕运镜短视频",
    weight: 100,
    input: {
      userPrompt: "以首帧为参考生成 5 秒慢速环绕运镜，商品保持不变形，画面稳定，不生成人脸。",
      data: { durationSeconds: 5, aspectRatio: "9:16", cameraMotion: "slow-orbit", safetyMode: "no-face" },
      attachments: [{ fixtureId: "golden.product.juicer.v1", mediaType: "image", mimeType: "image/png", description: "9:16 商品场景首帧" }],
    },
    outputKind: "media",
    requiredShape: { mediaType: "video", minimumArtifacts: 1, humanReviewRequired: true },
    rubric: [
      { id: "identity", label: "商品时序一致性", weight: 30, evaluator: "human", guidance: "逐帧检查造型、商标和颜色是否漂移。", anchors: { 1: "多处变形或身份丢失", 3: "轻微漂移但主体可认", 5: "全程主体稳定一致" } },
      { id: "motion", label: "运镜流畅度", weight: 25, evaluator: "human", guidance: "检查环绕运动的连续性、抖动与速度。", anchors: { 1: "跳帧、抖动或运动错乱", 3: "基本流畅但局部生硬", 5: "运镜自然连续" } },
      { id: "artifacts", label: "时序瑕疵", weight: 20, evaluator: "human", guidance: "检查闪烁、背景融化、突变和伪文字。", anchors: { 1: "明显时序破绽", 3: "少量轻微瑕疵", 5: "无明显时序瑕疵" } },
      { id: "prompt-fit", label: "时长和运镜指令符合度", weight: 15, evaluator: "human", guidance: "输出应约 5 秒并呈现慢速环绕。", anchors: { 1: "时长或运镜明显不符", 3: "大致符合", 5: "时长与运镜均准确" } },
      { id: "safety", label: "安全要求", weight: 10, evaluator: "human", guidance: "不出现人脸或额外品牌。", anchors: { 1: "出现明显风险元素", 3: "存在疑似元素", 5: "无风险元素" } },
    ],
  },
  {
    id: "tts.mandarin-product.zh.v1",
    version: 1,
    agentId: "ttsAgent",
    familyId: "tts",
    name: "中文商品口播配音",
    weight: 100,
    input: {
      userPrompt: "生成自然、清晰、不夸张的普通话商品口播。",
      data: { text: "早上赶时间，这杯燕麦加牛奶拌一拌，三分钟就能带走。", locale: "zh-CN", speed: 1, expectedDurationSeconds: [5, 11] },
    },
    outputKind: "media",
    requiredShape: { mediaType: "audio", minimumArtifacts: 1, humanReviewRequired: true },
    rubric: [
      { id: "intelligibility", label: "可懂度", weight: 30, evaluator: "human", guidance: "听辨每个词，无吞字、错读和断句错位。", anchors: { 1: "多处听不清或错读", 3: "基本听清，偶有生硬", 5: "全程清晰准确" } },
      { id: "naturalness", label: "自然度", weight: 25, evaluator: "human", guidance: "语气、连读和呼吸感接近真人。", anchors: { 1: "机械或音素拼接感强", 3: "可用但仍有合成感", 5: "自然接近真人口播" } },
      { id: "prosody", label: "节奏与重音", weight: 20, evaluator: "human", guidance: "节奏匹配短视频，关键卖点有合理重音。", anchors: { 1: "速度或重音明显错乱", 3: "节奏平稳但缺少层次", 5: "节奏和重音自然有效" } },
      { id: "artifacts", label: "音频瑕疵", weight: 15, evaluator: "human", guidance: "检查电流声、爆音、截断、重复与底噪。", anchors: { 1: "瑕疵影响使用", 3: "少量轻微瑕疵", 5: "无可闻瑕疵" } },
      { id: "duration", label: "时长可用", weight: 10, evaluator: "human", guidance: "完整口播约 5-11 秒，不得加速到听不清。", anchors: { 1: "时长明显失控或内容截断", 3: "时长可用但稍快/慢", 5: "时长和节奏均合适" } },
    ],
  },
];

export function getCapabilityFamilyForAgent(agentId: GoldenAgentId): CapabilityFamilyDefinition {
  const family = CAPABILITY_FAMILIES.find((item) => item.agentIds.includes(agentId));
  if (!family) throw new Error(`Agent ${agentId} 没有能力族配置`);
  return family;
}

export function getGoldenCasesForAgent(agentId: GoldenAgentId): readonly GoldenCase[] {
  return GOLDEN_CASES.filter((item) => item.agentId === agentId);
}

export function getGoldenCase(caseId: string): GoldenCase {
  const goldenCase = GOLDEN_CASES.find((item) => item.id === caseId);
  if (!goldenCase) throw new Error(`未知 Golden Case: ${caseId}`);
  return goldenCase;
}

/**
 * 在路由启动评测前调用；防止后续新增 Agent/case 时遗漏权重或误把媒体
 * 任务接到 chat completion。
 */
export function validateGoldenSetIntegrity(): string[] {
  const issues: string[] = [];
  const familyByAgent = new Map<GoldenAgentId, CapabilityFamilyDefinition>();

  for (const family of CAPABILITY_FAMILIES) {
    for (const agentId of family.agentIds) {
      if (familyByAgent.has(agentId)) issues.push(`Agent ${agentId} 被分配到多个能力族`);
      familyByAgent.set(agentId, family);
    }
  }

  const seenCaseIds = new Set<string>();
  for (const goldenCase of GOLDEN_CASES) {
    if (seenCaseIds.has(goldenCase.id)) issues.push(`Golden Case ID 重复: ${goldenCase.id}`);
    seenCaseIds.add(goldenCase.id);

    const family = familyByAgent.get(goldenCase.agentId);
    if (!family) issues.push(`Case ${goldenCase.id} 的 Agent 没有能力族`);
    if (family && family.id !== goldenCase.familyId) issues.push(`Case ${goldenCase.id} 的能力族与 Agent 不一致`);

    const rubricWeight = goldenCase.rubric.reduce((sum, item) => sum + item.weight, 0);
    if (Math.abs(rubricWeight - 100) > 1e-9) issues.push(`Case ${goldenCase.id} 的 rubric 权重和为 ${rubricWeight}，应为 100`);
    if (goldenCase.rubric.some((item) => item.weight <= 0)) issues.push(`Case ${goldenCase.id} 存在非正权重`);

    if (goldenCase.outputKind === "media") {
      if (goldenCase.rubric.some((item) => item.evaluator !== "human")) issues.push(`媒体 Case ${goldenCase.id} 必须全部人工评分`);
      if (family && (family.requestKind === "chat-json" || family.requestKind === "vision-json")) issues.push(`媒体 Case ${goldenCase.id} 不得使用 chat/vision JSON 执行器`);
    } else if (goldenCase.rubric.some((item) => item.evaluator !== "automatic")) {
      issues.push(`JSON Case ${goldenCase.id} 的基础分应可确定性计算`);
    }
  }

  for (const agentId of GOLDEN_AGENT_IDS) {
    if (!familyByAgent.has(agentId)) issues.push(`Agent ${agentId} 没有能力族`);
    const cases = getGoldenCasesForAgent(agentId);
    if (cases.length === 0) {
      issues.push(`Agent ${agentId} 没有 Golden Case`);
      continue;
    }
    const caseWeight = cases.reduce((sum, item) => sum + item.weight, 0);
    if (Math.abs(caseWeight - 100) > 1e-9) issues.push(`Agent ${agentId} 的 case 权重和为 ${caseWeight}，应为 100`);
  }

  return issues;
}
