import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@backend/db";
import { projects } from "@backend/db/schema";
import { eq, desc } from "drizzle-orm";
import { requireMerchant } from "@backend/core/auth/require-merchant";

// 获取项目列表（只返回当前商家自己的项目）
export async function GET(req: NextRequest) {
  const auth = await requireMerchant(req);
  if ("error" in auth) return auth.error;
  try {
    const db = getDb();
    const result = await db
      .select()
      .from(projects)
      .where(eq(projects.merchantId, auth.merchant.id))
      .orderBy(desc(projects.createdAt));
    return NextResponse.json(result);
  } catch (error) {
    console.error("获取项目列表失败:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "获取项目列表失败" },
      { status: 500 }
    );
  }
}

// 创建新项目
export async function POST(req: NextRequest) {
  const auth = await requireMerchant(req);
  if ("error" in auth) return auth.error;
  try {
    const body = await req.json();
    const db = getDb();

    // 视频模式 / 来源类型做枚举白名单校验，非法值回退默认
    const VIDEO_MODES = ["product_closeup", "graphic_montage", "scene_demo", "live_presenter"];
    const videoMode = VIDEO_MODES.includes(body.videoMode) ? body.videoMode : undefined;
    const sourceType = body.sourceType === "clone" ? "clone" : undefined;
    // 图片套装项目走独立生产线页面；topic 由 /api/topic 入口创建，这里只放行显式请求的 image_pack
    const contentType = body.contentType === "image_pack" ? "image_pack" : undefined;

    const newProject = await db
      .insert(projects)
      .values({
        merchantId: auth.merchant.id,
        name: body.name || "未命名项目",
        productName: body.productName,
        productCategory: body.productCategory,
        productDescription: body.productDescription,
        productPrice: body.productPrice,
        shopUrl: body.shopUrl,
        affiliateCode: body.affiliateCode,
        productImages: body.productImages || [],
        ...(videoMode && { videoMode }),
        ...(sourceType && { sourceType }),
        ...(contentType && { contentType }),
        ...(body.sourceVideoUrl && { sourceVideoUrl: body.sourceVideoUrl }),
      })
      .returning();

    return NextResponse.json(newProject[0], { status: 201 });
  } catch (error) {
    console.error("创建项目失败:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "创建项目失败" },
      { status: 500 }
    );
  }
}
