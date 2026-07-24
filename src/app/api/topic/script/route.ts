import { NextRequest, NextResponse } from "next/server";
import { buildTemplateTopicScript, generateTopicScript } from "@backend/script-engine/generator";
import type { TopicNarrationStyle } from "@backend/script-engine/prompts";
import { getDb } from "@backend/db";
import { scripts as scriptsTable, projects } from "@backend/db/schema";
import { eq } from "drizzle-orm";
import { requireMerchant } from "@backend/core/auth/require-merchant";
import {
  consumeExpensiveRouteRateLimit,
  EXPENSIVE_RATE_LIMIT_PRESETS,
  rateLimitResponse,
} from "@backend/core/security/rate-limit";
import {
  runMeteredAgentOperation,
  QuotaExceededError,
  safeGenerationErrorMessage,
} from "@backend/core/auth/usage";
import { classifyAgentError } from "@server/admin/agents";
import { singleUserModeEnabled } from "@backend/core/security/runtime-config";

const VALID_NARRATION = new Set<TopicNarrationStyle>([
  "knowledge",
  "story",
  "lifestyle",
  "inspiration",
  "travel",
]);

/** 主题截断成项目名（保留前 20 字） */
function topicToName(topic: string): string {
  const t = topic.trim().replace(/\s+/g, " ");
  return t.length > 20 ? `${t.slice(0, 20)}…` : t;
}

/**
 * POST /api/topic/script —— 一句话主题成片入口（去商品化）。
 * 一次完成：建项目（contentType=topic）+ 生成多套带英文检索词的旁白脚本并落库。
 * 随后前端可直接走 /api/project/[id]/stock-fill 自动配画面 → /api/project/[id]/compose 合成。
 *
 * body: { topic, narrationStyle?, targetDuration?, count?, platforms?, projectId? }
 */
export async function POST(req: NextRequest) {
  const auth = await requireMerchant(req);
  if ("error" in auth) return auth.error;
  const limit = consumeExpensiveRouteRateLimit(req, auth.merchant.id, "topic:script", EXPENSIVE_RATE_LIMIT_PRESETS.llm);
  if (!limit.allowed) return rateLimitResponse(limit, "主题脚本生成过于频繁，请稍后再试");
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "请求体不是合法 JSON" }, { status: 400 });
  }

  const topic = typeof body.topic === "string" ? body.topic.trim() : "";
  if (!topic) {
    return NextResponse.json({ error: "请填写一句话主题" }, { status: 400 });
  }

  const narrationStyle = VALID_NARRATION.has(body.narrationStyle as TopicNarrationStyle)
    ? (body.narrationStyle as TopicNarrationStyle)
    : "knowledge";
  const targetDuration =
    typeof body.targetDuration === "number" && body.targetDuration > 0 ? body.targetDuration : 25;
  const count = typeof body.count === "number" && body.count >= 1 && body.count <= 5 ? body.count : 3;
  const platforms = typeof body.platforms === "string" ? body.platforms : undefined;
  const timeoutMs =
    typeof body.timeoutMs === "number" && body.timeoutMs >= 5000 && body.timeoutMs <= 120000
      ? body.timeoutMs
      : count === 1
        ? 10000
        : 60000;
  const maxTokens =
    typeof body.maxTokens === "number" && body.maxTokens >= 1000 && body.maxTokens <= 16000
      ? body.maxTokens
      : count === 1
        ? 2500
        : 10000;

  const db = getDb();

  // 取已有项目或新建一个 topic 项目（建项目放在生成前，生成失败也能落到草稿项目供重试）
  let projectId = typeof body.projectId === "string" && body.projectId ? body.projectId : "";
  if (projectId) {
    const exists = await db
      .select({ id: projects.id, contentType: projects.contentType, merchantId: projects.merchantId })
      .from(projects)
      .where(eq(projects.id, projectId));
    if (exists.length === 0 || exists[0].merchantId !== auth.merchant.id) {
      return NextResponse.json({ error: "项目不存在" }, { status: 404 });
    }
    // 不能用一句话主题脚本覆盖带货项目——否则会把它静默改成 topic 并删掉其已有脚本
    if (exists[0].contentType === "product") {
      return NextResponse.json(
        { error: "该项目是带货项目，请新建主题项目而不是覆盖它", projectId },
        { status: 409 }
      );
    }
  } else {
    const [created] = await db
      .insert(projects)
      .values({ merchantId: auth.merchant.id, name: topicToName(topic), contentType: "topic", topic, status: "draft" })
      .returning();
    projectId = created.id;
  }

  // 生成脚本
  let generated;
  let usedTemplateFallback = false;
  try {
    generated = await runMeteredAgentOperation(auth.merchant.id, "topic-script", projectId || topic, (config, prompt) =>
      generateTopicScript({
        topic,
        narrationStyle,
        targetDuration,
        count,
        platforms,
        timeoutMs,
        maxTokens,
        quick: count === 1,
        llmConfig: config,
        systemPrompt: prompt,
      })
    );
  } catch (error) {
    if (error instanceof QuotaExceededError) {
      // 配额用尽要明确告知，不能悄悄回退成模板脚本
      return NextResponse.json({ error: error.message, projectId }, { status: 402 });
    }
    const classified = classifyAgentError(error);
    if (singleUserModeEnabled() && count === 1 && classified.fallbackAllowed) {
      usedTemplateFallback = true;
      console.warn(
        `主题脚本 AI 生成发生可降级错误（${classified.category}），已生成本地占位草稿:`,
        classified.reason,
      );
      generated = buildTemplateTopicScript({
        topic,
        narrationStyle,
        targetDuration,
        count,
        platforms,
        timeoutMs,
        maxTokens,
        quick: true,
        llmConfig: { baseUrl: "", apiKey: "", model: "template-fallback" },
      });
    } else {
      // 项目已建好，返回 projectId 便于前端跳转后重试
      return NextResponse.json({
        error: safeGenerationErrorMessage(error, "主题脚本生成失败，请稍后重试"),
        projectId,
      }, { status: 500 });
    }
  }

  // 落库：清旧脚本 → 写入 → 默认选中第一套 → 项目转 scripting
  let savedScripts = generated;
  try {
    await db.delete(scriptsTable).where(eq(scriptsTable.projectId, projectId));
    const rows = await db
      .insert(scriptsTable)
      .values(
        generated.map((s, i) => ({
          projectId,
          version: 1,
          styleType: "custom" as const, // 主题成片统一 custom
          title: s.title,
          totalDuration: s.totalDuration,
          shots: s.shots,
          selected: i === 0,
        }))
      )
      .returning();
    savedScripts = rows.map((r) => ({
      id: r.id,
      title: r.title ?? "",
      styleType: r.styleType,
      totalDuration: r.totalDuration ?? 0,
      shots: r.shots ?? [],
      selected: r.selected ?? false,
    })) as typeof generated;
    await db
      .update(projects)
      .set({ status: "scripting", contentType: "topic", topic, updatedAt: new Date() })
      .where(eq(projects.id, projectId));
  } catch (e) {
    // 落库失败必须报错，不能再回退到 200——否则前端按成功跳转却从 DB 读到空脚本（且可能已删旧脚本=数据丢失）
    console.error("主题脚本落库失败:", e);
    return NextResponse.json({ error: "脚本落库失败，请重试", projectId }, { status: 500 });
  }

  return NextResponse.json({
    projectId,
    scripts: savedScripts,
    ...(usedTemplateFallback && {
      warning: "AI 生成暂不可用，已生成结构占位草稿；内容未经核实、不可直接发布，请逐镜补充并人工复核。",
    }),
  });
}
