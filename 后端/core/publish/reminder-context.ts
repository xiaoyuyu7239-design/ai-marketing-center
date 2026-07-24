import "server-only";

import { and, desc, eq, gt, inArray, isNotNull, ne } from "drizzle-orm";
import { getDb } from "@backend/db";
import { contentDiagnosis, merchants, projects, publishMetrics, publishRecords } from "@backend/db/schema";
import { resolveWindows, type PublishSample, type ResolvedWindows } from "./golden-time";

/**
 * 发布提醒的商家上下文 —— 调度器（到点推微信）和设置页/今日卡片（展示时段与库存）
 * 统一从这里取数，保证"提醒说的"和"页面显示的"永远一个口径。
 */

/** 校准取样上限：只看最近这么多条回流，老数据不再代表现在的粉丝作息 */
const CALIBRATION_SAMPLE_LIMIT = 60;

export interface PublishInventorySnapshot {
  /** 库里认可入库、还没发的条数（可发库存） */
  approvedUnpublished: number;
  /** 今天已标记发布的条数 */
  publishedToday: number;
  /** 每天计划发几条 */
  dailyTarget: number;
  /** 今天还差几条（不为负） */
  remainingToday: number;
  /** 推荐先发的前几条（诊断分高的优先，其次入库新的优先） */
  topCandidates: { projectId: string; name: string }[];
}

/** 拉这家店的回流样本（发布时刻 × 播放量），供时段校准用 */
export async function getMerchantPublishSamples(merchantId: string): Promise<PublishSample[]> {
  const db = getDb();
  const rows = await db
    .select({ publishedAt: publishMetrics.publishedAt, views: publishMetrics.views })
    .from(publishMetrics)
    .innerJoin(projects, eq(publishMetrics.projectId, projects.id))
    .where(and(eq(projects.merchantId, merchantId), isNotNull(publishMetrics.publishedAt), gt(publishMetrics.views, 0)))
    .orderBy(desc(publishMetrics.publishedAt))
    .limit(CALIBRATION_SAMPLE_LIMIT);
  return rows
    .filter((r) => r.publishedAt instanceof Date)
    .map((r) => ({
      minuteOfDay: r.publishedAt!.getHours() * 60 + r.publishedAt!.getMinutes(),
      engagement: r.views ?? 0,
    }));
}

/** 这家店的发布时段（够样本→自家数据校准，不够→行业模板），含大白话依据 */
export async function getMerchantWindows(merchant: {
  id: string;
  category: string | null;
  storeType: string | null;
}): Promise<ResolvedWindows> {
  const samples = await getMerchantPublishSamples(merchant.id);
  const localStore = merchant.storeType === "local" || merchant.storeType === "both";
  return resolveWindows(merchant.category, { localStore, samples });
}

/** 本地时钟当天零点（提醒去重和"今天已发几条"都以服务器本地日为界） */
export function startOfLocalDay(now: Date): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

/** 本地日期 "YYYY-MM-DD"（reminder_logs.plan_date 口径） */
export function localDateKey(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** 这家店的可发库存快照：库里还有几条、今天发了几条、还差几条、推荐先发哪几条 */
export async function getPublishInventory(
  merchant: { id: string; dailyPublishTarget: number },
  now: Date
): Promise<PublishInventorySnapshot> {
  const db = getDb();
  const rows = await db
    .select({
      projectId: publishRecords.projectId,
      approvedAt: publishRecords.approvedAt,
      publishedAt: publishRecords.publishedAt,
      name: projects.name,
    })
    .from(publishRecords)
    .innerJoin(projects, eq(publishRecords.projectId, projects.id))
    .where(and(eq(publishRecords.merchantId, merchant.id), ne(publishRecords.reviewStatus, "rejected")));

  const dayStart = startOfLocalDay(now);
  const candidates = rows.filter((r) => r.approvedAt && !r.publishedAt);
  const publishedToday = rows.filter((r) => r.publishedAt && r.publishedAt >= dayStart).length;

  // 推荐排序：诊断分高的优先（更可能出效果），没诊断过的按入库时间新的优先
  const scoreByProject = new Map<string, number>();
  if (candidates.length > 0) {
    const diagRows = await db
      .select({
        projectId: contentDiagnosis.projectId,
        overallScore: contentDiagnosis.overallScore,
        createdAt: contentDiagnosis.createdAt,
      })
      .from(contentDiagnosis)
      .where(inArray(contentDiagnosis.projectId, candidates.map((c) => c.projectId)))
      .orderBy(desc(contentDiagnosis.createdAt));
    for (const d of diagRows) {
      if (!scoreByProject.has(d.projectId)) scoreByProject.set(d.projectId, d.overallScore);
    }
  }
  const topCandidates = [...candidates]
    .sort((a, b) => {
      const scoreDiff = (scoreByProject.get(b.projectId) ?? -1) - (scoreByProject.get(a.projectId) ?? -1);
      if (scoreDiff !== 0) return scoreDiff;
      return (b.approvedAt?.getTime() ?? 0) - (a.approvedAt?.getTime() ?? 0);
    })
    .slice(0, 3)
    .map((c) => ({ projectId: c.projectId, name: c.name }));

  const dailyTarget = merchant.dailyPublishTarget > 0 ? merchant.dailyPublishTarget : 3;
  return {
    approvedUnpublished: candidates.length,
    publishedToday,
    dailyTarget,
    remainingToday: Math.max(0, dailyTarget - publishedToday),
    topCandidates,
  };
}

/** 所有"开了提醒"的商家（是否绑定微信由调度器再过滤，这里只管开关与画像字段） */
export async function listReminderEnabledMerchants() {
  const db = getDb();
  return db
    .select({
      id: merchants.id,
      category: merchants.category,
      storeType: merchants.storeType,
      shopName: merchants.shopName,
      dailyPublishTarget: merchants.dailyPublishTarget,
    })
    .from(merchants)
    .where(eq(merchants.publishReminderEnabled, true));
}
