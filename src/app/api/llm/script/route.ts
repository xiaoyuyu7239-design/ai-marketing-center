import { NextRequest, NextResponse } from "next/server";
import { readFile } from "fs/promises";
import { buildTemplateProductScript, generateScript, analyzeProduct } from "@backend/script-engine/generator";
import { styleNameMap, type ScriptStyleType } from "@backend/script-engine/prompts";
import { hookPatternName } from "@backend/script-engine/hook-patterns";
import type { ProductCategory } from "@backend/script-engine/templates";
import { getDb } from "@backend/db";
import { scripts as scriptsTable, projects, publishMetrics } from "@backend/db/schema";
import { eq } from "drizzle-orm";
import { buildPerformanceHint, topConvertingHook, topConvertingStyle, type MetricInput } from "@backend/core/publish/performance-insights";
import { buildStoreMemoryHint, getStoreMemory } from "@backend/core/memory/store-memory";
import { buildRagHint, composeRagQuery, composeRagQueryText } from "@backend/core/rag";
import { normalizeCityName } from "@backend/core/publish/local-tags";
import { requireMerchant } from "@backend/core/auth/require-merchant";
import {
  consumeExpensiveRouteRateLimit,
  EXPENSIVE_RATE_LIMIT_PRESETS,
  rateLimitResponse,
} from "@backend/core/security/rate-limit";
import { getMerchantProfile } from "@backend/core/auth/merchant-profile";
import {
  completeGenerationOperationItemFromCache,
  createGenerationOperation,
  failGenerationOperationItemBeforeClaim,
  GenerationItemFailedError,
  GenerationItemInProgressError,
  GenerationItemLeaseLostError,
  GenerationOperationConflictError,
  hashGenerationRequest,
  InvalidGenerationOperationError,
  QuotaExceededError,
  runGenerationOperationItem,
  safeGenerationErrorMessage,
} from "@backend/core/auth/usage";
import { resolveOwnedUploadRef } from "@backend/core/auth/media-access";
import { classifyAgentError } from "@server/admin/agents";
import { singleUserModeEnabled } from "@backend/core/security/runtime-config";

/** scripts 表 styleType 列允许的枚举值 */
const VALID_SCRIPT_STYLE = new Set(["pain_point", "scene", "comparison", "story", "mood", "local", "custom"]);

/**
 * 将本地图片路径转为 base64 data URI，供 LLM 视觉模型使用。
 * allowedPrefixes 限定只能读 uploads 下属于当前请求上下文的目录（本项目/商品库），
 * 并做真实路径围栏校验——否则 productImages 里的 ../ 可以穿越读服务器任意文件（含 sqlite.db、其他商家上传件）并外传给 LLM。
 */
async function imagePathToBase64(
  imagePath: string,
  merchantId: string,
  projectId?: string
): Promise<string> {
  // 已经是完整 URL 或 base64，直接返回
  if (imagePath.startsWith("http") || imagePath.startsWith("data:")) {
    return imagePath;
  }

  const filePath = resolveOwnedUploadRef(imagePath, merchantId, projectId);
  if (!filePath) {
    console.warn("拒绝读取不属于本次请求上下文的图片路径");
    return imagePath;
  }

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
    mood: "mood",
    local: "local", // 同城到店（本地门店做同城客流）
    custom: "custom",
    // 智能推荐无历史数据时按氛围大片起手（画面驱动、文字极简）——有转化数据时仍会被 insights.topStyle 覆盖；
    // 痛点种草式口播已被用户验证为"模板化过时"，不再作为起手式
    auto: "mood",
  };
  return map[String(raw ?? "").toLowerCase()] ?? "mood";
}

// 只聚合当前商家自己的投放数据；不跨商家混算，否则效果回流会被别的商家的数据污染
async function loadInsights(merchantId: string, category: string): Promise<{ hint: string; topStyle: string | null }> {
  try {
    const db = getDb();
    const rows = await db
      .select({
        style: publishMetrics.style,
        hookId: publishMetrics.hookId,
        category: publishMetrics.category,
        views: publishMetrics.views,
        likes: publishMetrics.likes,
        comments: publishMetrics.comments,
        shares: publishMetrics.shares,
        orders: publishMetrics.orders,
      })
      .from(publishMetrics)
      .innerJoin(projects, eq(publishMetrics.projectId, projects.id))
      .where(eq(projects.merchantId, merchantId));
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
    console.warn("读取历史转化数据失败（已跳过反馈）:", safeGenerationErrorMessage(error, "读取转化数据失败"));
    return { hint: "", topStyle: null };
  }
}

async function loadStoreMemoryHint(merchantId: string, input: {
  productName: string;
  category: string;
  platform?: string;
}) {
  try {
    const memory = await getStoreMemory(merchantId);
    return buildStoreMemoryHint(memory, input);
  } catch (error) {
    console.warn("读取店铺习惯失败（已跳过记忆注入）:", safeGenerationErrorMessage(error, "读取店铺记忆失败"));
    return "";
  }
}

function joinHints(...hints: string[]) {
  return hints.map((hint) => hint.trim()).filter(Boolean).join("\n\n");
}

// 生成带货脚本
export async function POST(req: NextRequest) {
  const auth = await requireMerchant(req);
  if ("error" in auth) return auth.error;
  const limit = consumeExpensiveRouteRateLimit(req, auth.merchant.id, "llm:script", EXPENSIVE_RATE_LIMIT_PRESETS.llm);
  if (!limit.allowed) return rateLimitResponse(limit, "脚本生成过于频繁，请稍后再试");
  const body = await req.json();
  const {
    productImages,
    productName,
    productDescription,
  } = body;

  // 商家建档画像兜底：老板没填品类/人群/价格带时，用建档信息补全，让"上传图就出片"也带个性化
  const profile = await getMerchantProfile(auth.merchant.id).catch(() => null);
  const rawCategory = body.category ?? body.productCategory;
  const categoryInput =
    (!rawCategory || String(rawCategory).toLowerCase() === "other") && profile?.category ? profile.category : rawCategory;
  const targetAudience = body.targetAudience || profile?.targetAudience || undefined;
  const priceRange = body.priceRange || profile?.priceRange || undefined;
  const platformsInput = body.platforms || profile?.platforms || undefined;
  // 本地门店（实体/两者都有）走同城内容策略：城市锚点 + 本地热点 + 到店 CTA（画像建档后自动生效，老板无需每次设置）
  const isLocalStore = profile?.storeType === "local" || profile?.storeType === "both";
  const localStore = isLocalStore
    ? {
        city: normalizeCityName(profile?.region) || undefined,
        landmark: profile?.landmark || undefined,
        storeName: profile?.shopName || undefined,
        storeAddress: profile?.storeAddress || undefined,
      }
    : undefined;

  // 兼容前端两种字段命名：category/productCategory、targetDuration/duration
  const category = normalizeCategory(categoryInput);
  // 输出语言跟随界面语言（默认中文）；不再按商品名猜测——英文品名商品在中文用户这里也该出中文脚本
  const locale: "zh" | "en" = body.locale === "en" ? "en" : "zh";
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

  // 项目归属/类型校验提前到任何模型调用之前：防止拿别人的 projectId 消耗分析、也让后续图片读取能按项目目录围栏
  const projectId = typeof body.projectId === "string" && body.projectId ? body.projectId : "";
  const operationId = typeof body.operationId === "string" && body.operationId.trim()
    ? body.operationId.trim()
    : `script:${crypto.randomUUID()}`;
  const operationType = "script-workflow";
  // 复用已存的商品图分析：重新生成脚本时若图没变，别每次都重跑一次付费视觉分析（product-analysis）
  let storedAnalysis: string | undefined;
  if (projectId) {
    const db = getDb();
    const proj = await db
      .select({ contentType: projects.contentType, merchantId: projects.merchantId, productAnalysis: projects.productAnalysis })
      .from(projects)
      .where(eq(projects.id, projectId));
    if (proj.length === 0 || proj[0].merchantId !== auth.merchant.id) {
      return NextResponse.json({ error: "项目不存在", projectId }, { status: 404 });
    }
    if (proj[0].contentType === "topic") {
      return NextResponse.json(
        { error: "该项目是一句话主题项目，请勿用带货脚本覆盖", projectId },
        { status: 409 }
      );
    }
    storedAnalysis = proj[0].productAnalysis ?? undefined;
  }
  try {
    // manifest 由原始请求决定（不受本轮是否命中项目缓存影响），因此同 operationId 在响应丢失后重放
    // 仍是同一组 analysis + script 子项；product-analysis 命中缓存时用本地完成项，不再请求供应商。
    const analysisRequested = !body.productAnalysis && Array.isArray(productImages) && productImages.length > 0;
    const manifestItems = [
      ...(analysisRequested ? [{ itemKey: "analysis", agentId: "product-analysis" as const }] : []),
      { itemKey: "script", agentId: "script" as const },
    ];
    createGenerationOperation({
      merchantId: auth.merchant.id,
      projectId: projectId || null,
      operationKey: operationId,
      operationType,
      agentId: "script",
      requestHash: hashGenerationRequest({
        projectId: projectId || null,
        productImages: Array.isArray(productImages) ? productImages : [],
        productName,
        productDescription: productDescription || null,
        categoryInput: categoryInput || null,
        targetAudience: targetAudience || null,
        priceRange: priceRange || null,
        platformsInput: platformsInput || null,
        styleType: body.styleType || null,
        duration,
        count,
        locale,
        videoMode: body.videoMode || null,
        quickMode,
      }),
      items: manifestItems,
    });

    // 商品图分析：将本地路径转为 base64 后传给视觉模型
    // AI 卖点分析是核心能力，不因 quick/单条脚本模式而跳过；分析本身有独立超时与失败兜底（见下方 catch），不阻塞脚本生成
    // 优先级：请求显式传入 > 项目已存（复用，省一次付费视觉调用）> 现算
    let analysis = body.productAnalysis || storedAnalysis;
    if (analysisRequested) {
      try {
        const analysisRequestHash = hashGenerationRequest({
          projectId: projectId || null,
          productImages,
        });
        if (analysis) {
          analysis = completeGenerationOperationItemFromCache(auth.merchant.id, {
            operationKey: operationId,
            operationType,
            itemKey: "analysis",
            agentId: "product-analysis",
            projectId: projectId || null,
            requestHash: analysisRequestHash,
          }, analysis).value;
        } else {
          const imageUrls = await Promise.all(
            (productImages as string[]).map((image: string) => imagePathToBase64(image, auth.merchant.id, projectId || undefined))
          );
          analysis = (await runGenerationOperationItem(auth.merchant.id, {
            operationKey: operationId,
            operationType,
            itemKey: "analysis",
            agentId: "product-analysis",
            projectId: projectId || null,
            userLabel: String(body.projectId || productName),
            requestHash: analysisRequestHash,
            persistResult: true,
          }, (config, prompt) => analyzeProduct(
            imageUrls,
            { ...config, timeoutMs: 20000, maxTokens: 1200 },
            prompt,
          ))).value;
        }
      } catch (e) {
        // 配额用尽要让老板明确知道，不能悄悄跳过分析后继续走后面同样会因配额失败的脚本生成
        if (
          e instanceof QuotaExceededError ||
          e instanceof InvalidGenerationOperationError ||
          e instanceof GenerationOperationConflictError ||
          e instanceof GenerationItemInProgressError
        ) throw e;
        // 若错误发生在 item claim 之前，也要显式把 manifest 子项收口；
        // 已 claim/已失败的子项会安全 no-op，不影响并发执行。
        failGenerationOperationItemBeforeClaim(auth.merchant.id, {
          operationKey: operationId,
          operationType,
          itemKey: "analysis",
          agentId: "product-analysis",
          projectId: projectId || null,
          failureCode: "analysis_preflight_failed",
        });
        // 图片分析失败不阻塞脚本生成
        console.warn("商品图片分析失败（已跳过）:", safeGenerationErrorMessage(e, "商品图片分析失败"));
      }
    }

    const platformPrimary =
      typeof platformsInput === "string"
        ? platformsInput.split(",")[0]?.trim() || undefined
        : Array.isArray(platformsInput)
          ? platformsInput[0]
          : undefined;
    // 素材 RAG：按品类/经营形态/视频模式/平台硬过滤 + 本地 embedding 语义排序召回同行优质结构与表达，
    // 与历史转化反馈、店铺记忆并列注入生成 prompt。冷启动/降级返回空串，零风险；不计商家配额（系统辅助）。
    const [insights, memoryHint, ragHint] = await Promise.all([
      useInsights ? loadInsights(auth.merchant.id, category) : Promise.resolve({ hint: "", topStyle: null }),
      loadStoreMemoryHint(auth.merchant.id, {
        productName,
        category,
        platform: platformPrimary,
      }),
      buildRagHint(
        composeRagQuery({
          text: composeRagQueryText({
            productName,
            productAnalysis: analysis,
            productDescription,
            usageAdvantage: body.usageAdvantage,
            targetAudience,
            priceRange,
            shopName: profile?.shopName,
            region: profile?.region,
            landmark: profile?.landmark,
          }),
          category,
          storeType: profile?.storeType,
          videoMode: body.videoMode,
          styleType,
          platform: platformPrimary,
        }),
      ).catch(() => ""),
    ]);
    if (useInsights && isAutoStyle && insights.topStyle) {
      styleType = normalizeStyle(insights.topStyle);
    } else if (isAutoStyle && isLocalStore) {
      // 本地门店的智能推荐冷启动：起手式用"同城到店"（氛围大片是电商定位的默认，对到店生意不对味）
      styleType = "local";
    }
    const generationHint = joinHints(memoryHint, insights.hint, ragHint);

    // 生成脚本（category/styleType/duration 已在上方规范化）
    let usedTemplateFallback = false;
    let scripts;
    try {
      scripts = (await runGenerationOperationItem(auth.merchant.id, {
        operationKey: operationId,
        operationType,
        itemKey: "script",
        agentId: "script",
        projectId: projectId || null,
        userLabel: String(body.projectId || productName),
        requestHash: hashGenerationRequest({
          projectId: projectId || null,
          productName,
          category,
          productDescription: productDescription || null,
          productAnalysis: analysis || null,
          locale,
          styleType,
          duration,
          videoMode: body.videoMode || null,
          priceRange: priceRange || null,
          platformsInput: platformsInput || null,
          usageAdvantage: body.usageAdvantage || null,
          targetAudience: targetAudience || null,
          referenceStructure: body.referenceStructure || null,
          generationHint,
          localStore: localStore || null,
          count,
          timeoutMs,
          maxTokens,
          quickMode,
        }),
        persistResult: true,
      }, (config, prompt) =>
        generateScript({
          productName,
          category,
          productDescription,
          productAnalysis: analysis,
          locale,
          styleType,
          targetDuration: duration,
          videoMode: body.videoMode,
          priceRange,
          platforms: platformsInput,
          usageAdvantage: body.usageAdvantage,
          targetAudience,
          referenceStructure: body.referenceStructure,
          performanceHint: generationHint,
          localStore,
          count,
          timeoutMs,
          maxTokens,
          quick: quickMode,
          llmConfig: config,
          systemPrompt: prompt,
        })
      )).value;
    } catch (error) {
      const classified = classifyAgentError(error);
      if (
        !singleUserModeEnabled() ||
        !quickMode ||
        !classified.fallbackAllowed ||
        error instanceof QuotaExceededError ||
        error instanceof InvalidGenerationOperationError ||
        error instanceof GenerationOperationConflictError ||
        error instanceof GenerationItemInProgressError ||
        error instanceof GenerationItemFailedError
      ) throw error;
      usedTemplateFallback = true;
      console.warn(
        `脚本 AI 生成发生可降级错误（${classified.category}），已生成本地占位草稿:`,
        classified.reason,
      );
      scripts = buildTemplateProductScript({
        productName,
        category,
        productDescription,
        productAnalysis: analysis,
        locale,
        styleType,
        targetDuration: duration,
        videoMode: body.videoMode,
        priceRange,
        platforms: platformsInput,
        usageAdvantage: body.usageAdvantage,
        targetAudience,
        referenceStructure: body.referenceStructure,
        performanceHint: generationHint,
        localStore,
        count,
        timeoutMs,
        maxTokens,
        quick: true,
        llmConfig: { baseUrl: "", apiKey: "", model: "template-fallback" },
      });
    }

    // 落库：把生成的脚本写入 scripts 表，供脚本页/素材页按 projectId 读取
    // （归属/contentType 校验已在函数开头、任何模型调用之前完成）
    let savedScripts = scripts;
    if (projectId) {
      const db = getDb();
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
                | "pain_point" | "scene" | "comparison" | "story" | "local" | "custom",
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
        console.error("脚本落库失败:", safeGenerationErrorMessage(e, "脚本落库失败"));
        return NextResponse.json({ error: "脚本落库失败，请重试", projectId }, { status: 500 });
      }
    }

    return NextResponse.json({
      scripts: savedScripts,
      analysis,
      ...(usedTemplateFallback && {
        warning: "AI 生成暂不可用，已生成结构占位草稿；内容未经核实、不可直接发布，请逐镜补充并人工复核。",
      }),
    });
  } catch (error) {
    if (error instanceof QuotaExceededError) {
      return NextResponse.json({ error: error.message }, { status: 402 });
    }
    if (error instanceof InvalidGenerationOperationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (
      error instanceof GenerationOperationConflictError ||
      error instanceof GenerationItemInProgressError ||
      error instanceof GenerationItemFailedError ||
      error instanceof GenerationItemLeaseLostError
    ) {
      return NextResponse.json({ error: safeGenerationErrorMessage(error) }, {
        status: 409,
        ...(error instanceof GenerationItemInProgressError ? { headers: { "Retry-After": "3" } } : {}),
      });
    }
    console.error("脚本生成失败:", safeGenerationErrorMessage(error));
    return NextResponse.json(
      { error: safeGenerationErrorMessage(error, "脚本生成失败，请稍后重试") },
      { status: 500 }
    );
  }
}
