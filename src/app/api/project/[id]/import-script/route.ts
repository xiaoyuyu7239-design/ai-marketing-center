import { NextRequest, NextResponse } from "next/server";
import { eq, desc } from "drizzle-orm";
import { getDb } from "@backend/db";
import { scripts as scriptsTable, projects } from "@backend/db/schema";
import { splitNarrationIntoShots } from "@backend/core/script/script-import";

const SAFE_ID = /^[a-zA-Z0-9\-]+$/;

/**
 * POST /api/project/[id]/import-script —— 用用户自己写好的脚本/旁白直接成片（不经 AI 生成）。
 * 把整段文案按句切成分镜、估算时长，存为当前选中脚本；之后照常自动配画面（或配本地自有素材）+ 配音 + 合成。
 * body: { script: string, title?: string }
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!id || !SAFE_ID.test(id)) return NextResponse.json({ error: "无效的项目ID" }, { status: 400 });

  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    /* 允许空 body，下面校验 */
  }
  const text = typeof body.script === "string" ? body.script.trim() : "";
  if (text.length < 2) return NextResponse.json({ error: "请提供脚本文案" }, { status: 400 });

  const db = getDb();
  const [project] = await db.select().from(projects).where(eq(projects.id, id));
  if (!project) return NextResponse.json({ error: "项目不存在" }, { status: 404 });

  const shots = splitNarrationIntoShots(text);
  if (!shots.length) return NextResponse.json({ error: "脚本无法切分出分镜（缺少有效文案）" }, { status: 422 });
  const totalDuration = shots.reduce((sum, s) => sum + s.duration, 0);

  // 取下一个版本号；把旧脚本取消选中，新导入脚本设为当前选中
  const [latest] = await db
    .select({ version: scriptsTable.version })
    .from(scriptsTable)
    .where(eq(scriptsTable.projectId, id))
    .orderBy(desc(scriptsTable.version))
    .limit(1);
  const nextVersion = (latest?.version ?? 0) + 1;
  await db.update(scriptsTable).set({ selected: false }).where(eq(scriptsTable.projectId, id));

  const title =
    typeof body.title === "string" && body.title.trim()
      ? body.title.trim().slice(0, 80)
      : (shots[0]?.voiceover ?? "导入脚本").slice(0, 30);

  const [row] = await db
    .insert(scriptsTable)
    .values({
      projectId: id,
      version: nextVersion,
      styleType: "custom",
      title,
      totalDuration,
      shots,
      selected: true,
    })
    .returning();

  return NextResponse.json({ scriptId: row.id, version: nextVersion, shots: shots.length, totalDuration });
}
