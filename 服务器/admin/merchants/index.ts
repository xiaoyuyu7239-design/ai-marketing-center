import "server-only";

import { and, desc, eq, gte, sql } from "drizzle-orm";
import { getDb } from "@backend/db";
import { compositions, generationUsage, merchants, plans, projects, publishRecords } from "@backend/db/schema";

/** 内部运营后台的商家视图行：账号/建档/套餐/本月用量/内容规模一屏看全 */
export interface AdminMerchantRow {
  id: string;
  email: string;
  shopName: string | null;
  category: string | null;
  region: string | null;
  planId: string;
  planName: string;
  monthlyQuota: number; // 套餐额度 + 赠送额度
  quotaBonus: number;
  // 本自然月已占用的 workflow 父额度：reserved/running/succeeded/partial 均为 success=true；全失败释放。
  usedThisMonth: number;
  projectCount: number;
  approvedCount: number; // 待发布库中入库条数
  publishedCount: number;
  createdAt: string | null;
}

export interface AdminPlanRow {
  id: string;
  name: string;
  monthlyGenerationQuota: number;
}

function startOfCurrentMonth(): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), 1);
}

export async function listPlans(): Promise<AdminPlanRow[]> {
  const db = getDb();
  const rows = await db
    .select({ id: plans.id, name: plans.name, monthlyGenerationQuota: plans.monthlyGenerationQuota })
    .from(plans);
  return rows;
}

export async function listMerchants(): Promise<AdminMerchantRow[]> {
  const db = getDb();
  const merchantRows = await db
    .select({
      id: merchants.id,
      email: merchants.email,
      shopName: merchants.shopName,
      category: merchants.category,
      region: merchants.region,
      planId: merchants.planId,
      planName: plans.name,
      planQuota: plans.monthlyGenerationQuota,
      quotaBonus: merchants.quotaBonus,
      createdAt: merchants.createdAt,
    })
    .from(merchants)
    .innerJoin(plans, eq(merchants.planId, plans.id))
    .orderBy(desc(merchants.createdAt));

  // 三组聚合分开查（商家数量级在内部后台场景下很小，清晰优先）
  const usageRows = await db
    .select({ merchantId: generationUsage.merchantId, used: sql<number>`count(*)` })
    .from(generationUsage)
    .where(and(eq(generationUsage.success, true), gte(generationUsage.createdAt, startOfCurrentMonth())))
    .groupBy(generationUsage.merchantId);
  const projectRows = await db
    .select({ merchantId: projects.merchantId, total: sql<number>`count(*)` })
    .from(projects)
    .groupBy(projects.merchantId);
  const recordRows = await db
    .select({
      merchantId: publishRecords.merchantId,
      approved: sql<number>`sum(case when ${publishRecords.approvedAt} is not null and ${publishRecords.reviewStatus} != 'rejected' then 1 else 0 end)`,
      // 与 approved 口径统一排除 rejected（驳回已清 publishedAt，这里加过滤是双保险，避免历史脏数据出现"入库0/已发1"）
      published: sql<number>`sum(case when ${publishRecords.publishedAt} is not null and ${publishRecords.reviewStatus} != 'rejected' then 1 else 0 end)`,
    })
    .from(publishRecords)
    .groupBy(publishRecords.merchantId);

  const usageBy = new Map(usageRows.map((r) => [r.merchantId, Number(r.used)]));
  const projectsBy = new Map(projectRows.map((r) => [r.merchantId ?? "", Number(r.total)]));
  const recordsBy = new Map(recordRows.map((r) => [r.merchantId, { approved: Number(r.approved ?? 0), published: Number(r.published ?? 0) }]));

  return merchantRows.map((m) => ({
    id: m.id,
    email: m.email,
    shopName: m.shopName,
    category: m.category,
    region: m.region,
    planId: m.planId,
    planName: m.planName,
    monthlyQuota: m.planQuota + m.quotaBonus,
    quotaBonus: m.quotaBonus,
    usedThisMonth: usageBy.get(m.id) ?? 0,
    projectCount: projectsBy.get(m.id) ?? 0,
    approvedCount: recordsBy.get(m.id)?.approved ?? 0,
    publishedCount: recordsBy.get(m.id)?.published ?? 0,
    createdAt: m.createdAt ? m.createdAt.toISOString() : null,
  }));
}

/** 更新商家的套餐/赠送额度；planId 必须存在，quotaBonus 只收 0~1e9 的整数 */
export async function updateMerchantPlan(
  merchantId: string,
  patch: { planId?: unknown; quotaBonus?: unknown }
): Promise<{ ok: true } | { ok: false; error: string }> {
  const db = getDb();
  const updates: Record<string, unknown> = {};

  if (patch.planId !== undefined) {
    const planId = String(patch.planId);
    const plan = await db.select({ id: plans.id }).from(plans).where(eq(plans.id, planId));
    if (plan.length === 0) return { ok: false, error: `套餐不存在：${planId}` };
    updates.planId = planId;
  }
  if (patch.quotaBonus !== undefined) {
    const bonus = Number(patch.quotaBonus);
    if (!Number.isInteger(bonus) || bonus < 0 || bonus > 1_000_000_000) {
      return { ok: false, error: "赠送额度必须是 0~10 亿之间的整数" };
    }
    updates.quotaBonus = bonus;
  }
  if (Object.keys(updates).length === 0) return { ok: false, error: "没有可更新的字段" };

  const rows = await db.update(merchants).set({ ...updates, updatedAt: new Date() }).where(eq(merchants.id, merchantId)).returning({ id: merchants.id });
  if (rows.length === 0) return { ok: false, error: "商家不存在" };
  return { ok: true };
}

export type ReviewStatus = "pending" | "approved" | "rejected";
const REVIEW_STATUSES = new Set<ReviewStatus>(["pending", "approved", "rejected"]);

/** 审核队列行：给运营看"哪个商家的哪条视频"，带成片直链方便点开看 */
export interface AdminReviewRow {
  recordId: string;
  merchantId: string;
  merchantEmail: string;
  shopName: string | null;
  projectId: string;
  projectName: string;
  productName: string | null;
  reviewStatus: ReviewStatus;
  reviewNote: string | null;
  approvedAt: string | null;
  publishedAt: string | null;
  videoUrl: string | null; // 最新成功成片的可访问地址（/api/output/...），无成片为 null
}

export async function listReviewQueue(status?: string): Promise<AdminReviewRow[]> {
  const db = getDb();
  const filter = status && REVIEW_STATUSES.has(status as ReviewStatus) ? (status as ReviewStatus) : undefined;

  const rows = await db
    .select({
      recordId: publishRecords.id,
      merchantId: publishRecords.merchantId,
      merchantEmail: merchants.email,
      shopName: merchants.shopName,
      projectId: publishRecords.projectId,
      projectName: projects.name,
      productName: projects.productName,
      reviewStatus: publishRecords.reviewStatus,
      reviewNote: publishRecords.reviewNote,
      approvedAt: publishRecords.approvedAt,
      publishedAt: publishRecords.publishedAt,
    })
    .from(publishRecords)
    .innerJoin(merchants, eq(publishRecords.merchantId, merchants.id))
    .innerJoin(projects, eq(publishRecords.projectId, projects.id))
    .where(filter ? eq(publishRecords.reviewStatus, filter) : undefined)
    .orderBy(desc(publishRecords.updatedAt));

  // 每条记录取最新一条【成功】成片拼可访问 URL：不能只取最新一行，否则重合成失败/进行中会把已有成片藏起来
  const results: AdminReviewRow[] = [];
  for (const row of rows) {
    const [comp] = await db
      .select({ outputPath: compositions.outputPath })
      .from(compositions)
      .where(and(eq(compositions.projectId, row.projectId), eq(compositions.status, "done")))
      .orderBy(desc(compositions.createdAt))
      .limit(1);
    const fileName = comp ? (comp.outputPath ?? "").split("/").pop() : null;
    results.push({
      recordId: row.recordId,
      merchantId: row.merchantId,
      merchantEmail: row.merchantEmail,
      shopName: row.shopName,
      projectId: row.projectId,
      projectName: row.projectName,
      productName: row.productName,
      reviewStatus: row.reviewStatus,
      reviewNote: row.reviewNote,
      approvedAt: row.approvedAt ? row.approvedAt.toISOString() : null,
      publishedAt: row.publishedAt ? row.publishedAt.toISOString() : null,
      videoUrl: fileName ? `/api/output/${row.projectId}/${fileName}` : null,
    });
  }
  return results;
}

/**
 * 更新审核状态：驳回后该内容立即从商家的待发布库/今日推荐里消失（商家端已按 reviewStatus 过滤）。
 * 驳回时同时清掉 approvedAt/publishedAt/platform——否则被驳回的已发布记录会永久计入"已发"统计，
 * 出现"入库 0 / 已发 1"这类自相矛盾的商家行，也让商家端"已发布"列表残留下架内容。
 */
export async function setReviewStatus(
  recordId: string,
  status: unknown,
  note?: unknown
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!REVIEW_STATUSES.has(status as ReviewStatus)) {
    return { ok: false, error: "非法的审核状态" };
  }
  const db = getDb();
  const reviewNote = typeof note === "string" && note.trim() ? note.trim().slice(0, 200) : null;
  const patch: Record<string, unknown> = { reviewStatus: status as ReviewStatus, updatedAt: new Date() };
  if (status === "rejected") {
    patch.reviewNote = reviewNote;
    patch.approvedAt = null;
    patch.publishedAt = null;
    patch.platform = null;
  } else {
    // 通过/恢复待复核：清掉驳回原因
    patch.reviewNote = null;
  }
  const rows = await db.update(publishRecords).set(patch).where(eq(publishRecords.id, recordId)).returning({ id: publishRecords.id });
  if (rows.length === 0) return { ok: false, error: "审核记录不存在" };
  return { ok: true };
}
