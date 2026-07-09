import { NextResponse } from "next/server";
import { getDb } from "@backend/db";
import { publishMetrics } from "@backend/db/schema";
import { aggregateByStyle, aggregateByHook } from "@backend/core/publish/performance-insights";

/**
 * GET /api/insights/styles —— 跨所有项目聚合投放数据，得出「哪种风格更能卖」+「哪个钩子机制更能卖」。
 * 转化率(成交/播放)降序，供导出页/仪表盘展示并反哺脚本/钩子生成。
 */
export async function GET() {
  const db = getDb();
  const rows = await db.select().from(publishMetrics);
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
