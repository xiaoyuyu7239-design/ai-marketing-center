/**
 * 轻量素材 RAG 检索器（两级混合检索）。
 *
 * 一级：结构化硬过滤 —— 品类 / 经营形态 / 视频模式 / 内容方向 / 平台。
 *   采用「显式声明冲突才排除」：样本某标签为空视为通用、不排除；仅当样本声明了该标签且与 query 冲突时才剔除。
 *   这样既满足「不匹配的直接不进候选」，又不会因种子样本标签稀疏而把候选清空。
 * 二级：语义排序 —— 本地 embedding 余弦相似度取 top-k（默认 k=3）。
 *
 * 降级链（对应交接简报 §2）：
 *   编码器失败 → 纯结构化过滤按稳定优先级取 top-k；
 *   过滤无候选 → 返回空串（等于现状，零风险）。
 * 检索不计商家配额（系统辅助）。整个 buildRagHint 不抛错，任何异常都回退空串。
 */
import { getDb } from "@backend/db";
import { ragSamples } from "@backend/db/schema";
import { categoryNameMap } from "@backend/script-engine/templates";
import { activeEmbedderId, cosineSimilarity, embedBatch, type EmbedBatchResult } from "./embed";
import { ensureRagSeeded } from "./seed";
import type { RagQuery, RagRetrievalResult, RagSampleRecord, RagSampleSource } from "./types";

export interface RetrieveOptions {
  /** 取前 k 条（默认 3） */
  topK?: number;
  /** 直接注入候选语料（测试用，跳过 DB 加载） */
  samples?: RagSampleRecord[];
  /** 自定义语料加载器（测试用） */
  loadSamples?: () => Promise<RagSampleRecord[]>;
  /** 自定义编码器（测试降级路径用；抛错即触发结构化降级） */
  embedder?: (texts: string[]) => EmbedBatchResult;
}

/** 来源优先级：结构类样本更有参考价值，排在表达类之前（并列得分时的稳定次序） */
const SOURCE_PRIORITY: Record<RagSampleSource, number> = {
  metrics_top: 0,
  user_template: 1,
  template: 2,
  local_trend: 3,
  hook: 4,
  category_directive: 5,
};

/** 经营形态兼容：样本形态 vs 查询形态 */
function storeTypeCompatible(sampleStore?: string | null, queryStore?: string | null): boolean {
  if (!sampleStore) return true; // 通用样本
  if (!queryStore) return true; // 查询未知形态时不排除
  if (sampleStore === "both") return true;
  if (sampleStore === "local") return queryStore === "local" || queryStore === "both";
  if (sampleStore === "ecommerce") return queryStore === "ecommerce" || queryStore === "both";
  return true;
}

/** 一级结构化硬过滤（纯函数，可单测）：显式声明冲突才排除 */
export function structuralFilter(samples: RagSampleRecord[], query: RagQuery): RagSampleRecord[] {
  return samples.filter((s) => {
    if (query.category && s.category && s.category !== query.category) return false;
    if (!storeTypeCompatible(s.storeType, query.storeType)) return false;
    if (query.videoMode && s.videoMode && s.videoMode !== query.videoMode) return false;
    if (query.styleType && s.styleType && s.styleType !== query.styleType) return false;
    if (query.platform && s.platform && s.platform !== query.platform) return false;
    return true;
  });
}

/** 结构化降级排序：品类命中优先 → 来源优先级 → id 稳定序 */
function structuralRank(candidates: RagSampleRecord[], query: RagQuery): RagSampleRecord[] {
  return [...candidates].sort((a, b) => {
    const aCat = query.category && a.category === query.category ? 1 : 0;
    const bCat = query.category && b.category === query.category ? 1 : 0;
    if (aCat !== bCat) return bCat - aCat;
    const aPri = SOURCE_PRIORITY[a.source] ?? 9;
    const bPri = SOURCE_PRIORITY[b.source] ?? 9;
    if (aPri !== bPri) return aPri - bPri;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

// 候选向量缓存：键 `${embedderId}::${id}`。千级样本足够；超上限整体清空（简单稳妥）。
const candidateVectorCache = new Map<string, number[]>();
const CACHE_LIMIT = 4000;

function cacheGet(embedderId: string, id: string): number[] | undefined {
  return candidateVectorCache.get(`${embedderId}::${id}`);
}
function cacheSet(embedderId: string, id: string, vec: number[]): void {
  if (candidateVectorCache.size > CACHE_LIMIT) candidateVectorCache.clear();
  candidateVectorCache.set(`${embedderId}::${id}`, vec);
}

/** 测试用：清空候选向量缓存 */
export function __resetRagVectorCache(): void {
  candidateVectorCache.clear();
}

/** 默认语料加载：确保已灌库后从 rag_samples 全量读出 */
async function defaultLoadSamples(): Promise<RagSampleRecord[]> {
  const db = getDb();
  await ensureRagSeeded(db);
  const rows = await db.select().from(ragSamples);
  return rows.map((r) => ({
    id: r.id,
    industry: r.industry,
    category: r.category,
    scene: r.scene,
    platform: r.platform,
    styleType: r.styleType,
    videoMode: r.videoMode,
    storeType: r.storeType,
    structure: r.structure ?? null,
    expression: r.expression,
    searchText: r.searchText,
    embedding: r.embedding ?? null,
    embeddingModel: r.embeddingModel,
    source: r.source,
    seedVersion: r.seedVersion ?? undefined,
  }));
}

function structuralResult(candidates: RagSampleRecord[], query: RagQuery, topK: number): RagRetrievalResult {
  const ranked = structuralRank(candidates, query).slice(0, topK);
  return {
    hits: ranked.map((sample) => ({ sample, score: 0, semantic: false })),
    candidateCount: candidates.length,
    mode: "structural",
    embedderId: activeEmbedderId(),
  };
}

/**
 * 检索：结构化过滤 → 语义排序 top-k，附带降级。绝不抛错。
 */
export async function retrieveRagSamples(query: RagQuery, opts: RetrieveOptions = {}): Promise<RagRetrievalResult> {
  const topK = opts.topK ?? 3;
  const embedder = opts.embedder ?? embedBatch;

  // 加载语料（失败按空结果处理）
  let samples: RagSampleRecord[];
  try {
    samples = opts.samples ?? (opts.loadSamples ? await opts.loadSamples() : await defaultLoadSamples());
  } catch (err) {
    console.warn("RAG 语料加载失败（已跳过检索）:", (err as Error)?.message ?? err);
    return { hits: [], candidateCount: 0, mode: "empty", embedderId: activeEmbedderId() };
  }

  // 一级：结构化硬过滤
  const candidates = structuralFilter(samples, query);
  if (candidates.length === 0) {
    return { hits: [], candidateCount: 0, mode: "empty", embedderId: activeEmbedderId() };
  }

  // 二级：语义排序（编码器失败 → 结构化降级）
  const text = (query.text || "").trim();
  let queryVec: number[] | undefined;
  let embedderId: string | undefined;
  if (text) {
    try {
      const q = embedder([text]);
      queryVec = q.vectors[0];
      embedderId = q.embedderId;
    } catch (err) {
      console.warn("RAG 查询编码失败，降级为结构化过滤:", (err as Error)?.message ?? err);
    }
  }
  if (!queryVec || !queryVec.length || !embedderId) {
    return structuralResult(candidates, query, topK);
  }

  // 解析候选向量：缓存 → 同编码器预存向量 → 现算（保证与 query 同编码器）
  const vecById = new Map<string, number[]>();
  const toRecompute: RagSampleRecord[] = [];
  for (const c of candidates) {
    const cached = cacheGet(embedderId, c.id);
    if (cached) {
      vecById.set(c.id, cached);
      continue;
    }
    if (c.embedding && c.embedding.length && c.embeddingModel === embedderId) {
      cacheSet(embedderId, c.id, c.embedding);
      vecById.set(c.id, c.embedding);
      continue;
    }
    toRecompute.push(c);
  }
  if (toRecompute.length) {
    try {
      const recomputed = embedder(toRecompute.map((c) => c.searchText));
      // 现算若落到与 query 不同的编码器（如神经中途抖动回退词法），无法同空间比较 → 结构化降级
      if (recomputed.embedderId !== embedderId) {
        return structuralResult(candidates, query, topK);
      }
      toRecompute.forEach((c, i) => {
        const v = recomputed.vectors[i];
        if (v && v.length) {
          cacheSet(embedderId!, c.id, v);
          vecById.set(c.id, v);
        }
      });
    } catch (err) {
      console.warn("RAG 候选编码失败，降级为结构化过滤:", (err as Error)?.message ?? err);
      return structuralResult(candidates, query, topK);
    }
  }

  const scored = candidates
    .map((sample) => ({ sample, score: cosineSimilarity(queryVec!, vecById.get(sample.id) ?? []), semantic: true }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const aPri = SOURCE_PRIORITY[a.sample.source] ?? 9;
      const bPri = SOURCE_PRIORITY[b.sample.source] ?? 9;
      if (aPri !== bPri) return aPri - bPri;
      return a.sample.id < b.sample.id ? -1 : 1;
    });

  return {
    hits: scored.slice(0, topK),
    candidateCount: candidates.length,
    mode: "semantic",
    embedderId,
  };
}

// ==================== 注入提示装配 ====================

/** 分镜类型 → 中文标签（用于结构提示可读性） */
const SHOT_TYPE_LABEL: Record<string, string> = {
  hook: "黄金3秒",
  pain_point: "痛点",
  product_reveal: "产品亮相",
  demo: "演示",
  social_proof: "信任背书",
  cta: "行动号召",
};

function trimText(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

const RAG_HINT_HEADER =
  "【同行优质结构参考（按你的品类/场景匹配到的高质量样本，供借鉴；表达请重写，不得直接照搬）】";

/**
 * 组装可注入 LLM 的 RAG 提示段（格式参照 buildPerformanceHint）。
 * 无命中或降级到空 → 返回空串，调用方无需注入（等于现状，零风险）。
 */
export async function buildRagHint(query: RagQuery, opts: RetrieveOptions = {}): Promise<string> {
  try {
    const result = await retrieveRagSamples(query, opts);
    if (!result.hits.length) return "";

    const lines: string[] = [];
    const seen = new Set<string>();
    for (const hit of result.hits) {
      const s = hit.sample;
      let line = "";
      if (s.structure && s.structure.shots?.length) {
        const shots = s.structure.shots
          .map((shot) => `${SHOT_TYPE_LABEL[shot.type] ?? shot.type}(${shot.duration}s)`)
          .join("→");
        const catLabel = s.category ? categoryNameMap[s.category as keyof typeof categoryNameMap] ?? s.category : "";
        line = `- 参考结构「${s.structure.name}」${catLabel ? `（${catLabel}）` : ""}：${shots}`;
      } else if (s.source === "local_trend" && s.expression) {
        line = `- 同城场景角度：${trimText(s.expression, 80)}`;
      } else if (s.expression) {
        line = `- 优质表达示例：${trimText(s.expression, 100)}`;
      } else if (s.scene) {
        line = `- 参考角度：${trimText(s.scene, 60)}`;
      }
      if (line && !seen.has(line)) {
        seen.add(line);
        lines.push(line);
      }
    }
    if (!lines.length) return "";
    return `${RAG_HINT_HEADER}\n${lines.join("\n")}`;
  } catch (err) {
    console.warn("RAG 提示装配失败（已跳过注入）:", (err as Error)?.message ?? err);
    return "";
  }
}
