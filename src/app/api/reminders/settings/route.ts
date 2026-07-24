import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getDb } from "@backend/db";
import { merchants, wechatBindings } from "@backend/db/schema";
import { requireMerchant } from "@backend/core/auth/require-merchant";
import { formatWindow, goldenTimeHint } from "@backend/core/publish/golden-time";
import { getMerchantWindows, getPublishInventory } from "@backend/core/publish/reminder-context";
import { isWechatConfigured } from "@backend/core/notify/wechat";

/**
 * 发布提醒设置 —— 设置页「发布提醒」Tab 的读写接口。
 * 时段/库存与微信调度器同源（reminder-context），保证"提醒说的"和"设置页显示的"一个口径。
 */

/** 每天发几条的合法范围：1-5。非数字回默认 3（与前端 store 的 clampDailyPickCount 同口径），越界/小数夹紧取整 */
export function clampDailyTarget(value: unknown): number {
  const num =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : NaN;
  if (!Number.isFinite(num)) return 3;
  return Math.min(Math.max(Math.round(num), 1), 5);
}

/**
 * GET /api/reminders/settings —— 当前商家的提醒设置全貌：
 * 开关、每日条数、微信配置/绑定情况、发布时段（含校准来源与大白话依据）、当下建议文案、今日库存快照。
 */
export async function GET(req: NextRequest) {
  const auth = await requireMerchant(req);
  if ("error" in auth) return auth.error;
  try {
    const db = getDb();
    const [row] = await db
      .select({
        category: merchants.category,
        storeType: merchants.storeType,
        dailyPublishTarget: merchants.dailyPublishTarget,
        publishReminderEnabled: merchants.publishReminderEnabled,
      })
      .from(merchants)
      .where(eq(merchants.id, auth.merchant.id));
    if (!row) {
      return NextResponse.json({ error: "商家不存在" }, { status: 404 });
    }

    const resolved = await getMerchantWindows({
      id: auth.merchant.id,
      category: row.category,
      storeType: row.storeType,
    });
    // hint 注入校准后的 windows：商家数据够了之后，页面提示和微信提醒说的是同一套时段
    const localStore = row.storeType === "local" || row.storeType === "both";
    const { hint } = goldenTimeHint(row.category, new Date(), { localStore, windows: resolved.windows });
    const inventory = await getPublishInventory(
      { id: auth.merchant.id, dailyPublishTarget: row.dailyPublishTarget },
      new Date()
    );
    const bindings = await db
      .select({ id: wechatBindings.id })
      .from(wechatBindings)
      .where(eq(wechatBindings.merchantId, auth.merchant.id));

    return NextResponse.json({
      enabled: row.publishReminderEnabled,
      dailyTarget: row.dailyPublishTarget,
      wechatConfigured: isWechatConfigured(),
      bindingCount: bindings.length,
      windows: resolved.windows.map((w) => ({
        start: w.startMinute,
        end: w.endMinute,
        label: formatWindow(w),
      })),
      windowSource: resolved.source,
      windowBasis: resolved.basis,
      hint,
      inventory: {
        approvedUnpublished: inventory.approvedUnpublished,
        publishedToday: inventory.publishedToday,
        remainingToday: inventory.remainingToday,
      },
    });
  } catch (error) {
    console.error("读取发布提醒设置失败:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "读取发布提醒设置失败" },
      { status: 500 }
    );
  }
}

/**
 * POST /api/reminders/settings —— 更新提醒开关/每日条数。
 * body: { enabled?: boolean, dailyTarget?: number }，两个字段都可单独改（部分更新）。
 */
export async function POST(req: NextRequest) {
  const auth = await requireMerchant(req);
  if ("error" in auth) return auth.error;
  try {
    const body = await req.json().catch(() => ({}));
    const patch: { publishReminderEnabled?: boolean; dailyPublishTarget?: number } = {};
    if (typeof body.enabled === "boolean") patch.publishReminderEnabled = body.enabled;
    if (body.dailyTarget !== undefined) patch.dailyPublishTarget = clampDailyTarget(body.dailyTarget);
    if (Object.keys(patch).length > 0) {
      const db = getDb();
      await db
        .update(merchants)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(merchants.id, auth.merchant.id));
    }
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("更新发布提醒设置失败:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "更新发布提醒设置失败" },
      { status: 500 }
    );
  }
}
