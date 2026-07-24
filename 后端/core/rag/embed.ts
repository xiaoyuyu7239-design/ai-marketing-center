/**
 * 本地 embedding —— 零成本、离线、无网络依赖。
 *
 * 选型取舍（写进 19 号技术方案）：
 * - 默认「词法编码器」lexical-charhash-v1：纯 JS、零依赖、零下载、确定性，
 *   对中文短营销文本做「字 unigram + bigram」特征哈希 + L2 归一，配合结构化硬过滤已足够重排同品类候选。
 *   这就是「不烧付费余额 / 免费兜底」纪律下最稳的默认实现，且千级样本用内存余弦即可，不需要向量库。
 * - 可选「神经编码器」（bge-small-zh via transformers.js）：仿 tools/matting 做成独立子工具
 *   tools/rag-embed，通过子进程调用，主程序零静态依赖（不进 webpack/standalone，避免体积门禁）。
 *   仅当 HUIMAI_RAG_EMBEDDER=neural 且子工具与模型就绪时启用；任何失败自动回退词法编码器。
 *
 * 关键约束：query 与候选必须用「同一编码器」算向量，否则余弦无意义。因此每条向量都带 embeddingModel 标签，
 * 检索器只在标签一致时复用预存向量，否则按活动编码器现算（见 retriever.ts）。
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";

/** 向量维度（词法与神经编码器都对齐到该维，方便存储与调试；语义仍由各自编码器决定） */
export const EMBEDDING_DIM = 512;

/** 默认词法编码器标识（随算法或维度变化时必须改版本号，避免复用旧向量） */
export const LEXICAL_EMBEDDER_ID = "lexical-charhash-v1";

/** 神经编码器标识（bge-small-zh-v1.5，512 维） */
export const NEURAL_EMBEDDER_ID = "bge-small-zh-v1.5";

/** 一批文本的编码结果 */
export interface EmbedBatchResult {
  vectors: number[][];
  embedderId: string;
}

// ==================== 词法编码器（默认，纯 JS，离线） ====================

/** FNV-1a 32 位字符串哈希（稳定、跨进程一致） */
function fnv1a(str: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    // 乘以 16777619，用 Math.imul 保持 32 位溢出语义
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * 分词：中文按「字 unigram + 相邻 bigram」，英文/数字按小写词元。
 * 这套对中文短文本的字面重叠很稳，且完全确定性、无外部词典。
 */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  const normalized = (text || "").toLowerCase();
  // 把连续的 CJK 段与 ASCII 词元分别取出
  const segments = normalized.match(/[一-鿿]+|[a-z0-9]+/g) || [];
  for (const seg of segments) {
    if (/^[a-z0-9]+$/.test(seg)) {
      tokens.push(seg);
      continue;
    }
    // CJK 段：unigram + bigram
    for (let i = 0; i < seg.length; i++) {
      tokens.push(seg[i]);
      if (i + 1 < seg.length) tokens.push(seg[i] + seg[i + 1]);
    }
  }
  return tokens;
}

/** 词法向量：特征哈希 + 带符号累加 + 亚线性 tf 抑制 + L2 归一 */
export function lexicalEmbed(text: string): number[] {
  const vec = new Array<number>(EMBEDDING_DIM).fill(0);
  const tf = new Map<string, number>();
  for (const tok of tokenize(text)) tf.set(tok, (tf.get(tok) || 0) + 1);
  for (const [tok, count] of tf) {
    const h = fnv1a(tok);
    const bucket = h % EMBEDDING_DIM;
    const sign = (h >>> 31) & 1 ? -1 : 1; // 第二哈希位定符号，减少碰撞抵消偏差
    const weight = 1 + Math.log(count); // 亚线性：重复词不过度主导
    vec[bucket] += sign * weight;
  }
  return l2normalize(vec);
}

/** L2 归一（零向量原样返回，余弦对零向量记 0） */
export function l2normalize(vec: number[]): number[] {
  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm);
  if (norm === 0) return vec;
  return vec.map((v) => v / norm);
}

/** 余弦相似度（输入未必归一，这里按定义算，稳健） */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// ==================== 神经编码器（可选，独立子工具，子进程调用） ====================

/** 是否请求启用神经编码器 */
function neuralRequested(): boolean {
  return String(process.env.HUIMAI_RAG_EMBEDDER || "").toLowerCase() === "neural";
}

/** 子工具入口路径（可用 HUIMAI_RAG_EMBED_TOOL 覆盖，兼容 Electron/standalone 的 cwd 差异） */
function neuralToolPath(): string {
  return process.env.HUIMAI_RAG_EMBED_TOOL || join(process.cwd(), "tools", "rag-embed", "embed.mjs");
}

// 子工具缺失/失败只提示一次，避免日志刷屏
let neuralWarned = false;

/**
 * 走子进程用神经编码器批量编码；任何异常返回 null → 由调用方回退词法编码器。
 * 子工具约定：stdin 传 JSON { texts: string[] }，stdout 输出 JSON { vectors: number[][] }。
 */
function neuralEmbedBatch(texts: string[]): number[][] | null {
  try {
    const res = spawnSync(process.execPath, [neuralToolPath()], {
      input: JSON.stringify({ texts }),
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      timeout: 120000,
    });
    if (res.status !== 0 || !res.stdout) return null;
    const parsed = JSON.parse(res.stdout) as { vectors?: number[][] };
    if (!parsed.vectors || parsed.vectors.length !== texts.length) return null;
    // 归一后返回，保证与词法编码器同样的余弦语义
    return parsed.vectors.map((v) => l2normalize(v));
  } catch (err) {
    if (!neuralWarned) {
      neuralWarned = true;
      console.warn("RAG 神经编码器不可用，回退本地词法编码器：", (err as Error)?.message ?? err);
    }
    return null;
  }
}

// ==================== 统一入口 ====================

/** 当前活动编码器标识（不实际编码，仅供日志/落库标签） */
export function activeEmbedderId(): string {
  return neuralRequested() ? NEURAL_EMBEDDER_ID : LEXICAL_EMBEDDER_ID;
}

/**
 * 批量编码。优先神经编码器（若启用且就绪），否则词法编码器。
 * 返回实际使用的 embedderId，供落库标签与检索器一致性判断。
 */
export function embedBatch(texts: string[]): EmbedBatchResult {
  if (texts.length === 0) return { vectors: [], embedderId: activeEmbedderId() };
  if (neuralRequested()) {
    const neural = neuralEmbedBatch(texts);
    if (neural) return { vectors: neural, embedderId: NEURAL_EMBEDDER_ID };
    // 神经失败 → 词法兜底
  }
  return { vectors: texts.map(lexicalEmbed), embedderId: LEXICAL_EMBEDDER_ID };
}

/** 单条编码（batch 的便捷封装） */
export function embedOne(text: string): { vector: number[]; embedderId: string } {
  const { vectors, embedderId } = embedBatch([text]);
  return { vector: vectors[0], embedderId };
}
