import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getDb } from "@backend/db";
import { publishMetrics, projects } from "@backend/db/schema";
import { aggregateByStyle, aggregateByHook } from "@backend/core/publish/performance-insights";
import { requireMerchant } from "@backend/core/auth/require-merchant";

/**
 * GET /api/insights/styles —— 跨当前商家自己的项目聚合投放数据，得出「哪种风格更能卖」+「哪个钩子机制更能卖」。
 * 转化率(成交/播放)降序，供导出页/仪表盘展示并反哺脚本/钩子生成。不跨商家聚合。
 */
export async function GET(req: NextRequest) {
  const auth = await requireMerchant(req);
  if ("error" in auth) return auth.error;
  const db = getDb();
  const rows = await db
    .select({
      style: publishMetrics.style,
      hookId: publishMetrics.hookId,
      views: publishMetrics.views,
      likes: publishMetrics.likes,
      comments: publishMetrics.comments,
      shares: publishMetrics.shares,
      orders: publishMetrics.orders,
    })
    .from(publishMetrics)
    .innerJoin(projects, eq(publishMetrics.projectId, projects.id))
    .where(eq(projects.merchantId, auth.merchant.id));
  const records = rows
    .filter((r) => r.views > 0)
    .map((r) => ({
      style: r.style,
      hookId: r.hookId ?? undefined,
      views: r.views,
      likes: r.likes,
      comments: r.comments,
      shares: r.shares,
      orders: r.orders,
    }));
  return NextResponse.json({
    insights: aggregateByStyle(records),
    hookInsights: aggregateByHook(records),
    total: records.length,
  });
}
