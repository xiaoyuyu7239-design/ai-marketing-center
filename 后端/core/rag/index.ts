/**
 * 素材 RAG 对外入口。
 * 路由只需 buildRagHint / composeRagQuery；其余在内部装配。
 */
export { buildRagHint, retrieveRagSamples, structuralFilter, __resetRagVectorCache } from "./retriever";
export { ensureRagSeeded, seedRagSamples, __resetRagSeedLock } from "./seed";
export {
  buildStaticKnowledgeBase,
  userTemplateToSample,
  metricsTopToSample,
  RAG_SEED_VERSION,
} from "./knowledge-base";
export {
  embedBatch,
  embedOne,
  lexicalEmbed,
  cosineSimilarity,
  activeEmbedderId,
  tokenize,
  LEXICAL_EMBEDDER_ID,
  NEURAL_EMBEDDER_ID,
  EMBEDDING_DIM,
} from "./embed";
export type {
  RagQuery,
  RagSampleRecord,
  RagSampleSource,
  RagRetrievalHit,
  RagRetrievalResult,
  RagSampleStructure,
} from "./types";

import type { RagQuery } from "./types";

/** 组装 RAG 查询文本：卖点分析摘要 + 商家画像 + 用户补充说明拼接（截断防超长） */
export function composeRagQueryText(parts: {
  productName?: string | null;
  productAnalysis?: string | null;
  productDescription?: string | null;
  usageAdvantage?: string | null;
  targetAudience?: string | null;
  priceRange?: string | null;
  shopName?: string | null;
  region?: string | null;
  landmark?: string | null;
}): string {
  const segments = [
    parts.productName,
    parts.productAnalysis,
    parts.productDescription,
    parts.usageAdvantage,
    parts.targetAudience,
    parts.priceRange,
    parts.shopName,
    parts.region,
    parts.landmark,
  ]
    .map((v) => (v ?? "").trim())
    .filter(Boolean);
  // 卖点分析可能很长，整体截到 1500 字，足够词法/神经编码器提取语义且不拖慢
  return segments.join("\n").slice(0, 1500);
}

/** 便捷组装完整 RagQuery（供路由使用） */
export function composeRagQuery(input: {
  text: string;
  category?: string | null;
  storeType?: string | null;
  videoMode?: string | null;
  styleType?: string | null;
  platform?: string | null;
}): RagQuery {
  return {
    text: input.text,
    category: input.category ?? null,
    storeType: input.storeType ?? null,
    videoMode: input.videoMode ?? null,
    styleType: input.styleType ?? null,
    platform: input.platform ?? null,
  };
}
