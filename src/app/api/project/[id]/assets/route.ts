import { NextRequest, NextResponse } from "next/server";
import { getDataDir } from "@backend/shared/paths";
import { writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { getDb } from "@backend/db";
import { assets } from "@backend/db/schema";
import { desc, eq, getTableColumns, sql } from "drizzle-orm";
import { requireMerchant, requireOwnedProject } from "@backend/core/auth/require-merchant";
import { mediaRefBelongsToMerchant } from "@backend/core/auth/media-access";
import { readResponseBuffer, safeFetchPinned } from "@backend/shared/ssrf-guard";
import { ensureStorageCapacity } from "@backend/core/security/storage-guard";
import { randomUUID } from "crypto";

const MAX_REMOTE_ASSET_BYTES = 80 * 1024 * 1024;

// 获取某项目已生成的素材（素材页恢复状态用）
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireMerchant(req);
  if ("error" in auth) return auth.error;
  try {
    const { id } = await params;
    const owned = await requireOwnedProject(auth.merchant.id, id);
    if ("error" in owned) return owned.error;
    const db = getDb();
    // created_at 在 SQLite timestamp mode 中只到秒；UUID 字典序不代表新旧。
    // 返回 rowid 派生的只读序号，使同秒多次重生也能稳定选中最后落库版本。
    const revisionOrder = sql<number>`${assets}._rowid_`;
    const rows = await db
      .select({ ...getTableColumns(assets), revisionOrder })
      .from(assets)
      .where(eq(assets.projectId, id))
      .orderBy(desc(assets.createdAt), desc(revisionOrder));
    return NextResponse.json(rows);
  } catch (error) {
    console.error("获取素材失败:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "获取素材失败" },
      { status: 500 }
    );
  }
}

/** 把远程图片下载到本地 uploads，返回可访问的 /api/files 路径；本地路径则原样返回 */
async function persistSource(projectId: string, merchantId: string, sourceUrl: string, shotId: number): Promise<string> {
  // 本地引用只允许本项目目录或当前商家的商品库目录。
  if (sourceUrl.startsWith("/api/files/")) {
    if (!mediaRefBelongsToMerchant(sourceUrl, merchantId, projectId, { allowProducts: true })) {
      throw new Error("素材路径不属于当前商家或项目");
    }
    return sourceUrl;
  }

  // 远程 URL：下载到本地，避免合成时依赖外链（且 AI 素材外链常有有效期）
  if (/^https?:\/\//.test(sourceUrl)) {
    const resp = await safeFetchPinned(sourceUrl, {
      headers: { Accept: "image/*,video/mp4,video/webm,application/octet-stream" },
      signal: AbortSignal.timeout(20_000),
    });
    if (!resp.ok) throw new Error(`下载素材失败: ${resp.status}`);
    const ct = resp.headers.get("content-type") || "";
    if (!/^image\//i.test(ct) && !/^video\/(?:mp4|webm)/i.test(ct) && !/^application\/octet-stream/i.test(ct)) {
      throw new Error("远程素材类型不受支持");
    }
    const buf = await readResponseBuffer(resp, MAX_REMOTE_ASSET_BYTES);
    await ensureStorageCapacity(buf.byteLength);
    const ext = ct.includes("png") ? "png" : ct.includes("webp") ? "webp" : ct.includes("mp4") ? "mp4" : "jpg";
    const dir = join(getDataDir(), "uploads", projectId);
    await mkdir(dir, { recursive: true });
    const fileName = `asset-${shotId}-${randomUUID()}.${ext}`;
    await writeFile(join(dir, fileName), buf);
    return `/api/files/${projectId}/${fileName}`;
  }

  throw new Error("不支持的素材来源");
}

// 保存某分镜的新素材版本（素材生成成功后落库，供合成读取真实素材）
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireMerchant(req);
  if ("error" in auth) return auth.error;
  try {
    const { id } = await params;
    const owned = await requireOwnedProject(auth.merchant.id, id);
    if ("error" in owned) return owned.error;
    const body = await req.json();
    const { shotId, sourceUrl } = body as { shotId?: number; sourceUrl?: string };

    if (typeof shotId !== "number" || !sourceUrl) {
      return NextResponse.json({ error: "缺少 shotId 或 sourceUrl" }, { status: 400 });
    }
    // 校验 projectId 防路径穿越
    if (!/^[a-zA-Z0-9-]+$/.test(id)) {
      return NextResponse.json({ error: "无效的项目ID" }, { status: 400 });
    }

    const filePath = await persistSource(id, auth.merchant.id, sourceUrl, shotId);
    const db = getDb();

    const typeMap: Record<string, "ai_generated" | "product_image" | "user_upload"> = {
      ai_generate: "ai_generated",
      ai_generated: "ai_generated",
      product_image: "product_image",
      user_upload: "user_upload",
    };
    const assetType = typeMap[body.type] ?? "ai_generated";

    // 只追加新版本，不删除原图。动态视频另存 video_clips，合成时再按 assetId 关联原图溯源。
    const rows = await db
      .insert(assets)
      .values({
        projectId: id,
        shotId,
        type: assetType,
        filePath,
        provider: body.provider,
        model: body.model,
        prompt: body.prompt,
        status: "done",
      })
      .returning();

    return NextResponse.json(rows[0]);
  } catch (error) {
    console.error("保存素材失败:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "保存素材失败" },
      { status: 500 }
    );
  }
}
