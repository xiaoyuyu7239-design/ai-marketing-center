import { NextRequest, NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { existsSync } from "fs";
import { join } from "path";
import { getDb } from "@backend/db";
import { compositions } from "@backend/db/schema";
import { getDataDir } from "@backend/shared/paths";
import { generateCover } from "@backend/video-composer/cover";

const SAFE_ID = /^[a-zA-Z0-9-]+$/;

function jsonError(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!id || !SAFE_ID.test(id)) return jsonError("无效的项目ID");

  const body = await req.json().catch(() => ({}));
  const title = typeof body.title === "string" ? body.title.trim() : "";
  if (!title) return jsonError("请提供封面标题");

  const db = getDb();
  const [comp] = await db
    .select()
    .from(compositions)
    .where(eq(compositions.projectId, id))
    .orderBy(desc(compositions.createdAt))
    .limit(1);
  if (!comp?.outputPath || comp.status !== "done") return jsonError("请先合成视频再生成封面");

  const videoPath = existsSync(comp.outputPath) ? comp.outputPath : join(getDataDir(), comp.outputPath);
  if (!existsSync(videoPath)) return jsonError("成片文件不存在", 404);

  const fileName = `cover-${Date.now()}.png`;
  const outPath = join(getDataDir(), "uploads", id, fileName);
  const position = body.position === "lower" || body.position === "upper" ? body.position : "center";

  try {
    await generateCover({
      videoPath,
      title,
      outPath,
      frameAtSec: Number(body.frameAt) || 1,
      position,
    });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "封面生成失败", 500);
  }

  return NextResponse.json({ cover: `/api/files/${id}/${fileName}`, title });
}
