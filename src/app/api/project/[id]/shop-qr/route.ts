import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { join } from "path";
import { getDb } from "@backend/db";
import { projects } from "@backend/db/schema";
import { getDataDir } from "@backend/shared/paths";
import { generateShopQr } from "@backend/core/publish/shop-qr";

const SAFE_ID = /^[a-zA-Z0-9-]+$/;

function jsonError(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!id || !SAFE_ID.test(id)) return jsonError("无效的项目ID");

  const body = await req.json().catch(() => ({}));
  const db = getDb();
  const [proj] = await db.select().from(projects).where(eq(projects.id, id)).limit(1);
  if (!proj) return jsonError("项目不存在", 404);

  const commerce = proj as typeof proj & { shopUrl?: string | null; affiliateCode?: string | null };
  const shopUrl = (typeof body.url === "string" && body.url.trim()) || commerce.shopUrl || "";
  if (!shopUrl) return jsonError("该项目没有商品链接，请先设置或用 url 传入");

  const fileName = `shop-qr-${Date.now()}.png`;
  const outPath = join(getDataDir(), "uploads", id, fileName);

  try {
    const shopLink = await generateShopQr(shopUrl, outPath, {
      platform: typeof body.platform === "string" ? body.platform : undefined,
      affiliateCode: commerce.affiliateCode ?? undefined,
      size: typeof body.size === "number" ? body.size : undefined,
    });
    return NextResponse.json({ qr: `/api/files/${id}/${fileName}`, shopLink });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "二维码生成失败", 500);
  }
}
