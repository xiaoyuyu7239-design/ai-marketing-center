import { NextRequest, NextResponse } from "next/server";
import { mkdir } from "fs/promises";
import { join } from "path";
import { eq } from "drizzle-orm";
import { getDb } from "@backend/db";
import { projects, settings } from "@backend/db/schema";
import { getDataDir } from "@backend/shared/paths";
import { matteProductImage } from "@backend/core/media/matte";
import { requireMerchant, requireOwnedProject } from "@backend/core/auth/require-merchant";
import { consumeExpensiveRouteRateLimit, EXPENSIVE_RATE_LIMIT_PRESETS, rateLimitResponse } from "@backend/core/security/rate-limit";
import { resolveOwnedUploadRef } from "@backend/core/auth/media-access";
import { imageCleanKey } from "@backend/shared/image-clean";

/**
 * 商品图清洗：随手拍/杂乱背景 → 干净电商主图（本地抠图 + 合成）。
 * 清洗成功的图替换 project.productImages（下游脚本分析、分镜参考、图片套装全部受益）；
 * 原图↔清洗图映射存 settings，前端可对比并一键改回原图。单张失败自动保留原图，不阻断。
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireMerchant(req);
  if ("error" in auth) return auth.error;
  const limit = consumeExpensiveRouteRateLimit(req, auth.merchant.id, "project:clean-images", EXPENSIVE_RATE_LIMIT_PRESETS.cpu);
  if (!limit.allowed) return rateLimitResponse(limit, "商品图清洗过于频繁，请稍后再试");
  const { id } = await params;
  const owned = await requireOwnedProject(auth.merchant.id, id);
  if ("error" in owned) return owned.error;

  try {
    const db = getDb();
    const rows = await db.select().from(projects).where(eq(projects.id, id));
    const project = rows[0];
    if (!project) return NextResponse.json({ error: "项目不存在" }, { status: 404 });

    const body = await req.json().catch(() => ({}));
    const inputPaths: string[] = Array.isArray(body.paths)
      ? body.paths.filter((p: unknown): p is string => typeof p === "string")
      : Array.isArray(project.productImages)
        ? (project.productImages as string[])
        : [];
    if (inputPaths.length === 0) {
      return NextResponse.json({ error: "没有可清洗的商品图" }, { status: 400 });
    }
    const uploadsRoot = join(getDataDir(), "uploads");
    const dir = join(uploadsRoot, id);
    await mkdir(dir, { recursive: true });

    // 归属围栏必须和真正读盘用同一条解析后的路径，否则两套解析器口径不一致可被
    // `/api/output/<自己id>/api/files/<受害id>/x.jpg` 这类嵌套路径绕过、跨租户读别人的图。
    // 做法：先 resolveUploadFilePath 解析出真实绝对路径，再校验它的真实首段目录 ∈ {本项目id, products}。
    const pairs: Array<{ original: string; cleaned: string | null }> = [];
    let anyOwned = false;
    // 本地抠图 + 合成（免费、不烧任何 API/配额）：商品像素零改动，只换纯净背景 + 柔和接触阴影。
    // 顺序处理（张数少；抠图是 CPU 密集，串行避免占满机器）。单张失败保留原图，不阻断。
    for (let i = 0; i < inputPaths.length; i++) {
      const original = inputPaths[i];
      const inputAbs = resolveOwnedUploadRef(original, auth.merchant.id, id);
      if (!inputAbs) {
        pairs.push({ original, cleaned: null }); // 非本租户/非法路径：保留原图，不读盘
        continue;
      }
      anyOwned = true;
      const outName = `clean-${i}-${Date.now()}.jpg`;
      const outAbs = join(dir, outName);
      const ok = await matteProductImage(inputAbs, outAbs);
      pairs.push({ original, cleaned: ok ? `/api/files/${id}/${outName}` : null });
    }
    if (!anyOwned) {
      return NextResponse.json({ error: "商品图路径不合法" }, { status: 400 });
    }

    // 清洗成功的替换为清洗图；失败的保留原图
    const nextImages = pairs.map((p) => p.cleaned ?? p.original);
    await db.update(projects).set({ productImages: nextImages, updatedAt: new Date() }).where(eq(projects.id, id));
    await db
      .insert(settings)
      .values({ key: imageCleanKey(id), value: { pairs, useCleaned: true }, updatedAt: new Date() })
      .onConflictDoUpdate({ target: settings.key, set: { value: { pairs, useCleaned: true }, updatedAt: new Date() } });

    return NextResponse.json({ pairs, productImages: nextImages, cleanedCount: pairs.filter((p) => p.cleaned).length });
  } catch (error) {
    console.error("商品图清洗失败:", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : "清洗失败" }, { status: 500 });
  }
}

/** 切换使用清洗图/原图（PATCH {useCleaned:boolean}）：改写 project.productImages，下游全部跟随 */
export async function PATCH(
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
    const body = await req.json().catch(() => ({}));
    const useCleaned = Boolean(body.useCleaned);
    const rows = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, imageCleanKey(id)));
    const stored = rows[0]?.value as { pairs?: Array<{ original: string; cleaned: string | null }> } | undefined;
    if (!stored?.pairs?.length) {
      return NextResponse.json({ error: "该项目没有清洗记录" }, { status: 404 });
    }
    const nextImages = stored.pairs.map((p) => (useCleaned ? p.cleaned ?? p.original : p.original));
    await db.update(projects).set({ productImages: nextImages, updatedAt: new Date() }).where(eq(projects.id, id));
    await db
      .insert(settings)
      .values({ key: imageCleanKey(id), value: { ...stored, useCleaned }, updatedAt: new Date() })
      .onConflictDoUpdate({ target: settings.key, set: { value: { ...stored, useCleaned }, updatedAt: new Date() } });
    return NextResponse.json({ productImages: nextImages, useCleaned });
  } catch (error) {
    console.error("切换清洗图失败:", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : "切换失败" }, { status: 500 });
  }
}
