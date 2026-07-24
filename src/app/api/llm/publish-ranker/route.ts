import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { createSafeOpenAIClient } from "@backend/shared/openai-client";
import { getDb } from "@backend/db";
import { publishMetrics, publishRecords, projects as projectsTable } from "@backend/db/schema";
import { requireMerchant } from "@backend/core/auth/require-merchant";
import {
  consumeExpensiveRouteRateLimit,
  EXPENSIVE_RATE_LIMIT_PRESETS,
  rateLimitResponse,
} from "@backend/core/security/rate-limit";
import { runAgentOperation } from "@backend/core/agent/agent-strategy";
import { extractJSON } from "@backend/script-engine/generator";
import {
  getApprovedProjects,
  projectCover,
  projectTitle,
  publishScore,
  type ApprovalRecords,
  type GenerationProject,
  type PublishedRecords,
} from "@frontend/lib/generation-records";
import type { PublishPickStrategy } from "@frontend/stores/video-approval-store";

interface MetricSummary {
  records: number;
  views: number;
  likes: number;
  comments: number;
  shares: number;
  orders: number;
  score: number;
}

interface PublishHistorySummary {
  categoryCounts: Record<string, number>;
  styleCounts: Record<string, number>;
  recent: { projectId: string; category: string; style: string; publishedAt: string }[];
}

interface CandidatePoolItem {
  project: GenerationProject;
  baseScore: number;
  finalScore: number;
  metricSummary: MetricSummary;
  diversityPenalty: number;
}

const emptyMetricSummary: MetricSummary = {
  records: 0,
  views: 0,
  likes: 0,
  comments: 0,
  shares: 0,
  orders: 0,
  score: 0,
};

const emptyPublishHistory: PublishHistorySummary = {
  categoryCounts: {},
  styleCounts: {},
  recent: [],
};

function clampCount(value: unknown) {
  const count = Math.round(Number(value));
  if (!Number.isFinite(count)) return 3;
  return Math.min(Math.max(count, 1), 5);
}

function parseStrategy(value: unknown): PublishPickStrategy {
  if (value === "data" || value === "fresh") return value;
  return "balanced";
}

/** 从 DB 读当前商家的项目 + 入库/发布状态（服务端权威数据，不信任客户端传入的列表） */
async function loadMerchantPublishState(merchantId: string): Promise<{
  projects: GenerationProject[];
  approved: ApprovalRecords;
  published: PublishedRecords;
}> {
  const db = getDb();
  const projectRows = await db
    .select({
      id: projectsTable.id,
      name: projectsTable.name,
      status: projectsTable.status,
      productName: projectsTable.productName,
      productCategory: projectsTable.productCategory,
      productDescription: projectsTable.productDescription,
      productImages: projectsTable.productImages,
      createdAt: projectsTable.createdAt,
      updatedAt: projectsTable.updatedAt,
    })
    .from(projectsTable)
    .where(eq(projectsTable.merchantId, merchantId));
  const recordRows = await db
    .select()
    .from(publishRecords)
    .where(eq(publishRecords.merchantId, merchantId));

  const approved: ApprovalRecords = {};
  const published: PublishedRecords = {};
  for (const r of recordRows) {
    // rejected 的内容既不进候选也不算已发（口径与商家端 store / 后台统计统一）
    if (r.reviewStatus === "rejected") continue;
    if (r.approvedAt) {
      approved[r.projectId] = { projectId: r.projectId, approvedAt: r.approvedAt.toISOString() };
    }
    if (r.publishedAt) {
      published[r.projectId] = {
        projectId: r.projectId,
        publishedAt: r.publishedAt.toISOString(),
        platform: r.platform ?? undefined,
      };
    }
  }
  return { projects: projectRows as GenerationProject[], approved, published };
}

function truncateText(value: string | null | undefined, length: number) {
  const text = value?.trim() ?? "";
  return text.length > length ? `${text.slice(0, length)}...` : text;
}

// 只按当前商家自己的项目聚合投放数据，避免跨商家数据混算影响择优推荐
async function loadPublishingData(merchantId: string) {
  try {
    const rows = await getDb()
      .select({
        projectId: publishMetrics.projectId,
        style: publishMetrics.style,
        hookId: publishMetrics.hookId,
        category: publishMetrics.category,
        platform: publishMetrics.platform,
        views: publishMetrics.views,
        likes: publishMetrics.likes,
        comments: publishMetrics.comments,
        shares: publishMetrics.shares,
        orders: publishMetrics.orders,
        publishedAt: publishMetrics.publishedAt,
      })
      .from(publishMetrics)
      .innerJoin(projectsTable, eq(publishMetrics.projectId, projectsTable.id))
      .where(eq(projectsTable.merchantId, merchantId));
    const metricMap = rows.reduce<Record<string, MetricSummary>>((acc, row) => {
      const current = acc[row.projectId] ?? { ...emptyMetricSummary };
      const views = Number(row.views ?? 0);
      const likes = Number(row.likes ?? 0);
      const comments = Number(row.comments ?? 0);
      const shares = Number(row.shares ?? 0);
      const orders = Number(row.orders ?? 0);
      current.records += 1;
      current.views += views;
      current.likes += likes;
      current.comments += comments;
      current.shares += shares;
      current.orders += orders;
      current.score =
        current.orders * 26 +
        current.shares * 4 +
        current.comments * 3 +
        current.likes * 0.8 +
        Math.min(current.views, 10000) * 0.012;
      acc[row.projectId] = current;
      return acc;
    }, {});
    const now = Date.now();
    const history = rows.reduce<PublishHistorySummary>(
      (acc, row) => {
        if (!row.publishedAt) return acc;
        const publishedMs = row.publishedAt instanceof Date ? row.publishedAt.getTime() : new Date(row.publishedAt).getTime();
        if (!Number.isFinite(publishedMs)) return acc;
        const ageDays = Math.max(0, (now - publishedMs) / 86_400_000);
        if (ageDays > 14) return acc;
        const category = row.category?.trim() || "other";
        const style = row.style?.trim() || "custom";
        acc.categoryCounts[category] = (acc.categoryCounts[category] ?? 0) + 1;
        acc.styleCounts[style] = (acc.styleCounts[style] ?? 0) + 1;
        acc.recent.push({
          projectId: row.projectId,
          category,
          style,
          publishedAt: new Date(publishedMs).toISOString(),
        });
        return acc;
      },
      { categoryCounts: {}, styleCounts: {}, recent: [] }
    );
    history.recent.sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
    return { metricMap, history };
  } catch (error) {
    console.warn("读取发布数据回流失败，使用本地择优兜底:", error);
    return { metricMap: {}, history: emptyPublishHistory };
  }
}

function metricWeight(strategy: PublishPickStrategy) {
  if (strategy === "data") return 1.35;
  if (strategy === "fresh") return 0.2;
  return 0.65;
}

function buildCandidatePool(
  projects: GenerationProject[],
  approved: ApprovalRecords,
  published: PublishedRecords,
  metricMap: Record<string, MetricSummary>,
  history: PublishHistorySummary,
  strategy: PublishPickStrategy
) {
  const today = new Date();
  const publishedProjectIds = new Set([
    ...Object.keys(published),
    ...Object.keys(metricMap).filter((projectId) => metricMap[projectId]?.records > 0 && history.recent.some((item) => item.projectId === projectId)),
  ]);
  return getApprovedProjects(projects, approved)
    .filter((project) => !publishedProjectIds.has(project.id))
    .map<CandidatePoolItem>((project) => {
      const metricSummary = metricMap[project.id] ?? emptyMetricSummary;
      const baseScore = publishScore(project, approved[project.id]?.approvedAt, today, strategy);
      const category = project.productCategory?.trim() || "other";
      const diversityPenalty = (history.categoryCounts[category] ?? 0) * (strategy === "fresh" ? 34 : 22);
      return {
        project,
        baseScore,
        finalScore: baseScore + metricSummary.score * metricWeight(strategy) - diversityPenalty,
        metricSummary,
        diversityPenalty,
      };
    })
    .sort((a, b) => b.finalScore - a.finalScore)
    .slice(0, 18);
}

function fallbackReason(item: CandidatePoolItem, strategy: PublishPickStrategy) {
  if (item.metricSummary.orders > 0) return `已带来${item.metricSummary.orders}单`;
  if (strategy === "data" && item.metricSummary.records > 0) return "回流数据较好";
  if (strategy === "fresh") return "今日轮动上新";
  if (projectCover(item.project)) return "商品画面清楚";
  return "适合今天发布";
}

function strategyText(strategy: PublishPickStrategy) {
  if (strategy === "data") return "数据优先：优先选择已有播放、互动、成交回流更好的视频。";
  if (strategy === "fresh") return "新品轮动：避免每天只推同一类内容，优先近期入库、适合轮换露出的视频。";
  return "智能推荐：综合数据回流、商品清晰度、卖点完整度、入库时间和今日内容多样性。";
}

function buildRankPrompt(pool: CandidatePoolItem[], count: number, strategy: PublishPickStrategy) {
  const candidates = pool.map((item) => ({
    id: item.project.id,
    title: projectTitle(item.project),
    category: item.project.productCategory ?? "other",
    description: truncateText(item.project.productDescription, 80),
    hasCover: Boolean(projectCover(item.project)),
    baseScore: Math.round(item.baseScore),
    metricScore: Math.round(item.metricSummary.score),
    diversityPenalty: Math.round(item.diversityPenalty),
    metrics: {
      records: item.metricSummary.records,
      views: item.metricSummary.views,
      likes: item.metricSummary.likes,
      comments: item.metricSummary.comments,
      shares: item.metricSummary.shares,
      orders: item.metricSummary.orders,
    },
  }));

  return [
    `请从候选库存视频中选出今天最适合发布的 ${count} 条。`,
    "产品背景：这是给三四线城市中小店铺店主使用的 AI 带货短视频工具，用户希望少操作、快发布、能看懂。",
    `当前策略：${strategyText(strategy)}`,
    "选择要求：",
    "1. 优先选商品主体清楚、卖点直白、适合当天发出去的视频。",
    "2. 有效果回流时，要重视成交、转发、评论、点赞和播放，但不要只看播放量。",
    "3. 避免连续发布同品类、同脚本风格、同卖点角度的视频，降低账号内容同质化。",
    "4. diversityPenalty 越高代表近期同类内容越多，除非数据明显更好，否则少选。",
    "5. 不要重复选择同一个项目 ID，理由必须是 12 字以内中文。",
    "6. 只输出 JSON，不要输出解释。",
    `候选视频：${JSON.stringify(candidates)}`,
    '输出格式：{"items":[{"id":"项目ID","reason":"推荐理由"}]}',
  ].join("\n");
}

function mergeLlmItems(
  parsed: unknown,
  pool: CandidatePoolItem[],
  count: number,
  source: "llm" | "rule",
  strategy: PublishPickStrategy
) {
  const idToCandidate = new Map(pool.map((item) => [item.project.id, item]));
  const seen = new Set<string>();
  const parsedItems =
    parsed && typeof parsed === "object" && Array.isArray((parsed as { items?: unknown }).items)
      ? ((parsed as { items: unknown[] }).items)
      : [];

  const selected = parsedItems.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const id = (item as { id?: unknown }).id;
    if (typeof id !== "string" || seen.has(id)) return [];
    const candidate = idToCandidate.get(id);
    if (!candidate) return [];
    seen.add(id);
    const reason = (item as { reason?: unknown }).reason;
    return [
      {
        project: candidate.project,
        reason: typeof reason === "string" && reason.trim() ? reason.trim().slice(0, 12) : fallbackReason(candidate, strategy),
        score: Math.round(candidate.finalScore),
        source,
      },
    ];
  });

  if (selected.length >= count) return selected.slice(0, count);

  const fill = pool
    .filter((item) => !seen.has(item.project.id))
    .slice(0, count - selected.length)
    .map((item) => ({
      project: item.project,
      reason: fallbackReason(item, strategy),
      score: Math.round(item.finalScore),
      source: "rule" as const,
    }));
  return [...selected, ...fill];
}

export async function POST(req: NextRequest) {
  const auth = await requireMerchant(req);
  if ("error" in auth) return auth.error;
  const limit = consumeExpensiveRouteRateLimit(req, auth.merchant.id, "llm:publish-ranker", EXPENSIVE_RATE_LIMIT_PRESETS.auxiliaryModel);
  if (!limit.allowed) return rateLimitResponse(limit, "发布排序请求过于频繁，请稍后再试");
  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  // 项目与入库/发布状态一律以服务端为准（客户端 body 里即使还传了这些字段也忽略）
  const { projects, approved, published } = await loadMerchantPublishState(auth.merchant.id);
  const count = clampCount(body.count);
  const strategy = parseStrategy(body.strategy);
  const { metricMap, history } = await loadPublishingData(auth.merchant.id);
  const pool = buildCandidatePool(projects, approved, published, metricMap, history, strategy);

  if (pool.length === 0) {
    return NextResponse.json({ candidates: [], source: "rule", strategy });
  }

  const fallback = mergeLlmItems({ items: [] }, pool, count, "rule", strategy);

  try {
    // 发布择优是页面打开即自动触发的辅助能力，且有规则兜底——不计入商家生成配额
    // （否则试用套餐的次数会被"打开页面"悄悄耗光）；仍需登录，平台侧成本由 max_tokens 上限控制
    const parsed = await runAgentOperation("publish-ranker", "today-publish-rank", async (config, systemPrompt) => {
      const client = createSafeOpenAIClient({ baseURL: config.baseUrl, apiKey: config.apiKey || "no-key" });
      const response = await client.chat.completions.create({
        model: config.model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: buildRankPrompt(pool, count, strategy) },
        ],
        temperature: 0.35,
        max_tokens: 900,
      });
      const content = response.choices[0]?.message?.content;
      if (!content) throw new Error("LLM 未返回择优结果");
      return JSON.parse(extractJSON(content));
    });

    const candidates = mergeLlmItems(parsed, pool, count, "llm", strategy);
    return NextResponse.json({ candidates, source: "llm", strategy });
  } catch (error) {
    console.warn("LLM 发布择优失败，已使用规则兜底:", error);
    return NextResponse.json({
      candidates: fallback,
      source: "rule",
      strategy,
      warning: error instanceof Error ? error.message : "LLM 发布择优失败",
    });
  }
}
