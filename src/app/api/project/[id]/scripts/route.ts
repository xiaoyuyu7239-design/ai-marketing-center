import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@backend/db";
import { scripts } from "@backend/db/schema";
import { eq, desc } from "drizzle-orm";
import { requireMerchant, requireOwnedProject } from "@backend/core/auth/require-merchant";

interface ShotTextPatch {
  shotId: number;
  voiceover?: string;
  description?: string;
}

// 获取某项目的全部脚本方案（脚本页 / 素材页按 projectId 读取真实数据）
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
    const rows = await db
      .select()
      .from(scripts)
      .where(eq(scripts.projectId, id))
      .orderBy(desc(scripts.createdAt));
    return NextResponse.json(rows);
  } catch (error) {
    console.error("获取脚本失败:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "获取脚本失败" },
      { status: 500 }
    );
  }
}

// 更新某条脚本的选中状态（用户在脚本页切换选中的方案）
export async function PATCH(
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

    const scriptId = body.scriptId as string | undefined;
    const shotTexts = body.shotTexts as ShotTextPatch[] | undefined;
    if (scriptId && Array.isArray(shotTexts)) {
      const db = getDb();
      const [row] = await db.select().from(scripts).where(eq(scripts.id, scriptId));
      if (!row || row.projectId !== id) {
        return NextResponse.json({ error: "脚本不存在" }, { status: 404 });
      }

      const patchByShot = new Map<number, ShotTextPatch>();
      for (const patch of shotTexts) {
        if (patch && typeof patch.shotId === "number") patchByShot.set(patch.shotId, patch);
      }

      const updatedShots = (row.shots ?? []).map((shot) => {
        const patch = patchByShot.get(shot.shotId);
        if (!patch) return shot;
        return {
          ...shot,
          ...(typeof patch.voiceover === "string" && { voiceover: patch.voiceover.trim() }),
          ...(typeof patch.description === "string" && { description: patch.description.trim() }),
        };
      });

      const [updated] = await db
        .update(scripts)
        .set({ shots: updatedShots })
        .where(eq(scripts.id, scriptId))
        .returning();
      return NextResponse.json({ success: true, script: updated });
    }

    const selectedId = body.selectedScriptId as string | undefined;
    if (!selectedId) {
      return NextResponse.json({ error: "缺少 selectedScriptId 或 scriptId+shotTexts" }, { status: 400 });
    }
    const db = getDb();
    // 该项目下所有脚本先取消选中，再选中目标
    const rows = await db.select().from(scripts).where(eq(scripts.projectId, id));
    for (const r of rows) {
      await db
        .update(scripts)
        .set({ selected: r.id === selectedId })
        .where(eq(scripts.id, r.id));
    }
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("更新脚本选中状态失败:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "更新失败" },
      { status: 500 }
    );
  }
}
