/**
 * RAG 语料落库 —— 把静态知识库 + 现有用户模板灌入 rag_samples 并预计算 embedding。
 *
 * 幂等策略：按「种子版本 + 编码器标识」判断是否已灌好；两者都一致才跳过。
 * 因此知识库刷新（RAG_SEED_VERSION+1）或切换编码器（HUIMAI_RAG_EMBEDDER=neural）都会自动重灌。
 * 运行时懒加载：检索器首次调用时确保已灌库（见 ensureRagSeeded），不需要单独的部署步骤。
 */
import { eq, inArray } from "drizzle-orm";
import { getDb } from "@backend/db";
import { ragSamples, scriptTemplates } from "@backend/db/schema";
import { activeEmbedderId, embedBatch } from "./embed";
import { buildStaticKnowledgeBase, userTemplateToSample, RAG_SEED_VERSION } from "./knowledge-base";
import type { RagSampleRecord, RagSampleSource } from "./types";

type Db = ReturnType<typeof getDb>;

/** 由 seed 负责重灌的来源（metrics_top 不在此列，等真实转化数据单独接入） */
const SEEDED_SOURCES: RagSampleSource[] = ["template", "category_directive", "hook", "local_trend", "user_template"];

export interface SeedResult {
  seeded: boolean;
  count: number;
  embedderId: string;
  seedVersion: number;
  reason: "seeded" | "up-to-date";
}

/** 组装本次要落库的全部样本（静态 + 现有用户模板） */
async function collectSamples(db: Db): Promise<RagSampleRecord[]> {
  const samples = buildStaticKnowledgeBase();
  try {
    const rows = await db.select().from(scriptTemplates);
    for (const row of rows) samples.push(userTemplateToSample(row));
  } catch {
    // 用户模板是增量来源，读失败不影响静态种子落库
  }
  return samples;
}

/**
 * 执行落库（force=true 时无视幂等检查强制重灌）。返回落库条数与编码器标识。
 * 对同一进程串行安全；跨进程生产环境为单进程，无并发写冲突。
 */
export async function seedRagSamples(db: Db = getDb(), opts: { force?: boolean } = {}): Promise<SeedResult> {
  const embedderId = activeEmbedderId();
  if (!opts.force) {
    // 已按当前版本+编码器灌好则跳过
    const existing = await db
      .select({ id: ragSamples.id })
      .from(ragSamples)
      .where(eq(ragSamples.seedVersion, RAG_SEED_VERSION))
      .limit(1);
    if (existing.length > 0) {
      const sample = await db
        .select({ embeddingModel: ragSamples.embeddingModel })
        .from(ragSamples)
        .where(eq(ragSamples.seedVersion, RAG_SEED_VERSION))
        .limit(1);
      if (sample[0]?.embeddingModel === embedderId) {
        const total = await db.select({ id: ragSamples.id }).from(ragSamples);
        return { seeded: false, count: total.length, embedderId, seedVersion: RAG_SEED_VERSION, reason: "up-to-date" };
      }
    }
  }

  const samples = await collectSamples(db);
  const { vectors, embedderId: usedEmbedder } = embedBatch(samples.map((s) => s.searchText));

  // 先清掉本次负责的来源（幂等重灌），metrics_top 保留
  await db.delete(ragSamples).where(inArray(ragSamples.source, SEEDED_SOURCES));

  const rows = samples.map((s, i) => ({
    id: s.id,
    industry: s.industry ?? null,
    category: s.category ?? null,
    scene: s.scene ?? null,
    platform: s.platform ?? null,
    styleType: s.styleType ?? null,
    videoMode: s.videoMode ?? null,
    storeType: s.storeType ?? null,
    structure: s.structure ?? null,
    expression: s.expression ?? null,
    searchText: s.searchText,
    embedding: vectors[i] ?? null,
    embeddingModel: usedEmbedder,
    source: s.source,
    seedVersion: RAG_SEED_VERSION,
  }));

  // 分批插入，避免单条 SQL 变量过多（SQLite 每条语句上限 999 变量，每行 15 列 → 每批 60 行内安全）
  const BATCH = 50;
  for (let i = 0; i < rows.length; i += BATCH) {
    await db.insert(ragSamples).values(rows.slice(i, i + BATCH));
  }

  return { seeded: true, count: rows.length, embedderId: usedEmbedder, seedVersion: RAG_SEED_VERSION, reason: "seeded" };
}

// 进程内串行锁：首次调用触发落库，后续复用同一 Promise，避免并发请求重复灌库。
let seedPromise: Promise<SeedResult> | null = null;

/** 确保 RAG 语料已灌库（幂等、进程内串行）。检索器每次调用前使用。 */
export function ensureRagSeeded(db: Db = getDb()): Promise<SeedResult> {
  if (!seedPromise) {
    seedPromise = seedRagSamples(db).catch((err) => {
      // 落库失败时重置锁，允许下次重试；错误上抛给调用方按降级处理
      seedPromise = null;
      throw err;
    });
  }
  return seedPromise;
}

/** 测试用：清空进程内串行锁 */
export function __resetRagSeedLock(): void {
  seedPromise = null;
}
