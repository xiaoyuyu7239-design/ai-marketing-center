/**
 * 账号周报（数据飞轮第④环）：把最近 7 天的回流数据、风格洞察、各条复盘的"下条试试"
 * 汇总成一份账号级的大白话周报——这周发得怎么样、哪种打法最能卖、下周怎么干。
 * 数字统计与趋势全部由代码算（LLM 只负责把数字讲成人话），窗口口径固定为
 * "生成时刻往前 7 天 vs 再往前 7 天"，同一周多次生成结果口径一致。
 * 本模块保持纯函数、可单测；LLM 调用与 DB 在外层 route。
 */

import type { StyleInsight } from "./performance-insights";

/** 参与周报统计的单条回流数据（DB 行最小子集；窗口划分用录入时间 createdAt） */
export interface WeeklyMetricRow {
  views: number;
  likes: number;
  comments: number;
  shares: number;
  orders: number;
  createdAt: Date | null;
  style: string;
}

/** 单个 7 天窗口的汇总 */
export interface WeeklyWindowStats {
  /** 回填条数 */
  entries: number;
  views: number;
  likes: number;
  comments: number;
  shares: number;
  orders: number;
  /** 窗口内单条最高播放 */
  bestViews: number;
}

/** 周报的数字底料（代码算好，LLM 与规则兜底共用） */
export interface WeeklyReportData {
  thisWeek: WeeklyWindowStats;
  lastWeek: WeeklyWindowStats;
  /** 播放较上周变化百分比（四舍五入整数）；上周没数据为 null，别除零硬编趋势 */
  viewsTrendPct: number | null;
  /** 最能卖的风格（样本/转化达标才有，口径同 topConvertingStyle） */
  topStyle: StyleInsight | null;
  /** 近期复盘沉淀的"下条试试"（去重后最多 4 条） */
  retroNotes: string[];
}

/** 周报正文（LLM/规则产出） */
export interface ParsedWeeklyReport {
  /** 这周的亮点（≤3 条） */
  highlights: string[];
  /** 要注意的（≤3 条） */
  watchouts: string[];
  /** 下周怎么干（≤3 条） */
  nextActions: string[];
  /** 一句话总结 */
  summary: string;
}

const WEEK_MS = 7 * 86_400_000;

const cleanText = (v: unknown, maxLen: number) => (typeof v === "string" ? v.trim().slice(0, maxLen) : "");
const cleanList = (v: unknown, maxItems: number, maxLen: number) =>
  Array.isArray(v) ? v.map((item) => cleanText(item, maxLen)).filter(Boolean).slice(0, maxItems) : [];

function emptyWindow(): WeeklyWindowStats {
  return { entries: 0, views: 0, likes: 0, comments: 0, shares: 0, orders: 0, bestViews: 0 };
}

function addRow(win: WeeklyWindowStats, row: WeeklyMetricRow) {
  win.entries += 1;
  win.views += row.views;
  win.likes += row.likes;
  win.comments += row.comments;
  win.shares += row.shares;
  win.orders += row.orders;
  win.bestViews = Math.max(win.bestViews, row.views);
}

/** 按"now 往前 7 天 / 再往前 7 天"两个窗口汇总回流数据，并算播放趋势 */
export function collectWeeklyWindows(rows: WeeklyMetricRow[], now: Date): Pick<WeeklyReportData, "thisWeek" | "lastWeek" | "viewsTrendPct"> {
  const end = now.getTime();
  const thisWeek = emptyWindow();
  const lastWeek = emptyWindow();
  for (const row of rows) {
    const at = row.createdAt?.getTime();
    if (at === undefined || !Number.isFinite(at)) continue;
    if (at > end - WEEK_MS && at <= end) addRow(thisWeek, row);
    else if (at > end - 2 * WEEK_MS && at <= end - WEEK_MS) addRow(lastWeek, row);
  }
  const viewsTrendPct = lastWeek.views > 0 ? Math.round(((thisWeek.views - lastWeek.views) / lastWeek.views) * 100) : null;
  return { thisWeek, lastWeek, viewsTrendPct };
}

/** style key → 展示名（route 传 styleNameMap，核心模块不绑定文案表） */
export type StyleLabelFn = (style: string) => string;

const trendText = (pct: number | null, locale: "zh" | "en") => {
  if (pct === null) return locale === "en" ? "no last-week data to compare" : "上周没数据，暂无对比";
  if (pct > 0) return locale === "en" ? `up ${pct}% vs last week` : `比上周多 ${pct}%`;
  if (pct < 0) return locale === "en" ? `down ${Math.abs(pct)}% vs last week` : `比上周少 ${Math.abs(pct)}%`;
  return locale === "en" ? "flat vs last week" : "和上周持平";
};

/** 构建周报的 user prompt：把算好的数字底料端给 LLM，让它只做"讲成人话" */
export function buildWeeklyReportPrompt(data: WeeklyReportData, locale: "zh" | "en", styleLabel: StyleLabelFn = (s) => s): string {
  const { thisWeek, lastWeek, topStyle } = data;
  const lines = [
    locale === "en"
      ? "Write this merchant's weekly short-video report in English based on the numbers below."
      : "根据下面算好的数字，为店主写一份本周短视频周报，用中文输出。",
    `本周（近7天）：回填 ${thisWeek.entries} 条，播放 ${thisWeek.views}，点赞 ${thisWeek.likes}，评论 ${thisWeek.comments}，转发 ${thisWeek.shares}，成交 ${thisWeek.orders}，单条最高播放 ${thisWeek.bestViews}`,
    `上周（再前7天）：回填 ${lastWeek.entries} 条，播放 ${lastWeek.views}，成交 ${lastWeek.orders}`,
    `播放趋势：${trendText(data.viewsTrendPct, "zh")}`,
    topStyle
      ? `最能卖的风格：「${styleLabel(topStyle.style)}」（${topStyle.samples} 条实测，转化率约 ${Math.round(topStyle.conversionRate * 1000) / 10}%）`
      : "最能卖的风格：数据还不够，看不出来",
    data.retroNotes.length ? `近期复盘沉淀的经验：${data.retroNotes.join("；")}` : "近期复盘沉淀的经验：暂无",
  ];
  return lines.join("\n");
}

/** 解析 LLM 周报 JSON：各列表限 3 条、每条 60 字；全空返回 null 走规则兜底 */
export function parseWeeklyReportResponse(raw: unknown): ParsedWeeklyReport | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const result: ParsedWeeklyReport = {
    highlights: cleanList(value.highlights, 3, 60),
    watchouts: cleanList(value.watchouts, 3, 60),
    nextActions: cleanList(value.nextActions, 3, 60),
    summary: cleanText(value.summary, 120),
  };
  if (!result.summary && !result.highlights.length && !result.watchouts.length && !result.nextActions.length) return null;
  return result;
}

/**
 * 规则兜底周报：LLM 不可用时，把算好的数字直接拼成大白话。
 * 只说数据里立得住的话，不装懂内容层面的好坏。
 */
export function buildRuleWeeklyReport(data: WeeklyReportData, locale: "zh" | "en", styleLabel: StyleLabelFn = (s) => s): ParsedWeeklyReport {
  const { thisWeek, topStyle } = data;
  const en = locale === "en";

  const highlights: string[] = [];
  if (thisWeek.bestViews > 0)
    highlights.push(en ? `Best video this week: ${thisWeek.bestViews} views` : `本周最好的一条播放 ${thisWeek.bestViews}`);
  if (topStyle)
    highlights.push(
      en
        ? `"${styleLabel(topStyle.style)}" videos sell best (${topStyle.samples} logged)`
        : `「${styleLabel(topStyle.style)}」的视频最能卖（${topStyle.samples} 条实测）`
    );
  if (thisWeek.orders > 0) highlights.push(en ? `${thisWeek.orders} order(s) this week` : `本周带来 ${thisWeek.orders} 单成交`);

  const watchouts: string[] = [];
  if (thisWeek.entries < 3)
    watchouts.push(en ? "Too few videos logged this week — log more so the numbers mean something" : "这周回填的数据还少，多发多填，分析才准");
  if (data.viewsTrendPct !== null && data.viewsTrendPct < -20)
    watchouts.push(en ? "Views dropped noticeably vs last week" : "播放比上周掉了不少，下周留意");

  const nextActions = data.retroNotes.length
    ? data.retroNotes.slice(0, 3)
    : [en ? "Keep publishing daily and logging the numbers" : "保持每天发视频、发完回来填数据"];

  return {
    highlights: highlights.slice(0, 3),
    watchouts: watchouts.slice(0, 3),
    nextActions,
    summary: en
      ? `This week: ${thisWeek.entries} video(s) logged, ${thisWeek.views} total views (${trendText(data.viewsTrendPct, "en")}).`
      : `这周回填 ${thisWeek.entries} 条数据，总播放 ${thisWeek.views}，${trendText(data.viewsTrendPct, "zh")}。`,
  };
}
