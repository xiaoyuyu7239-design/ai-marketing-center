import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@backend/db";
import { projects } from "@backend/db/schema";
import { eq, desc } from "drizzle-orm";

// 获取项目列表
export async function GET() {
  try {
    const db = getDb();
    const result = await db.select().from(projects).orderBy(desc(projects.createdAt));
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
  try {
    const body = await req.json();
    const db = getDb();

    // 视频模式 / 来源类型做枚举白名单校验，非法值回退默认
    const VIDEO_MODES = ["product_closeup", "graphic_montage", "scene_demo", "live_presenter"];
    const videoMode = VIDEO_MODES.includes(body.videoMode) ? body.videoMode : undefined;
    const sourceType = body.sourceType === "clone" ? "clone" : undefined;

    const newProject = await db
      .insert(projects)
      .values({
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
