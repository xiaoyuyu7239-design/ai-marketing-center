import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq, gt, ne } from "drizzle-orm";
import { createSafeOpenAIClient } from "@backend/shared/openai-client";
import { getDb } from "@backend/db";
import { contentDiagnosis, projects, publishMetrics, videoRetros } from "@backend/db/schema";
import { requireMerchant, requireOwnedProject } from "@backend/core/auth/require-merchant";
import { consumeExpensiveRouteRateLimit, EXPENSIVE_RATE_LIMIT_PRESETS, rateLimitResponse } from "@backend/core/security/rate-limit";
import { runMeteredAgentOperation, QuotaExceededError } from "@backend/core/auth/usage";
import { extractJSON } from "@backend/script-engine/generator";
import {
  buildRetroPrompt,
  buildRuleRetro,
  computeActualVerdict,
  parseRetroResponse,
  pickRetroMemoryNotes,
  type ParsedRetro,
} from "@backend/core/publish/video-retro";
import { getStoreMemory, learnFromReview, saveStoreMemory } from "@backend/core/memory/store-memory";

const SAFE_ID = /^[a-zA-Z0-9\-]+$/;

/** GET /api/project/[id]/retro —— 列出该项目的历史复盘（新→旧），供导出页回显最近一次 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireMerchant(req);
  if ("error" in auth) return auth.error;
  const limit = consumeExpensiveRouteRateLimit(req, auth.merchant.id, "project:retro", EXPENSIVE_RATE_LIMIT_PRESETS.auxiliaryModel);
  if (!limit.allowed) return rateLimitResponse(limit, "视频复盘请求过于频繁，请稍后再试");
  const { id } = await params;
  if (!id || !SAFE_ID.test(id)) return NextResponse.json({ error: "无效的项目ID" }, { status: 400 });
  const owned = await requireOwnedProject(auth.merchant.id, id);
  if ("error" in owned) return owned.error;
  const db = getDb();
  const rows = await db
    .select()
    .from(videoRetros)
    .where(eq(videoRetros.projectId, id))
    .orderBy(desc(videoRetros.createdAt))
    .limit(10);
  return NextResponse.json({ retros: rows });
}

/**
 * POST /api/project/[id]/retro —— 单条视频复盘：以该项目最新一条回流数据为准，
 * 代码算"实际 vs 账号基线"的方向，LLM 写复盘正文（亮点/问题/下条怎么改），
 * nextActions 摘要写进店铺记忆反哺下次生成。body: { locale? }
 * LLM 不可用时走规则兜底（source=rule，方向结论仍可靠，内容评价借用当时诊断）。
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireMerchant(req);
  if ("error" in auth) return auth.error;
  const { id } = await params;
  if (!id || !SAFE_ID.test(id)) return NextResponse.json({ error: "无效的项目ID" }, { status: 400 });

  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    /* 允许空 body */
  }
  const locale: "zh" | "en" = body.locale === "en" ? "en" : "zh";

  const db = getDb();
  const [project] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, id), eq(projects.merchantId, auth.merchant.id)));
  if (!project) return NextResponse.json({ error: "项目不存在" }, { status: 404 });

  // 复盘对象：该项目最新一条有播放数的回流数据（老板可能分 1/3/7 天多次回填，取最新快照）
  const metricRows = await db
    .select()
    .from(publishMetrics)
    .where(and(eq(publishMetrics.projectId, id), gt(publishMetrics.views, 0)))
    .orderBy(desc(publishMetrics.createdAt))
    .limit(1);
  const latestMetric = metricRows[0];
  if (!latestMetric) {
    return NextResponse.json({ error: "先把这条视频的数据填上（上面的效果回流卡片），才能帮你复盘" }, { status: 400 });
  }

  // 账号基线：其他项目已回填的播放数（不含这条自己，避免自己跟自己比）
  const otherRows = await db
    .select({ views: publishMetrics.views })
    .from(publishMetrics)
    .innerJoin(projects, eq(publishMetrics.projectId, projects.id))
    .where(and(eq(projects.merchantId, auth.merchant.id), ne(publishMetrics.projectId, id), gt(publishMetrics.views, 0)));
  const verdict = computeActualVerdict(latestMetric.views, otherRows.map((r) => r.views), locale);

  // 当时的发布前诊断（可空）：预测 vs 实际的对照记录就从这来
  const diagRows = await db
    .select()
    .from(contentDiagnosis)
    .where(eq(contentDiagnosis.projectId, id))
    .orderBy(desc(contentDiagnosis.createdAt))
    .limit(1);
  const diagnosis = diagRows[0] ?? null;

  const promptInput = {
    productName: project.productName || project.topic || project.name,
    styleType: latestMetric.style,
    platform: latestMetric.platform || "douyin",
    metrics: {
      views: latestMetric.views,
      likes: latestMetric.likes,
      comments: latestMetric.comments,
      shares: latestMetric.shares,
      orders: latestMetric.orders,
    },
    verdict,
    diagnosis: diagnosis
      ? {
          overallScore: diagnosis.overallScore,
          prediction: diagnosis.prediction,
          dimensions: diagnosis.dimensions ?? [],
        }
      : null,
    locale,
  };

  let parsed: ParsedRetro | null = null;
  let source: "llm" | "rule" = "llm";
  let warning: string | undefined;
  try {
    parsed = await runMeteredAgentOperation(auth.merchant.id, "retro", id, async (config, systemPrompt) => {
      const client = createSafeOpenAIClient({ baseURL: config.baseUrl, apiKey: config.apiKey || "no-key" });
      const response = await client.chat.completions.create({
        model: config.model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: buildRetroPrompt(promptInput) },
        ],
        temperature: 0.4,
        max_tokens: 800,
      });
      const content = response.choices[0]?.message?.content;
      if (!content) throw new Error("LLM 未返回复盘结果");
      const result = parseRetroResponse(JSON.parse(extractJSON(content)));
      if (!result) throw new Error("LLM 复盘结果为空");
      return result;
    });
  } catch (error) {
    if (error instanceof QuotaExceededError) {
      return NextResponse.json({ error: error.message }, { status: 402 });
    }
    console.warn("LLM 复盘失败，已使用本地规则兜底:", error);
    source = "rule";
    warning = error instanceof Error ? error.message : "AI 复盘暂不可用";
    parsed = buildRuleRetro({ verdict, diagnosisDimensions: diagnosis?.dimensions, locale });
  }

  const [row] = await db
    .insert(videoRetros)
    .values({
      projectId: id,
      diagnosisId: diagnosis?.id ?? null,
      style: latestMetric.style,
      platform: latestMetric.platform,
      predicted: diagnosis?.prediction ?? null,
      actual: verdict.actual,
      actualBasis: verdict.basis,
      highlights: parsed.highlights,
      issues: parsed.issues,
      nextActions: parsed.nextActions,
      summary: parsed.summary,
      source,
    })
    .returning();

  // "下条试试"写进店铺记忆（下次生成脚本自动带上）——记忆写失败不影响复盘本身
  try {
    const notes = pickRetroMemoryNotes(parsed);
    if (notes.length) {
      const memory = await getStoreMemory(auth.merchant.id);
      await saveStoreMemory(auth.merchant.id, learnFromReview(memory, notes));
    }
  } catch (error) {
    console.warn("复盘经验写入店铺记忆失败（不影响复盘结果）:", error);
  }

  return NextResponse.json({ retro: row, ...(warning ? { warning } : {}) });
}
