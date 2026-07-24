import { NextRequest, NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { existsSync } from "fs";
import { join } from "path";
import { getDb } from "@backend/db";
import { compositions } from "@backend/db/schema";
import { getDataDir } from "@backend/shared/paths";
import { generateGifPreview } from "@backend/video-composer/gif-preview";
import { requireMerchant, requireOwnedProject } from "@backend/core/auth/require-merchant";
import { consumeExpensiveRouteRateLimit, EXPENSIVE_RATE_LIMIT_PRESETS, rateLimitResponse } from "@backend/core/security/rate-limit";

const SAFE_ID = /^[a-zA-Z0-9-]+$/;

function jsonError(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireMerchant(req);
  if ("error" in auth) return auth.error;
  const limit = consumeExpensiveRouteRateLimit(req, auth.merchant.id, "project:preview-gif", EXPENSIVE_RATE_LIMIT_PRESETS.cpu);
  if (!limit.allowed) return rateLimitResponse(limit, "GIF 预览生成过于频繁，请稍后再试");
  const { id } = await params;
  if (!id || !SAFE_ID.test(id)) return jsonError("无效的项目ID");
  const owned = await requireOwnedProject(auth.merchant.id, id);
  if ("error" in owned) return owned.error;

  const body = await req.json().catch(() => ({}));
  const db = getDb();
  const [comp] = await db
    .select()
    .from(compositions)
    .where(eq(compositions.projectId, id))
    .orderBy(desc(compositions.createdAt))
    .limit(1);
  if (!comp?.outputPath || comp.status !== "done") return jsonError("请先合成视频再生成预览 GIF");

  const videoPath = existsSync(comp.outputPath) ? comp.outputPath : join(getDataDir(), comp.outputPath);
  if (!existsSync(videoPath)) return jsonError("成片文件不存在", 404);

  const fileName = `preview-${Date.now()}.gif`;
  const outPath = join(getDataDir(), "uploads", id, fileName);
  try {
    await generateGifPreview({
      videoPath,
      outPath,
      startSec: Number(body.startSec) || 0,
      durationSec: Number(body.durationSec) || 4,
      width: Number(body.width) || 360,
    });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "GIF 生成失败", 500);
  }

  return NextResponse.json({ gif: `/api/files/${id}/${fileName}` });
}
