import "server-only";

import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "@backend/db";
import { reminderLogs, wechatBindings } from "@backend/db/schema";
import { formatWindow, windowKey, type PublishWindow } from "@backend/core/publish/golden-time";
import {
  getMerchantWindows,
  getPublishInventory,
  listReminderEnabledMerchants,
  localDateKey,
  type PublishInventorySnapshot,
} from "@backend/core/publish/reminder-context";
import { isWechatConfigured, sendPublishReminder, type ReminderPush } from "./wechat";

/**
 * 发布提醒核心逻辑 —— 调度器每分钟调一次 runReminderTick：
 * 逐个商家算"现在是不是刚进你家的黄金时段"，是就查库存、组文案、推微信，并落 reminder_logs 流水。
 * 窗口判定/文案拼装拆成纯函数（findDueWindow / composeReminderPush），可脱离数据库单测。
 */

/** 调度 tick 允许错过的分钟数：进程重启/事件循环卡顿会丢几个 tick，窗口开始后这几分钟内补发仍有意义 */
const DEFAULT_TOLERANCE_MINUTES = 5;

/**
 * 当前时刻是否"刚进"某个时段：startMinute 落在 (minuteOfDay - tolerance, minuteOfDay] 才算。
 * 只认"刚开始"而不是"在窗口内"，否则窗口里每分钟都会命中，去重压力全压到流水表上。
 */
export function findDueWindow(
  windows: PublishWindow[],
  minuteOfDay: number,
  toleranceMinutes = DEFAULT_TOLERANCE_MINUTES
): PublishWindow | null {
  return (
    windows.find((w) => w.startMinute > minuteOfDay - toleranceMinutes && w.startMinute <= minuteOfDay) ?? null
  );
}

export interface ComposeReminderInput {
  /** 命中的时段（取 endMinute 组"现在到几点前"的说法） */
  window: PublishWindow;
  /** 时段展示文本，如 "19:00-21:30"（formatWindow 产出） */
  windowLabel: string;
  /** 时段依据的大白话（ResolvedWindows.basis），让老板知道"为什么是现在" */
  basis: string;
  inventory: PublishInventorySnapshot;
  /** 日期展示文本，如 "07-12" */
  dateLabel: string;
}

const minuteLabel = (minute: number) =>
  `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;

/**
 * 拼提醒文案（纯函数）。受众是店老板，全部大白话：
 * 库里有货 → 催发（还差几条、有几条可发、推荐先发哪条）；库里空了 → 催补货，别浪费好时段。
 */
export function composeReminderPush(input: ComposeReminderInput): ReminderPush {
  const { window, windowLabel, basis, inventory, dateLabel } = input;
  const endLabel = minuteLabel(window.endMinute);
  const date = `${dateLabel} ${windowLabel}`;

  if (inventory.approvedUnpublished <= 0) {
    return {
      title: "库里没视频可发了",
      body: `现在到 ${endLabel} 前是你家客人最活跃的点（${basis}），但库里没有能发的视频了。抽空去批量生成几条补上，别浪费好时段。`,
      date,
      remark: "点开去补几条视频",
    };
  }

  const top = inventory.topCandidates[0];
  const recommend = top ? `，推荐先发《${top.name}》` : "";
  return {
    title: "该发视频啦",
    body: `现在到 ${endLabel} 前是你家客人最活跃的点（${basis}）。今天还差 ${inventory.remainingToday} 条，库里有 ${inventory.approvedUnpublished} 条可以发${recommend}。`,
    date,
    remark: "点开挑一条发出去",
  };
}

export interface ReminderTickStats {
  /** 实际检查了的商家数（开了提醒且绑了微信） */
  checked: number;
  /** 至少推成功一个微信的商家数 */
  sent: number;
  /** 全部推送失败（或处理中抛错）的商家数 */
  failed: number;
  /** 命中时段但没推的商家数（同窗口已提醒过 / 今天目标已完成） */
  skipped: number;
}

/**
 * 一轮提醒检查（调度器每分钟调一次）。now 可注入，测试用固定时钟。
 * 每个商家单独 try/catch，一家的数据问题不拖垮整轮；统计值返回给调度器打日志。
 */
export async function runReminderTick(now = new Date()): Promise<ReminderTickStats> {
  const stats: ReminderTickStats = { checked: 0, sent: 0, failed: 0, skipped: 0 };
  if (!isWechatConfigured()) return stats;

  const enabledMerchants = await listReminderEnabledMerchants();
  if (enabledMerchants.length === 0) return stats;

  const db = getDb();
  // 绑定关系一次查完按商家分组，避免商家多时每家一次查询
  const bindingRows = await db
    .select({ merchantId: wechatBindings.merchantId, openId: wechatBindings.openId })
    .from(wechatBindings)
    .where(inArray(wechatBindings.merchantId, enabledMerchants.map((m) => m.id)));
  const openIdsByMerchant = new Map<string, string[]>();
  for (const row of bindingRows) {
    const list = openIdsByMerchant.get(row.merchantId);
    if (list) list.push(row.openId);
    else openIdsByMerchant.set(row.merchantId, [row.openId]);
  }

  const minuteOfDay = now.getHours() * 60 + now.getMinutes();
  const planDate = localDateKey(now);

  for (const merchant of enabledMerchants) {
    const openIds = openIdsByMerchant.get(merchant.id);
    if (!openIds?.length) continue; // 开了提醒但没绑微信，推不出去，设置页会引导绑定
    stats.checked += 1;

    try {
      const resolved = await getMerchantWindows(merchant);
      const due = findDueWindow(resolved.windows, minuteOfDay);
      if (!due) continue; // 现在不是这家店的时段开头，下个 tick 再看

      // 去重：同商家同天同时段只提醒一次（流水表即去重依据，不重复写）
      const key = windowKey(due);
      const existing = await db
        .select({ id: reminderLogs.id })
        .from(reminderLogs)
        .where(
          and(
            eq(reminderLogs.merchantId, merchant.id),
            eq(reminderLogs.planDate, planDate),
            eq(reminderLogs.windowKey, key)
          )
        )
        .limit(1);
      if (existing.length > 0) {
        stats.skipped += 1;
        continue;
      }

      const inventory = await getPublishInventory(merchant, now);
      if (inventory.remainingToday <= 0) {
        // 今天的量已经发够了就别打扰，但要留痕，排查"为什么没收到提醒"时有据可查
        await db.insert(reminderLogs).values({
          merchantId: merchant.id,
          planDate,
          windowKey: key,
          status: "skipped",
          detail: "今天目标已完成",
        });
        stats.skipped += 1;
        continue;
      }

      const push = composeReminderPush({
        window: due,
        windowLabel: formatWindow(due),
        basis: resolved.basis,
        inventory,
        dateLabel: planDate.slice(5), // "YYYY-MM-DD" → "MM-DD"
      });

      // 老板+店员可能绑了多个微信，全都推；有一个到就算这轮提醒送达
      const errors: string[] = [];
      let anyOk = false;
      for (const openId of openIds) {
        const result = await sendPublishReminder(openId, push);
        if (result.ok) anyOk = true;
        else errors.push(result.error ?? "发送失败");
      }

      // 每商家每窗口只落一条流水：成功存文案摘要，失败存错误原因
      if (anyOk) {
        await db.insert(reminderLogs).values({
          merchantId: merchant.id,
          planDate,
          windowKey: key,
          status: "sent",
          detail: push.body.slice(0, 200),
        });
        stats.sent += 1;
      } else {
        await db.insert(reminderLogs).values({
          merchantId: merchant.id,
          planDate,
          windowKey: key,
          status: "failed",
          detail: errors.join("；").slice(0, 500),
        });
        stats.failed += 1;
      }
    } catch (err) {
      // 单个商家出错（数据异常等）不影响别家，只记日志计入 failed
      console.error(`[发布提醒] 处理商家 ${merchant.id} 出错（不影响其他商家）:`, err);
      stats.failed += 1;
    }
  }

  return stats;
}
