/**
 * 效果回流：把「发布后人工录入的各条数据」聚合成洞察反哺生成——
 * 既能看「哪种脚本风格更能卖」(按 style)，也能看「哪个钩子机制更能卖」(按 hookId，配合钩子 A/B)。
 * 带货最关心转化（成交/播放），其次互动（赞评转/播放）。纯函数、可单测；DB/UI 在外层。
 */

/** 单条投放数据（DB 行的最小子集，聚合只需这些） */
export interface MetricInput {
  /** 脚本风格 key（pain_point/scene/comparison/story/custom），录入时定格 */
  style: string;
  /** 钩子机制 id（= HookPattern.id），录入时定格；钩子 A/B 回流用，可空 */
  hookId?: string;
  views: number;
  likes?: number;
  comments?: number;
  shares?: number;
  /** 成交单数 */
  orders?: number;
}

interface GroupStats {
  /** 样本数（发了几条） */
  samples: number;
  avgViews: number;
  /** 互动率 (赞+评+转)/播放，0..1 */
  engagementRate: number;
  /** 转化率 成交/播放，0..1 */
  conversionRate: number;
  totalOrders: number;
}

export interface StyleInsight extends GroupStats {
  style: string;
}

export interface HookInsight extends GroupStats {
  hookId: string;
}

const sum = (rs: MetricInput[], f: (r: MetricInput) => number) => rs.reduce((a, r) => a + (f(r) || 0), 0);

/** 按某 key 分组聚合，转化率降序（带货优先「能不能卖」）、并列按样本数；key 为空的记录跳过 */
function aggregateBy(
  records: MetricInput[],
  getKey: (r: MetricInput) => string | undefined
): Array<GroupStats & { key: string }> {
  const groups = new Map<string, MetricInput[]>();
  for (const r of records) {
    const k = getKey(r);
    if (!k) continue;
    const g = groups.get(k);
    if (g) g.push(r);
    else groups.set(k, [r]);
  }
  const out: Array<GroupStats & { key: string }> = [];
  for (const [key, rs] of groups) {
    const samples = rs.length;
    const totalViews = sum(rs, (r) => r.views);
    const totalEng = sum(rs, (r) => (r.likes || 0) + (r.comments || 0) + (r.shares || 0));
    const totalOrders = sum(rs, (r) => r.orders || 0);
    out.push({
      key,
      samples,
      avgViews: Math.round(totalViews / samples),
      engagementRate: totalViews > 0 ? totalEng / totalViews : 0,
      conversionRate: totalViews > 0 ? totalOrders / totalViews : 0,
      totalOrders,
    });
  }
  return out.sort((a, b) => b.conversionRate - a.conversionRate || b.samples - a.samples);
}

/** 按脚本风格聚合 */
export function aggregateByStyle(records: MetricInput[]): StyleInsight[] {
  return aggregateBy(records, (r) => r.style).map(({ key, ...rest }) => ({ style: key, ...rest }));
}

/** 按钩子机制聚合（钩子 A/B：哪个机制更能卖）；无 hookId 的记录不计入 */
export function aggregateByHook(records: MetricInput[]): HookInsight[] {
  return aggregateBy(records, (r) => r.hookId).map(({ key, ...rest }) => ({ hookId: key, ...rest }));
}

/** 推荐「最能卖」的风格：需达最小样本数（默认 2，避免单条偶然）且转化率 > 0；不足返回 null 不给误导 */
export function topConvertingStyle(records: MetricInput[], minSamples = 2): StyleInsight | null {
  const ranked = aggregateByStyle(records).filter((i) => i.samples >= minSamples && i.conversionRate > 0);
  return ranked[0] ?? null;
}

/** 推荐「最能卖」的钩子机制（同样要够样本、转化 > 0） */
export function topConvertingHook(records: MetricInput[], minSamples = 2): HookInsight | null {
  const ranked = aggregateByHook(records).filter((i) => i.samples >= minSamples && i.conversionRate > 0);
  return ranked[0] ?? null;
}

/** 可选标签解析器，让回流提示用可读名称而不是 raw key。 */
export interface PerformanceHintLabels {
  /** style key → 展示名（如 pain_point → 痛点种草） */
  styleLabel?: (style: string) => string;
  /** hookId → 展示名（如 visual_shock → 视觉冲击） */
  hookLabel?: (hookId: string) => string;
}

/**
 * 数据飞轮的最后一公里：把历史转化最高的风格/钩子写成可注入 LLM 的生成指令。
 * 冷启动或样本不足时返回空串，调用方无需注入。
 */
export function buildPerformanceHint(
  topStyle: StyleInsight | null,
  topHook: HookInsight | null,
  labels: PerformanceHintLabels = {}
): string {
  const styleLabel = labels.styleLabel ?? ((style: string) => style);
  const hookLabel = labels.hookLabel ?? ((hookId: string) => hookId);
  const asPct = (rate: number) => Math.round(rate * 1000) / 10;
  const lines: string[] = [];

  if (topStyle) {
    lines.push(
      `- 转化最高的脚本风格是「${styleLabel(topStyle.style)}」（近 ${topStyle.samples} 条实测，转化率约 ${asPct(topStyle.conversionRate)}%）——本次优先采用或明显倾斜该风格。`
    );
  }

  if (topHook) {
    lines.push(
      `- 转化最高的开场钩子机制是「${hookLabel(topHook.hookId)}」（近 ${topHook.samples} 条实测，转化率约 ${asPct(topHook.conversionRate)}%）——开场三秒优先采用该机制。`
    );
  }

  if (!lines.length) return "";
  return `【历史转化数据反馈（来自你已发布视频的真实成效，务必参考）】\n${lines.join("\n")}`;
}
