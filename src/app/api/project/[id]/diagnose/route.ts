import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq, gt } from "drizzle-orm";
import { createSafeOpenAIClient } from "@backend/shared/openai-client";
import { getDb } from "@backend/db";
import { contentDiagnosis, projects, publishMetrics, scripts as scriptsTable } from "@backend/db/schema";
import { requireMerchant, requireOwnedProject } from "@backend/core/auth/require-merchant";
import { consumeExpensiveRouteRateLimit, EXPENSIVE_RATE_LIMIT_PRESETS, rateLimitResponse } from "@backend/core/security/rate-limit";
import { runMeteredAgentOperation, QuotaExceededError } from "@backend/core/auth/usage";
import { extractJSON } from "@backend/script-engine/generator";
import {
  buildDiagnosisPrompt,
  buildRelativePrediction,
  buildRuleDiagnosis,
  parseDiagnosisResponse,
  type ParsedDiagnosis,
} from "@backend/core/publish/content-diagnosis";

const SAFE_ID = /^[a-zA-Z0-9\-]+$/;

/** GET /api/project/[id]/diagnose —— 列出该项目的历史诊断（新→旧），供导出页回显最近一次结果 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireMerchant(req);
  if ("error" in auth) return auth.error;
  const limit = consumeExpensiveRouteRateLimit(req, auth.merchant.id, "project:diagnose", EXPENSIVE_RATE_LIMIT_PRESETS.auxiliaryModel);
  if (!limit.allowed) return rateLimitResponse(limit, "内容诊断请求过于频繁，请稍后再试");
  const { id } = await params;
  if (!id || !SAFE_ID.test(id)) return NextResponse.json({ error: "无效的项目ID" }, { status: 400 });
  const owned = await requireOwnedProject(auth.merchant.id, id);
  if ("error" in owned) return owned.error;
  const db = getDb();
  const rows = await db
    .select()
    .from(contentDiagnosis)
    .where(eq(contentDiagnosis.projectId, id))
    .orderBy(desc(contentDiagnosis.createdAt))
    .limit(10);
  return NextResponse.json({ diagnoses: rows });
}

// 只取当前商家自己已回填的真实播放数据做预测基线；不跨商家混算
async function loadMerchantViews(merchantId: string): Promise<number[]> {
  const db = getDb();
  const rows = await db
    .select({ views: publishMetrics.views })
    .from(publishMetrics)
    .innerJoin(projects, eq(publishMetrics.projectId, projects.id))
    .where(and(eq(projects.merchantId, merchantId), gt(publishMetrics.views, 0)));
  return rows.map((r) => r.views);
}

/**
 * POST /api/project/[id]/diagnose —— 发布前诊断：LLM 按维度评审脚本出诊断分，
 * 代码侧结合账号历史回流数据算相对预测（方向判断，不给绝对播放量），结果定格落库。
 * body: { scriptId?, platform?, locale? }
 * LLM 不可用/解析失败时走本地规则快检兜底（source=rule，不消耗配额）。
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
  const platform = typeof body.platform === "string" && body.platform ? body.platform : "douyin";

  const db = getDb();
  const [project] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, id), eq(projects.merchantId, auth.merchant.id)));
  if (!project) return NextResponse.json({ error: "项目不存在" }, { status: 404 });

  // 诊断对象：指定 scriptId（须属于本项目）> 选中脚本 > 最新脚本
  const scriptRows = await db
    .select()
    .from(scriptsTable)
    .where(eq(scriptsTable.projectId, id))
    .orderBy(desc(scriptsTable.selected), desc(scriptsTable.createdAt));
  const requestedScriptId = typeof body.scriptId === "string" && body.scriptId ? body.scriptId : "";
  const script = requestedScriptId ? scriptRows.find((s) => s.id === requestedScriptId) : scriptRows[0];
  if (!script || !script.shots?.length) {
    return NextResponse.json({ error: "该项目还没有可诊断的脚本，请先生成脚本" }, { status: 400 });
  }

  const promptInput = {
    productName: project.productName || project.topic || project.name,
    category: project.productCategory ?? undefined,
    platform,
    title: script.title ?? undefined,
    styleType: script.styleType,
    totalDuration: script.totalDuration ?? undefined,
    shots: script.shots,
    locale,
  };

  let parsed: ParsedDiagnosis | null = null;
  let source: "llm" | "rule" = "llm";
  let warning: string | undefined;
  try {
    parsed = await runMeteredAgentOperation(auth.merchant.id, "diagnose", id, async (config, systemPrompt) => {
      const client = createSafeOpenAIClient({ baseURL: config.baseUrl, apiKey: config.apiKey || "no-key" });
      const response = await client.chat.completions.create({
        model: config.model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: buildDiagnosisPrompt(promptInput) },
        ],
        temperature: 0.3,
        max_tokens: 1000,
      });
      const content = response.choices[0]?.message?.content;
      if (!content) throw new Error("LLM 未返回诊断结果");
      const result = parseDiagnosisResponse(JSON.parse(extractJSON(content)));
      if (!result) throw new Error("LLM 诊断结果不完整（有效维度不足）");
      return result;
    });
  } catch (error) {
    // 配额用尽要明确告知，不能悄悄降级成规则版让老板以为诊断还在用 AI
    if (error instanceof QuotaExceededError) {
      return NextResponse.json({ error: error.message }, { status: 402 });
    }
    console.warn("LLM 发布前诊断失败，已使用本地规则快检兜底:", error);
    source = "rule";
    warning = error instanceof Error ? error.message : "AI 诊断暂不可用";
    parsed = buildRuleDiagnosis({ shots: script.shots, totalDuration: script.totalDuration ?? undefined, locale });
  }

  // 相对预测由代码算（不信 LLM 报方向）：诊断分给方向，账号历史播放中位数给基线
  const views = await loadMerchantViews(auth.merchant.id).catch(() => [] as number[]);
  const relative = buildRelativePrediction(parsed.overallScore, views, locale);

  const [row] = await db
    .insert(contentDiagnosis)
    .values({
      projectId: id,
      scriptId: script.id,
      style: script.styleType,
      platform,
      overallScore: parsed.overallScore,
      dimensions: parsed.dimensions,
      summary: parsed.summary,
      suggestions: parsed.suggestions,
      prediction: relative.prediction,
      predictionConfidence: relative.confidence,
      predictionBasis: relative.basis,
      source,
    })
    .returning();

  return NextResponse.json({ diagnosis: row, ...(warning ? { warning } : {}) });
}
