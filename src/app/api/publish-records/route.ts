import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { getDb } from "@backend/db";
import { publishRecords } from "@backend/db/schema";
import { requireMerchant, requireOwnedProject } from "@backend/core/auth/require-merchant";

const VALID_ACTIONS = new Set(["approve", "unapprove", "publish", "unpublish"]);

/**
 * GET /api/publish-records —— 当前商家的待发布库状态（认可入库/已发布），前端 store 水合用。
 * 返回 { records: [{ projectId, approvedAt, publishedAt, platform, reviewStatus }] }
 */
export async function GET(req: NextRequest) {
  const auth = await requireMerchant(req);
  if ("error" in auth) return auth.error;
  try {
    const db = getDb();
    const rows = await db
      .select({
        projectId: publishRecords.projectId,
        approvedAt: publishRecords.approvedAt,
        publishedAt: publishRecords.publishedAt,
        platform: publishRecords.platform,
        reviewStatus: publishRecords.reviewStatus,
        reviewNote: publishRecords.reviewNote,
      })
      .from(publishRecords)
      .where(eq(publishRecords.merchantId, auth.merchant.id));
    return NextResponse.json({
      records: rows.map((r) => ({
        projectId: r.projectId,
        approvedAt: r.approvedAt ? r.approvedAt.toISOString() : null,
        publishedAt: r.publishedAt ? r.publishedAt.toISOString() : null,
        platform: r.platform,
        reviewStatus: r.reviewStatus,
        reviewNote: r.reviewNote,
      })),
    });
  } catch (error) {
    console.error("读取待发布库失败:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "读取待发布库失败" },
      { status: 500 }
    );
  }
}

/**
 * POST /api/publish-records —— 更新某个项目的入库/发布状态。
 * body: { projectId, action: "approve"|"unapprove"|"publish"|"unpublish", platform? }
 * unapprove 直接删记录；publish 隐含 approve（没入库过的也可直接标记发布）。
 */
export async function POST(req: NextRequest) {
  const auth = await requireMerchant(req);
  if ("error" in auth) return auth.error;
  try {
    const body = await req.json().catch(() => ({}));
    const projectId = typeof body.projectId === "string" ? body.projectId : "";
    const action = typeof body.action === "string" ? body.action : "";
    if (!projectId || !VALID_ACTIONS.has(action)) {
      return NextResponse.json({ error: "缺少 projectId 或 action 不合法" }, { status: 400 });
    }
    const owned = await requireOwnedProject(auth.merchant.id, projectId);
    if ("error" in owned) return owned.error;

    const db = getDb();
    const merchantScope = and(eq(publishRecords.projectId, projectId), eq(publishRecords.merchantId, auth.merchant.id));
    const [existing] = await db.select().from(publishRecords).where(merchantScope);

    // 平台已驳回的内容：商家不能通过重新入库/发布来"洗白"运营的审核决定。
    // 但收敛性动作（撤销入库/撤回发布标记）要放行——否则商家会卡在无法清除自己旧标记的死循环里。
    if (existing?.reviewStatus === "rejected") {
      if (action === "unapprove") {
        // 撤销入库意图：清 approvedAt/publishedAt，但保留驳回记录本身（不删行，防止删后重建洗白）
        await db.update(publishRecords).set({ approvedAt: null, publishedAt: null, platform: null, updatedAt: new Date() }).where(merchantScope);
        return NextResponse.json({ success: true });
      }
      if (action === "unpublish") {
        // 撤回发布标记：只清 publishedAt/platform，是收敛动作，不构成洗白，放行
        await db.update(publishRecords).set({ publishedAt: null, platform: null, updatedAt: new Date() }).where(merchantScope);
        return NextResponse.json({ success: true });
      }
      // approve / publish 才是"重新上架"，拒绝
      return NextResponse.json({ error: "该内容已被平台审核驳回，暂不能入库或发布，如有疑问请联系客服" }, { status: 403 });
    }

    if (action === "unapprove") {
      // 移出库存：整条记录删掉（含发布标记——移出即视为撤回这条内容的全部状态）
      if (existing) await db.delete(publishRecords).where(merchantScope);
      return NextResponse.json({ success: true });
    }

    if (action === "unpublish") {
      if (existing) {
        await db.update(publishRecords).set({ publishedAt: null, platform: null, updatedAt: new Date() }).where(merchantScope);
      }
      return NextResponse.json({ success: true });
    }

    const now = new Date();
    const platform = typeof body.platform === "string" && body.platform.trim() ? body.platform.trim().slice(0, 40) : null;
    // 迁移旧 localStorage 记录时会带原始时间戳（影响待发布排序的新旧权重）；仅新插入时生效，不允许改写已有记录
    const parseStamp = (value: unknown): Date | null => {
      if (typeof value !== "string" || !value) return null;
      const ms = Date.parse(value);
      return Number.isFinite(ms) && ms <= Date.now() ? new Date(ms) : null;
    };
    const approvedStamp = parseStamp(body.approvedAt) ?? now;
    const publishedStamp = parseStamp(body.publishedAt) ?? now;
    if (!existing) {
      await db.insert(publishRecords).values({
        merchantId: auth.merchant.id,
        projectId,
        approvedAt: approvedStamp,
        ...(action === "publish" ? { publishedAt: publishedStamp, platform } : {}),
      });
    } else if (action === "approve") {
      await db
        .update(publishRecords)
        .set({ approvedAt: existing.approvedAt ?? now, updatedAt: now })
        .where(merchantScope);
    } else {
      // publish：保留原入库时间，写发布时间/平台
      await db
        .update(publishRecords)
        .set({ approvedAt: existing.approvedAt ?? now, publishedAt: existing.publishedAt ?? now, ...(platform ? { platform } : {}), updatedAt: now })
        .where(merchantScope);
    }
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("更新待发布库失败:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "更新待发布库失败" },
      { status: 500 }
    );
  }
}
