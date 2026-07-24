import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq, gt } from "drizzle-orm";
import { createSafeOpenAIClient } from "@backend/shared/openai-client";
import { getDb } from "@backend/db";
import { projects, publishMetrics, videoRetros, weeklyReports } from "@backend/db/schema";
import { requireMerchant } from "@backend/core/auth/require-merchant";
import { consumeExpensiveRouteRateLimit, EXPENSIVE_RATE_LIMIT_PRESETS, rateLimitResponse } from "@backend/core/security/rate-limit";
import { runMeteredAgentOperation, QuotaExceededError } from "@backend/core/auth/usage";
import { extractJSON } from "@backend/script-engine/generator";
import { styleNameMap, type ScriptStyleType } from "@backend/script-engine/prompts";
import { topConvertingStyle, type MetricInput } from "@backend/core/publish/performance-insights";
import {
  buildRuleWeeklyReport,
  buildWeeklyReportPrompt,
  collectWeeklyWindows,
  parseWeeklyReportResponse,
  type ParsedWeeklyReport,
  type WeeklyReportData,
} from "@backend/core/publish/weekly-report";

const styleLabel = (style: string) => styleNameMap[style as ScriptStyleType] ?? style;

/** GET /api/insights/weekly-report —— 列出当前商家的历史周报（新→旧） */
export async function GET(req: NextRequest) {
  const auth = await requireMerchant(req);
  if ("error" in auth) return auth.error;
  const db = getDb();
  const rows = await db
    .select()
    .from(weeklyReports)
    .where(eq(weeklyReports.merchantId, auth.merchant.id))
    .orderBy(desc(weeklyReports.createdAt))
    .limit(8);
  return NextResponse.json({ reports: rows });
}

/**
 * POST /api/insights/weekly-report —— 生成账号周报：
 * 代码按"近7天 vs 再前7天"窗口汇总回流数据并算趋势，LLM 只负责把数字讲成大白话；
 * 近期复盘的"下条试试"一并汇入"下周怎么干"。body: { locale? }
 * LLM 不可用时走规则兜底（source=rule，数字结论照样可靠）。
 */
export async function POST(req: NextRequest) {
  const auth = await requireMerchant(req);
  if ("error" in auth) return auth.error;
  const limit = consumeExpensiveRouteRateLimit(req, auth.merchant.id, "insights:weekly-report", EXPENSIVE_RATE_LIMIT_PRESETS.auxiliaryModel);
  if (!limit.allowed) return rateLimitResponse(limit, "周报生成请求过于频繁，请稍后再试");

  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    /* 允许空 body */
  }
  const locale: "zh" | "en" = body.locale === "en" ? "en" : "zh";
  const now = new Date();

  const db = getDb();
  // 只汇总当前商家自己的回流数据；不跨商家混算
  const metricRows = await db
    .select({
      views: publishMetrics.views,
      likes: publishMetrics.likes,
      comments: publishMetrics.comments,
      shares: publishMetrics.shares,
      orders: publishMetrics.orders,
      createdAt: publishMetrics.createdAt,
      style: publishMetrics.style,
    })
    .from(publishMetrics)
    .innerJoin(projects, eq(publishMetrics.projectId, projects.id))
    .where(and(eq(projects.merchantId, auth.merchant.id), gt(publishMetrics.views, 0)));

  const windows = collectWeeklyWindows(metricRows, now);
  if (windows.thisWeek.entries === 0) {
    return NextResponse.json(
      { error: "这 7 天还没回填过数据。先去每条视频的导出页把数据填上（截图粘贴 10 秒搞定），再来出周报" },
      { status: 400 }
    );
  }

  // 最能卖的风格：优先按本周窗口算，本周样本不足再看全部历史
  const toMetric = (r: (typeof metricRows)[number]): MetricInput => ({
    style: r.style,
    views: r.views,
    likes: r.likes,
    comments: r.comments,
    shares: r.shares,
    orders: r.orders,
  });
  const weekStart = now.getTime() - 7 * 86_400_000;
  const thisWeekMetrics = metricRows.filter((r) => (r.createdAt?.getTime() ?? 0) > weekStart).map(toMetric);
  const topStyle = topConvertingStyle(thisWeekMetrics) ?? topConvertingStyle(metricRows.map(toMetric));

  // 近期复盘沉淀的"下条试试"：最近 5 条复盘，去重后取前 4
  const retroRows = await db
    .select({ nextActions: videoRetros.nextActions })
    .from(videoRetros)
    .innerJoin(projects, eq(videoRetros.projectId, projects.id))
    .where(eq(projects.merchantId, auth.merchant.id))
    .orderBy(desc(videoRetros.createdAt))
    .limit(5);
  const retroNotes = [...new Set(retroRows.flatMap((r) => r.nextActions ?? []))].slice(0, 4);

  const data: WeeklyReportData = { ...windows, topStyle, retroNotes };

  let parsed: ParsedWeeklyReport | null = null;
  let source: "llm" | "rule" = "llm";
  let warning: string | undefined;
  try {
    parsed = await runMeteredAgentOperation(auth.merchant.id, "weekly-report", auth.merchant.id, async (config, systemPrompt) => {
      const client = createSafeOpenAIClient({ baseURL: config.baseUrl, apiKey: config.apiKey || "no-key" });
      const response = await client.chat.completions.create({
        model: config.model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: buildWeeklyReportPrompt(data, locale, styleLabel) },
        ],
        temperature: 0.4,
        max_tokens: 800,
      });
      const content = response.choices[0]?.message?.content;
      if (!content) throw new Error("LLM 未返回周报");
      const result = parseWeeklyReportResponse(JSON.parse(extractJSON(content)));
      if (!result) throw new Error("LLM 周报结果为空");
      return result;
    });
  } catch (error) {
    if (error instanceof QuotaExceededError) {
      return NextResponse.json({ error: error.message }, { status: 402 });
    }
    console.warn("LLM 周报生成失败，已使用本地规则兜底:", error);
    source = "rule";
    warning = error instanceof Error ? error.message : "AI 周报暂不可用";
    parsed = buildRuleWeeklyReport(data, locale, styleLabel);
  }

  const [row] = await db
    .insert(weeklyReports)
    .values({
      merchantId: auth.merchant.id,
      periodStart: new Date(weekStart),
      periodEnd: now,
      stats: data,
      highlights: parsed.highlights,
      watchouts: parsed.watchouts,
      nextActions: parsed.nextActions,
      summary: parsed.summary,
      source,
    })
    .returning();

  return NextResponse.json({ report: row, ...(warning ? { warning } : {}) });
}
