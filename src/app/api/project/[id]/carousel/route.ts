import { NextRequest, NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { join } from "path";
import { getDb } from "@backend/db";
import { scripts as scriptsTable, type Shot } from "@backend/db/schema";
import { getDataDir } from "@backend/shared/paths";
import { generateCarousel } from "@backend/video-composer/carousel";

const SAFE_ID = /^[a-zA-Z0-9-]+$/;

function jsonError(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!id || !SAFE_ID.test(id)) return jsonError("无效的项目ID");

  const body = await req.json().catch(() => ({}));
  const width = Number(body.width) > 0 ? Math.min(1920, Math.round(Number(body.width))) : 1080;
  const height = Number(body.height) > 0 ? Math.min(1920, Math.round(Number(body.height))) : 1440;

  const db = getDb();
  const rows = await db
    .select()
    .from(scriptsTable)
    .where(eq(scriptsTable.projectId, id))
    .orderBy(desc(scriptsTable.version));
  if (!rows.length) return jsonError("该项目还没有脚本", 404);

  const script = rows.find((row) => row.selected) ?? rows[0];
  const shots = (script.shots ?? []) as Shot[];
  if (!shots.some((shot) => (shot.voiceover ?? "").trim())) {
    return jsonError("脚本没有可生成卡片的旁白文案", 422);
  }

  const prefix = `card-${Date.now()}`;
  const outDir = join(getDataDir(), "uploads", id, "carousel");
  try {
    const files = await generateCarousel({
      title: script.title || "图文",
      shots,
      outDir,
      prefix,
      width,
      height,
      theme: typeof body.theme === "string" ? body.theme : undefined,
    });
    const cards = files.map((file) => `/api/files/${id}/carousel/${file.split("/").pop()}`);
    return NextResponse.json({ count: cards.length, cards });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "卡片生成失败", 500);
  }
}
