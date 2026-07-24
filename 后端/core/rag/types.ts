/**
 * 素材 RAG 的共享类型。
 *
 * 设计取舍（写进 19 号技术方案）：轻量素材 RAG，规模千级样本，
 * 用 SQLite 存 embedding + 内存余弦即可，不引入向量数据库。
 * 检索分两级：先结构化硬过滤（品类/经营形态/视频模式/内容方向/平台），再语义 top-k。
 */
import type { RagSampleStructure } from "@backend/db/schema";

export type { RagSampleStructure } from "@backend/db/schema";

/** 样本来源：种子静态资产 + 未来增量来源 */
export type RagSampleSource =
  | "template" // 品类脚本模板（结构骨架）
  | "hook" // 黄金3秒钩子（开场表达）
  | "local_trend" // 同城热点选题（本地门店场景）
  | "category_directive" // 品类创作指令（要点表达）
  | "user_template" // 用户沉淀模板（增量，先留接口）
  | "metrics_top"; // 高转化回流样本（增量，内测后有数据）

/** 一条 RAG 语料样本（内存态；embedding 可选，缺失时由检索器按需补算） */
export interface RagSampleRecord {
  id: string;
  industry?: string | null;
  category?: string | null;
  scene?: string | null;
  platform?: string | null;
  styleType?: string | null;
  videoMode?: string | null;
  storeType?: string | null;
  structure?: RagSampleStructure | null;
  expression?: string | null;
  /** 拼接后的检索文本；embedding 与词法回退都基于它 */
  searchText: string;
  /** 预计算向量（number[]）；缺失时检索器按需补算 */
  embedding?: number[] | null;
  /** 生成 embedding 的编码器标识，避免跨编码器维度错配 */
  embeddingModel?: string | null;
  source: RagSampleSource;
  seedVersion?: number;
}

/** 检索查询：由商品卖点分析摘要 + 商家画像 + 用户补充说明组装而成 */
export interface RagQuery {
  /** 语义查询文本（卖点摘要 + 画像 + 补充说明拼接） */
  text: string;
  /** 品类（beauty/food/home/fashion/tech），硬过滤主键 */
  category?: string | null;
  /** 经营形态：ecommerce/local/both；决定电商 vs 同城分流 */
  storeType?: string | null;
  /** 视频模式：product_closeup/scene_demo/... */
  videoMode?: string | null;
  /** 内容方向/脚本风格：pain_point/comparison/mood/local/... */
  styleType?: string | null;
  /** 发布平台：douyin/xiaohongshu/...（取主投平台一个即可） */
  platform?: string | null;
}

/** 单条命中结果（含得分与命中理由，供评测与日志） */
export interface RagRetrievalHit {
  sample: RagSampleRecord;
  /** 语义相似度得分（余弦，0..1 归一后） */
  score: number;
  /** 是否走了语义排序（false = 纯结构化降级） */
  semantic: boolean;
}

/** 检索结果（含降级标记，供评测/日志区分链路） */
export interface RagRetrievalResult {
  hits: RagRetrievalHit[];
  /** 命中语料条数 */
  candidateCount: number;
  /** 走了哪条链路：semantic=向量排序 / structural=纯结构化降级 / empty=无候选 */
  mode: "semantic" | "structural" | "empty";
  /** 实际使用的编码器标识 */
  embedderId: string;
}
