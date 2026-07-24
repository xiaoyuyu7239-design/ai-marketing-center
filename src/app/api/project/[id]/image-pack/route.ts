import { NextRequest, NextResponse } from "next/server";
import { createSafeOpenAIClient } from "@backend/shared/openai-client";
import { eq } from "drizzle-orm";
import { getDb } from "@backend/db";
import { projects, settings } from "@backend/db/schema";
import { buildImagePackPrompt, type ImagePackSpec } from "@backend/script-engine/prompts";
import { arkThinkingOff, parseJsonLoose, extractJSON } from "@backend/script-engine/generator";
import { requireMerchant, requireOwnedProject } from "@backend/core/auth/require-merchant";
import { consumeExpensiveRouteRateLimit, EXPENSIVE_RATE_LIMIT_PRESETS, rateLimitResponse } from "@backend/core/security/rate-limit";
import { runMeteredAgentOperation, QuotaExceededError } from "@backend/core/auth/usage";
import { imageCleanKey, type ImageCleanRecord } from "@backend/shared/image-clean";

function imagePackKey(projectId: string) {
  return `image_pack:${projectId}`;
}

/** 校验并裁剪 LLM 产出的图片套装脚本 */
function validateSpec(raw: unknown): ImagePackSpec | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<ImagePackSpec>;
  const images = Array.isArray(r.images)
    ? r.images
        .filter((im) => im && typeof im === "object" && typeof im.prompt === "string" && im.prompt.trim())
        .slice(0, 5)
        .map((im, i) => ({
          purpose: typeof im.purpose === "string" && im.purpose ? im.purpose : `场景图 ${i + 1}`,
          description: typeof im.description === "string" ? im.description : "",
          prompt: im.prompt,
        }))
    : [];
  if (images.length < 3) return null;
  return {
    concept: typeof r.concept === "string" ? r.concept : "",
    caption: typeof r.caption === "string" ? r.caption : "",
    altCaptions: Array.isArray(r.altCaptions)
      ? r.altCaptions.filter((c): c is string => typeof c === "string" && !!c.trim()).slice(0, 3)
      : [],
    images,
  };
}

/** 读取图片套装脚本 + 清洗映射（页面初始化一次拿全） */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireMerchant(req);
  if ("error" in auth) return auth.error;
  const limit = consumeExpensiveRouteRateLimit(req, auth.merchant.id, "project:image-pack", EXPENSIVE_RATE_LIMIT_PRESETS.llm);
  if (!limit.allowed) return rateLimitResponse(limit, "图片套装方案生成过于频繁，请稍后再试");
  const { id } = await params;
  const owned = await requireOwnedProject(auth.merchant.id, id);
  if ("error" in owned) return owned.error;

  const db = getDb();
  const [specRows, cleanRows] = await Promise.all([
    db.select({ value: settings.value }).from(settings).where(eq(settings.key, imagePackKey(id))),
    db.select({ value: settings.value }).from(settings).where(eq(settings.key, imageCleanKey(id))),
  ]);
  return NextResponse.json({
    spec: (specRows[0]?.value as ImagePackSpec | undefined) ?? null,
    clean: (cleanRows[0]?.value as ImageCleanRecord | undefined) ?? null,
  });
}

/** 生成图片套装脚本（LLM）：一组场景图规格 + 朋友圈文案，存 settings 供页面消费 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireMerchant(req);
  if ("error" in auth) return auth.error;
  const { id } = await params;
  const owned = await requireOwnedProject(auth.merchant.id, id);
  if ("error" in owned) return owned.error;

  try {
    const db = getDb();
    const rows = await db.select().from(projects).where(eq(projects.id, id));
    const project = rows[0];
    if (!project) return NextResponse.json({ error: "项目不存在" }, { status: 404 });

    const body = await req.json().catch(() => ({}));
    const locale: "zh" | "en" = body.locale === "en" ? "en" : "zh";
    const prompt = buildImagePackPrompt({
      productName: project.productName || project.name,
      category: project.productCategory ?? undefined,
      productDescription: project.productDescription ?? undefined,
      productAnalysis: project.productAnalysis ?? undefined,
      locale,
    });

    const spec = await runMeteredAgentOperation(auth.merchant.id, "script", `image-pack:${id}`, async (config, systemPrompt) => {
      const client = createSafeOpenAIClient({ baseURL: config.baseUrl, apiKey: config.apiKey || "no-key", timeout: 60000 });
      const resp = await client.chat.completions.create(arkThinkingOff({
        model: config.model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: prompt },
        ],
        temperature: 0.85,
        max_tokens: 2500,
      }, config.baseUrl));
      const content = resp.choices[0]?.message?.content;
      if (!content) throw new Error("LLM 未返回内容");
      const parsed = validateSpec(parseJsonLoose(extractJSON(content)));
      if (!parsed) throw new Error("图片套装脚本格式不完整，请重试");
      return parsed;
    });

    await db
      .insert(settings)
      .values({ key: imagePackKey(id), value: spec, updatedAt: new Date() })
      .onConflictDoUpdate({ target: settings.key, set: { value: spec, updatedAt: new Date() } });

    return NextResponse.json({ spec });
  } catch (error) {
    if (error instanceof QuotaExceededError) {
      return NextResponse.json({ error: error.message }, { status: 402 });
    }
    console.error("图片套装脚本生成失败:", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : "生成失败" }, { status: 500 });
  }
}
