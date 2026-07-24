import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import { existsSync } from "fs";
import { join } from "path";
import { getDb } from "@backend/db";
import { compositions, projects } from "@backend/db/schema";
import { generateShopQr } from "@backend/core/publish/shop-qr";
import { getDataDir } from "@backend/shared/paths";
import { generateEndCard } from "@backend/video-composer/end-card";
import { resolveChineseFontFile } from "@backend/video-composer/composer";
import { requireMerchant } from "@backend/core/auth/require-merchant";
import { consumeExpensiveRouteRateLimit, EXPENSIVE_RATE_LIMIT_PRESETS, rateLimitResponse } from "@backend/core/security/rate-limit";

const SAFE_ID = /^[a-zA-Z0-9-]+$/;

function jsonError(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireMerchant(req);
  if ("error" in auth) return auth.error;
  const limit = consumeExpensiveRouteRateLimit(req, auth.merchant.id, "project:end-card", EXPENSIVE_RATE_LIMIT_PRESETS.cpu);
  if (!limit.allowed) return rateLimitResponse(limit, "片尾生成过于频繁，请稍后再试");
  const { id } = await params;
  if (!id || !SAFE_ID.test(id)) return jsonError("无效的项目ID");

  const body = await req.json().catch(() => ({}));
  const db = getDb();
  const [proj] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, id), eq(projects.merchantId, auth.merchant.id)))
    .limit(1);
  if (!proj) return jsonError("项目不存在", 404);

  const commerce = proj as typeof proj & { shopUrl?: string | null; affiliateCode?: string | null };
  const shopUrl = (typeof body.url === "string" && body.url.trim()) || commerce.shopUrl || "";
  if (!shopUrl) return jsonError("该项目没有商品链接，请先设置或用 url 传入");

  const [comp] = await db
    .select()
    .from(compositions)
    .where(eq(compositions.projectId, id))
    .orderBy(desc(compositions.createdAt))
    .limit(1);
  if (!comp?.outputPath || comp.status !== "done") return jsonError("请先合成视频再生成片尾二维码");

  const videoPath = existsSync(comp.outputPath) ? comp.outputPath : join(getDataDir(), comp.outputPath);
  if (!existsSync(videoPath)) return jsonError("成片文件不存在", 404);

  const timestamp = Date.now();
  const qrPath = join(getDataDir(), "uploads", id, `endcard-qr-${timestamp}.png`);
  const outName = `endcard-${timestamp}.mp4`;
  const outPath = join(getDataDir(), "output", id, outName);
  const ctaText = typeof body.ctaText === "string" && body.ctaText.trim() ? body.ctaText.trim() : undefined;

  try {
    const shopLink = await generateShopQr(shopUrl, qrPath, {
      platform: typeof body.platform === "string" ? body.platform : undefined,
      affiliateCode: commerce.affiliateCode ?? undefined,
    });
    await generateEndCard({
      videoPath,
      qrPath,
      outPath,
      ctaText,
      seconds: typeof body.seconds === "number" ? body.seconds : undefined,
      fontFile: resolveChineseFontFile(),
    });
    return NextResponse.json({ video: `/api/output/${id}/${outName}`, shopLink });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "片尾二维码生成失败", 500);
  }
}
