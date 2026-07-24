import { NextRequest, NextResponse } from "next/server";
import { and, eq, desc } from "drizzle-orm";
import { getDb } from "@backend/db";
import { publishMetrics, publishRecords, projects, scripts as scriptsTable } from "@backend/db/schema";
import { requireMerchant, requireOwnedProject } from "@backend/core/auth/require-merchant";

const SAFE_ID = /^[a-zA-Z0-9\-]+$/;

function parseCount(value: unknown, options: { requiredPositive?: boolean } = {}): number | null {
  const { requiredPositive = false } = options;
  if (value === undefined || value === null || value === "") return requiredPositive ? null : 0;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isSafeInteger(parsed)) return null;
  if (requiredPositive ? parsed <= 0 : parsed < 0) return null;
  return parsed;
}

/** GET /api/project/[id]/metrics —— 列出该项目录入的投放数据（新→旧） */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireMerchant(req);
  if ("error" in auth) return auth.error;
  const { id } = await params;
  if (!id || !SAFE_ID.test(id)) return NextResponse.json({ error: "无效的项目ID" }, { status: 400 });
  const owned = await requireOwnedProject(auth.merchant.id, id);
  if ("error" in owned) return owned.error;
  const db = getDb();
  const rows = await db
    .select()
    .from(publishMetrics)
    .where(eq(publishMetrics.projectId, id))
    .orderBy(desc(publishMetrics.createdAt));
  return NextResponse.json({ metrics: rows, hasPerformanceData: rows.some((row) => row.views > 0) });
}

/**
 * POST /api/project/[id]/metrics —— 录入一条发布后的投放数据。
 * style/category 在此定格（优先取传入，否则取项目最新脚本风格 / 项目品类），便于后续按风格聚合不被改动污染。
 * body: { style?, category?, platform?, views, likes?, comments?, shares?, orders?, note? }
 * publishedAt 不接受客户端传值：只从同商家同项目的 publish_records 服务端记录定格。
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireMerchant(req);
  if ("error" in auth) return auth.error;
  const { id } = await params;
  if (!id || !SAFE_ID.test(id)) return NextResponse.json({ error: "无效的项目ID" }, { status: 400 });

  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    /* 允许空 body */
  }

  const db = getDb();
  const [project] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, id), eq(projects.merchantId, auth.merchant.id)));
  if (!project) return NextResponse.json({ error: "项目不存在" }, { status: 404 });

  const views = parseCount(body.views, { requiredPositive: true });
  if (views === null) {
    return NextResponse.json({ error: "播放数必须是大于 0 的有限整数" }, { status: 400 });
  }
  const optionalCounts = {
    likes: parseCount(body.likes),
    comments: parseCount(body.comments),
    shares: parseCount(body.shares),
    orders: parseCount(body.orders),
  };
  const invalidOptional = Object.entries(optionalCounts).find(([, value]) => value === null);
  if (invalidOptional) {
    const labels: Record<string, string> = { likes: "点赞数", comments: "评论数", shares: "转发数", orders: "成交数" };
    return NextResponse.json(
      { error: `${labels[invalidOptional[0]]}必须是有限非负整数` },
      { status: 400 }
    );
  }

  const [publishRecord] = await db
    .select({ publishedAt: publishRecords.publishedAt })
    .from(publishRecords)
    .where(and(eq(publishRecords.projectId, id), eq(publishRecords.merchantId, auth.merchant.id)))
    .limit(1);
  if (!publishRecord?.publishedAt) {
    return NextResponse.json({ error: "请先将成片标记为已发布，再回填效果数据" }, { status: 409 });
  }

  let style = typeof body.style === "string" && body.style ? body.style : "";
  if (!style) {
    const [s] = await db
      .select({ styleType: scriptsTable.styleType })
      .from(scriptsTable)
      .where(eq(scriptsTable.projectId, id))
      .orderBy(desc(scriptsTable.version))
      .limit(1);
    style = s?.styleType || "custom";
  }

  const category = typeof body.category === "string" ? body.category : project.productCategory ?? null;
  const platform = typeof body.platform === "string" ? body.platform.trim().toLowerCase() : "";
  if (!/^[a-z0-9_-]{1,32}$/.test(platform)) {
    return NextResponse.json({ error: "请选择有效的发布平台" }, { status: 400 });
  }
  const metricValues = {
    style,
    hookId: typeof body.hookId === "string" && body.hookId ? body.hookId : null,
    category,
    platform,
    views,
    likes: optionalCounts.likes!,
    comments: optionalCounts.comments!,
    shares: optionalCounts.shares!,
    orders: optionalCounts.orders!,
    note: typeof body.note === "string" ? body.note.slice(0, 500) : null,
    publishedAt: publishRecord.publishedAt,
    createdAt: new Date(),
  };
  const [row] = await db
    .insert(publishMetrics)
    .values({
      projectId: id,
      ...metricValues,
    })
    .onConflictDoUpdate({
      target: [publishMetrics.projectId, publishMetrics.platform],
      set: metricValues,
    })
    .returning();

  return NextResponse.json({ metric: row });
}
