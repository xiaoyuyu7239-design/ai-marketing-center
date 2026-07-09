import { NextRequest, NextResponse } from "next/server";
import { getDataDir } from "@backend/shared/paths";
import { readFile } from "fs/promises";
import { join } from "path";
import { buildTemplateProductScript, generateScript, analyzeProduct } from "@backend/script-engine/generator";
import { styleNameMap, type ScriptStyleType } from "@backend/script-engine/prompts";
import { hookPatternName } from "@backend/script-engine/hook-patterns";
import type { ProductCategory } from "@backend/script-engine/templates";
import { getDb } from "@backend/db";
import { scripts as scriptsTable, projects, publishMetrics } from "@backend/db/schema";
import { eq } from "drizzle-orm";
import { runAgentOperation } from "@backend/core/agent/agent-strategy";
import { buildPerformanceHint, topConvertingHook, topConvertingStyle, type MetricInput } from "@backend/core/publish/performance-insights";
import { buildStoreMemoryHint, getStoreMemory } from "@backend/core/memory/store-memory";

/** scripts 表 styleType 列允许的枚举值 */
const VALID_SCRIPT_STYLE = new Set(["pain_point", "scene", "comparison", "story", "custom"]);

/** 将本地图片路径转为 base64 data URI，供 LLM 视觉模型使用 */
async function imagePathToBase64(imagePath: string): Promise<string> {
  // 已经是完整 URL 或 base64，直接返回
  if (imagePath.startsWith("http") || imagePath.startsWith("data:")) {
    return imagePath;
  }

  // 本地 API 路径如 /api/files/projectId/filename.png
  // 提取实际文件路径: data/uploads/projectId/filename.png
  const match = imagePath.match(/\/api\/files\/(.+)/);
  if (!match) return imagePath;

  const relativePath = match[1];
  const filePath = join(getDataDir(), "uploads", relativePath);

  try {
    const buffer = await readFile(filePath);
    const base64 = buffer.toString("base64");
    // 根据扩展名推断 MIME 类型
    const ext = filePath.split(".").pop()?.toLowerCase() || "png";
    const mimeMap: Record<string, string> = {
      jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png",
      webp: "image/webp", gif: "image/gif", svg: "image/svg+xml",
    };
    const mime = mimeMap[ext] || "image/png";
    return `data:${mime};base64,${base64}`;
  } catch {
    console.warn(`无法读取图片文件: ${filePath}`);
    return imagePath;
  }
}

/** 将前端品类值规范化为引擎支持的 ProductCategory */
function normalizeCategory(raw: unknown): ProductCategory {
  const map: Record<string, ProductCategory> = {
    beauty: "beauty",
    food: "food",
    home: "home",
    fashion: "fashion",
    tech: "tech",
    digital: "tech", // 前端"数码3C"用 digital
    "3c": "tech",
    other: "beauty", // 其他类回退
  };
  return map[String(raw ?? "").toLowerCase()] ?? "beauty";
}

/** 将前端脚本风格值规范化为引擎支持的 ScriptStyleType */
function normalizeStyle(raw: unknown): ScriptStyleType {
  const map: Record<string, ScriptStyleType> = {
    pain_point: "pain_point",
    "pain-point": "pain_point",
    scene: "scene",
    scenario: "scene", // 前端"场景安利"用 scenario
    comparison: "comparison",
    story: "story",
    custom: "custom",
    auto: "pain_point", // 智能推荐默认按痛点种草起手
  };
  return map[String(raw ?? "").toLowerCase()] ?? "pain_point";
}

async function loadInsights(category: string): Promise<{ hint: string; topStyle: string | null }> {
  try {
    const db = getDb();
    const rows = await db.select().from(publishMetrics);
    if (!rows.length) return { hint: "", topStyle: null };

    const toMetric = (row: (typeof rows)[number]): MetricInput => ({
      style: row.style,
      hookId: row.hookId ?? undefined,
      views: row.views,
      likes: row.likes,
      comments: row.comments,
      shares: row.shares,
      orders: row.orders,
    });

    const sameCategory = rows.filter((row) => row.category === category).map(toMetric);
    const all = rows.map(toMetric);
    const topStyle = topConvertingStyle(sameCategory) ?? topConvertingStyle(all);
    const topHook = topConvertingHook(sameCategory) ?? topConvertingHook(all);
    const hint = buildPerformanceHint(topStyle, topHook, {
      styleLabel: (style) => styleNameMap[style as ScriptStyleType] ?? style,
      hookLabel: hookPatternName,
    });

    return { hint, topStyle: topStyle?.style ?? null };
  } catch (error) {
    console.warn("读取历史转化数据失败（已跳过反馈）:", error);
    return { hint: "", topStyle: null };
  }
}

async function loadStoreMemoryHint(input: {
  productName: string;
  category: string;
  platform?: string;
}) {
  try {
    const memory = await getStoreMemory();
    return buildStoreMemoryHint(memory, input);
  } catch (error) {
    console.warn("读取店铺习惯失败（已跳过记忆注入）:", error);
    return "";
  }
}

function joinHints(...hints: string[]) {
  return hints.map((hint) => hint.trim()).filter(Boolean).join("\n\n");
}

// 生成带货脚本
export async function POST(req: NextRequest) {
  const body = await req.json();
  const {
    productImages,
    productName,
    productDescription,
  } = body;

  // 兼容前端两种字段命名：category/productCategory、targetDuration/duration
  const category = normalizeCategory(body.category ?? body.productCategory);
  const rawStyle = String(body.styleType ?? "").toLowerCase();
  const isAutoStyle = rawStyle === "" || rawStyle === "auto";
  let styleType = normalizeStyle(body.styleType);
  const duration = body.targetDuration ?? body.duration ?? 30;
  const useInsights = body.insightMode !== false;
  const count =
    typeof body.count === "number" && body.count >= 1 && body.count <= 5
      ? Math.floor(body.count)
      : body.quick
        ? 1
        : 3;
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
  const quickMode = Boolean(body.quick) || count === 1;

  if (!productName) {
    return NextResponse.json({ error: "请填写商品名称" }, { status: 400 });
  }

  try {
    // 商品图分析：将本地路径转为 base64 后传给视觉模型
    let analysis = body.productAnalysis;
    if (!analysis && productImages?.length > 0 && !quickMode) {
      try {
        const imageUrls = await Promise.all(
          (productImages as string[]).map(imagePathToBase64)
        );
        analysis = await runAgentOperation("product-analysis", String(body.projectId || productName), (config, prompt) =>
          analyzeProduct(imageUrls, { ...config, timeoutMs: 12000, maxTokens: 1200 }, prompt)
        );
      } catch (e) {
        // 图片分析失败不阻塞脚本生成
        console.warn("商品图片分析失败（已跳过）:", e);
      }
    }

    const [insights, memoryHint] = await Promise.all([
      useInsights ? loadInsights(category) : Promise.resolve({ hint: "", topStyle: null }),
      loadStoreMemoryHint({
        productName,
        category,
        platform: typeof body.platforms === "string" ? body.platforms.split(",")[0] : undefined,
      }),
    ]);
    if (useInsights && isAutoStyle && insights.topStyle) {
      styleType = normalizeStyle(insights.topStyle);
    }
    const generationHint = joinHints(memoryHint, insights.hint);

    // 生成脚本（category/styleType/duration 已在上方规范化）
    let usedTemplateFallback = false;
    let scripts;
    try {
      scripts = await runAgentOperation("script", String(body.projectId || productName), (config, prompt) =>
        generateScript({
          productName,
          category,
          productDescription,
          productAnalysis: analysis,
          styleType,
          targetDuration: duration,
          videoMode: body.videoMode,
          priceRange: body.priceRange,
          platforms: body.platforms,
          usageAdvantage: body.usageAdvantage,
          targetAudience: body.targetAudience,
          referenceStructure: body.referenceStructure,
          performanceHint: generationHint,
          count,
          timeoutMs,
          maxTokens,
          quick: quickMode,
          llmConfig: config,
          systemPrompt: prompt,
        })
      );
    } catch (error) {
      if (!quickMode) throw error;
      usedTemplateFallback = true;
      const reason = error instanceof Error ? error.message : String(error);
      console.warn("脚本 AI 生成超时/失败，已使用本地模板兜底:", reason);
      scripts = buildTemplateProductScript({
        productName,
        category,
        productDescription,
        productAnalysis: analysis,
        styleType,
        targetDuration: duration,
        videoMode: body.videoMode,
        priceRange: body.priceRange,
        platforms: body.platforms,
        usageAdvantage: body.usageAdvantage,
        targetAudience: body.targetAudience,
        referenceStructure: body.referenceStructure,
        performanceHint: generationHint,
        count,
        timeoutMs,
        maxTokens,
        quick: true,
        llmConfig: { baseUrl: "", apiKey: "", model: "template-fallback" },
      });
    }

    // 落库：把生成的脚本写入 scripts 表，供脚本页/素材页按 projectId 读取
    let savedScripts = scripts;
    const projectId = body.projectId;
    if (projectId) {
      const db = getDb();
      // 不能用带货脚本覆盖一句话主题项目（contentType 不符则拒绝，避免删掉它的主题脚本）
      const proj = await db
        .select({ contentType: projects.contentType })
        .from(projects)
        .where(eq(projects.id, projectId));
      if (proj.length > 0 && proj[0].contentType === "topic") {
        return NextResponse.json(
          { error: "该项目是一句话主题项目，请勿用带货脚本覆盖", projectId },
          { status: 409 }
        );
      }
      try {
        // 先清掉该项目旧脚本（重新生成时覆盖）
        await db.delete(scriptsTable).where(eq(scriptsTable.projectId, projectId));
        const rows = await db
          .insert(scriptsTable)
          .values(
            scripts.map((s, i) => ({
              projectId,
              version: 1,
              styleType: (VALID_SCRIPT_STYLE.has(s.styleType) ? s.styleType : "custom") as
                | "pain_point" | "scene" | "comparison" | "story" | "custom",
              title: s.title,
              totalDuration: s.totalDuration,
              shots: s.shots,
              selected: i === 0, // 默认选中第一套
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
        })) as typeof scripts;
        // 同步项目状态与分析结果
        await db
          .update(projects)
          .set({ status: "scripting", ...(analysis && { productAnalysis: analysis }), updatedAt: new Date() })
          .where(eq(projects.id, projectId));
      } catch (e) {
        // 落库失败必须报错，不能回退到 200——否则前端按成功跳转却从 DB 读到空脚本（且可能已删旧脚本）
        console.error("脚本落库失败:", e);
        return NextResponse.json({ error: "脚本落库失败，请重试", projectId }, { status: 500 });
      }
    }

    return NextResponse.json({ scripts: savedScripts, analysis, ...(usedTemplateFallback && { warning: "AI 生成响应较慢，已先生成一套可编辑模板脚本" }) });
  } catch (error) {
    console.error("脚本生成失败:", error);
    const errMsg = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      { error: `脚本生成失败: ${errMsg}` },
      { status: 500 }
    );
  }
}
