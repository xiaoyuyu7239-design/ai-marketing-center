/**
 * RAG 知识库装配 —— 把项目里已有的静态资产整理成可检索语料（不新造内容，只做结构化）。
 *
 * 种子来源（对应交接简报 §1 现有地基）：
 * 1. 品类脚本模板 后端/script-engine/templates/*   → 结构骨架（source=template）
 * 2. 品类创作指令 *PromptDirective                  → 要点表达（source=category_directive）
 * 3. 黄金3秒钩子 hook-patterns.ts HOOK_PATTERNS      → 开场表达（source=hook）
 * 4. 同城热点选题 prompts.ts LOCAL_TREND_HOOKS       → 本地门店场景（source=local_trend）
 *
 * 增量来源（真实现接口，冷启动无数据）：
 * - 用户沉淀模板 script_templates 表 → userTemplateToSample()
 * - 高转化回流 publish_metrics join scripts → metricsTopToSample()（内测有数据后接入）
 */
import {
  beautyTemplates,
  beautyPromptDirective,
  foodTemplates,
  foodPromptDirective,
  homeTemplates,
  homePromptDirective,
  fashionTemplates,
  fashionPromptDirective,
  techTemplates,
  techPromptDirective,
  categoryNameMap,
  type ProductCategory,
  type ScriptTemplate,
} from "@backend/script-engine/templates";
import { HOOK_PATTERNS } from "@backend/script-engine/hook-patterns";
import { LOCAL_TREND_HOOKS } from "@backend/script-engine/prompts";
import { scriptTemplates } from "@backend/db/schema";
import type { Shot } from "@backend/db/schema";
import type { RagSampleRecord } from "./types";

/** script_templates 表行类型 */
export type UserScriptTemplateRow = typeof scriptTemplates.$inferSelect;

/** 种子版本：知识库内容或装配逻辑变化时 +1，检索器据此幂等重灌（见 seed.ts） */
export const RAG_SEED_VERSION = 1;

const CATEGORY_ASSETS: Record<
  ProductCategory,
  { templates: ScriptTemplate[]; directive: string }
> = {
  beauty: { templates: beautyTemplates, directive: beautyPromptDirective },
  food: { templates: foodTemplates, directive: foodPromptDirective },
  home: { templates: homeTemplates, directive: homePromptDirective },
  fashion: { templates: fashionTemplates, directive: fashionPromptDirective },
  tech: { templates: techTemplates, directive: techPromptDirective },
};

/** 同城热点键 → 品类（common/other 视为通用） */
const LOCAL_TREND_CATEGORY: Record<string, ProductCategory | null> = {
  common: null,
  food: "food",
  beauty: "beauty",
  fashion: "fashion",
  home: "home",
  tech: "tech",
  other: null,
};

/** 取一句话短标签（用于 scene 字段）：截到首个分隔符或前 14 字 */
function shortLabel(text: string): string {
  const head = text.split(/[：:／/。，,\n]/)[0].trim();
  return head.length > 14 ? head.slice(0, 14) : head;
}

/** 稳定 slug：把名称压成 ASCII 安全片段，配合前缀构成确定性 id */
function slug(text: string): string {
  return Array.from(text)
    .map((ch) => ch.charCodeAt(0).toString(36))
    .join("")
    .slice(0, 24);
}

/** 品类脚本模板 → 结构骨架样本 */
function templateSamples(): RagSampleRecord[] {
  const out: RagSampleRecord[] = [];
  for (const [category, { templates }] of Object.entries(CATEGORY_ASSETS) as [ProductCategory, { templates: ScriptTemplate[] }][]) {
    const categoryName = categoryNameMap[category];
    templates.forEach((tpl, index) => {
      const searchText = [
        categoryName,
        tpl.name,
        tpl.description,
        tpl.suitableFor.join(" "),
        tpl.example,
      ]
        .filter(Boolean)
        .join("\n");
      out.push({
        id: `template:${category}:${index}:${slug(tpl.name)}`,
        category,
        industry: category,
        scene: tpl.name,
        storeType: null, // 结构骨架对电商/同城都通用
        structure: {
          name: tpl.name,
          summary: tpl.description,
          shots: tpl.shotStructure.map((s) => ({
            type: String(s.type),
            duration: s.duration ?? 0,
            camera: s.camera,
          })),
        },
        expression: tpl.example,
        searchText,
        source: "template",
      });
    });
  }
  return out;
}

/** 品类创作指令 → 要点表达样本 */
function categoryDirectiveSamples(): RagSampleRecord[] {
  const out: RagSampleRecord[] = [];
  for (const [category, { directive }] of Object.entries(CATEGORY_ASSETS) as [ProductCategory, { directive: string }][]) {
    const categoryName = categoryNameMap[category];
    const text = directive.trim();
    out.push({
      id: `category_directive:${category}`,
      category,
      industry: category,
      scene: `${categoryName}品类创作要点`,
      storeType: null,
      expression: text,
      searchText: `${categoryName}品类创作要点\n${text}`,
      source: "category_directive",
    });
  }
  return out;
}

/** 黄金3秒钩子 → 开场表达样本（category 置空作为通用表达库，靠语义排序命中相关钩子） */
function hookSamples(): RagSampleRecord[] {
  return HOOK_PATTERNS.map((hook) => {
    const searchText = [hook.name, hook.stop, hook.prove, hook.bridge, hook.example]
      .filter(Boolean)
      .join("\n");
    return {
      id: `hook:${hook.id}`,
      category: null, // 通用开场表达库
      scene: hook.name,
      storeType: null,
      expression: `【${hook.name}】${hook.example}`,
      searchText,
      source: "hook",
    } satisfies RagSampleRecord;
  });
}

/** 同城热点选题 → 本地门店场景样本（storeType=local，仅同城/两者门店可召回） */
function localTrendSamples(): RagSampleRecord[] {
  const out: RagSampleRecord[] = [];
  for (const [key, items] of Object.entries(LOCAL_TREND_HOOKS)) {
    const category = LOCAL_TREND_CATEGORY[key] ?? null;
    items.forEach((item, index) => {
      out.push({
        id: `local_trend:${key}:${index}`,
        category,
        industry: category,
        scene: shortLabel(item),
        storeType: "local", // 仅同城/两者门店可召回；styleType 留空，不按风格硬排除场景点子
        expression: item,
        searchText: item,
        source: "local_trend",
      });
    });
  }
  return out;
}

/**
 * 装配全部静态种子样本（无 embedding；embedding 由 seed.ts 预计算落库）。
 * 纯函数、可单测。
 */
export function buildStaticKnowledgeBase(): RagSampleRecord[] {
  return [
    ...templateSamples(),
    ...categoryDirectiveSamples(),
    ...hookSamples(),
    ...localTrendSamples(),
  ];
}

// ==================== 增量来源转换器（真实现接口） ====================

/** 用户沉淀模板行 → RAG 样本（script_templates 表；全局共享，冷启动为空） */
export function userTemplateToSample(row: UserScriptTemplateRow): RagSampleRecord {
  const shots = (row.shots ?? []) as Shot[];
  const searchText = [
    row.name,
    row.description ?? "",
    row.category ?? "",
    shots.map((s) => s.voiceover).filter(Boolean).join(" "),
  ]
    .filter(Boolean)
    .join("\n");
  return {
    id: `user_template:${row.id}`,
    category: row.category ?? null,
    scene: row.name,
    styleType: row.styleType ?? null,
    videoMode: row.videoMode ?? null,
    storeType: null,
    structure: {
      name: row.name,
      shots: shots.map((s) => ({ type: String(s.type), duration: s.duration ?? 0, camera: s.camera })),
    },
    expression: shots.map((s) => s.voiceover).filter(Boolean).join("｜") || null,
    searchText,
    source: "user_template",
  };
}

/** 高转化回流样本入参（publish_metrics join scripts 的最小子集；内测有数据后接入） */
export interface MetricsTopSampleInput {
  scriptId: string;
  category?: string | null;
  styleType?: string | null;
  platform?: string | null;
  title?: string | null;
  voiceovers?: string[];
  shots?: Array<{ type: string; duration: number; camera?: string }>;
}

/** 高转化样本 → RAG 样本（先留接口，等 publish_metrics 有真实转化数据再在 seed 阶段接入） */
export function metricsTopToSample(input: MetricsTopSampleInput): RagSampleRecord {
  const searchText = [input.title ?? "", input.category ?? "", (input.voiceovers ?? []).join(" ")]
    .filter(Boolean)
    .join("\n");
  return {
    id: `metrics_top:${input.scriptId}`,
    category: input.category ?? null,
    scene: input.title ?? "高转化样本",
    styleType: input.styleType ?? null,
    platform: input.platform ?? null,
    storeType: null,
    structure: input.shots?.length ? { name: input.title ?? "高转化结构", shots: input.shots } : null,
    expression: (input.voiceovers ?? []).join("｜") || null,
    searchText,
    source: "metrics_top",
  };
}
