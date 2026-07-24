/**
 * 黄金发布时间 —— 按品类给出目标受众高活跃的发布时段建议（纯函数、可单测）。
 *
 * 立项方案里"黄金时间提醒"的时段判定核心：先用行业常识性的静态时段表起步，
 * 后续有真实效果回流数据后可按商家自己的数据校准。时间一律用本地时钟的"当日分钟数"表示。
 * 提醒触达渠道（微信通知/短信/浏览器推送）尚未选型，本模块只负责"何时该发"，不负责"怎么通知"。
 */

export interface PublishWindow {
  /** 开始，当日分钟数（如 19:00 → 1140） */
  startMinute: number;
  /** 结束，当日分钟数（不含） */
  endMinute: number;
}

export interface GoldenTimeHint {
  /** 现在是否在高峰时段内 */
  inWindow: boolean;
  /** 命中的/下一个时段（跨天则是明天第一个时段） */
  window: PublishWindow;
  /** 面向老板的口语化建议文案 */
  hint: string;
}

const H = (hour: number, minute = 0) => hour * 60 + minute;

/** 各品类目标受众的高活跃时段（午休 + 晚间两段为主，按品类微调） */
const CATEGORY_WINDOWS: Record<string, PublishWindow[]> = {
  beauty: [
    { startMinute: H(12), endMinute: H(13, 30) },
    { startMinute: H(19), endMinute: H(22) },
  ],
  food: [
    { startMinute: H(11), endMinute: H(13) },
    { startMinute: H(17), endMinute: H(19, 30) },
  ],
  home: [
    { startMinute: H(12), endMinute: H(14) },
    { startMinute: H(20), endMinute: H(22) },
  ],
  fashion: [
    { startMinute: H(12), endMinute: H(13, 30) },
    { startMinute: H(19), endMinute: H(21, 30) },
  ],
  tech: [
    { startMinute: H(12), endMinute: H(13) },
    { startMinute: H(20), endMinute: H(22, 30) },
  ],
  other: [
    { startMinute: H(12), endMinute: H(13, 30) },
    { startMinute: H(19), endMinute: H(21, 30) },
  ],
};

/**
 * 本地门店的高峰时段（与电商"刷视频高峰"不同，锚在"到店决策时刻"）：
 * 餐饮=饭点前（午餐前 11 点、晚餐前 17-19、夜宵 22-23，多源交叉一致的服务商共识）；
 * 美业=午休+晚间预约决策时段；其余品类沿用通用表。
 */
const LOCAL_CATEGORY_WINDOWS: Record<string, PublishWindow[]> = {
  food: [
    { startMinute: H(10, 30), endMinute: H(12) },
    { startMinute: H(17), endMinute: H(19) },
    { startMinute: H(21, 30), endMinute: H(23) },
  ],
  beauty: [
    { startMinute: H(12), endMinute: H(13, 30) },
    { startMinute: H(19), endMinute: H(21, 30) },
  ],
};

export function publishWindows(
  category: string | null | undefined,
  options: { localStore?: boolean } = {}
): PublishWindow[] {
  const key = String(category ?? "").toLowerCase();
  if (options.localStore && LOCAL_CATEGORY_WINDOWS[key]) return LOCAL_CATEGORY_WINDOWS[key];
  return CATEGORY_WINDOWS[key] ?? CATEGORY_WINDOWS.other;
}

export function formatWindow(window: PublishWindow): string {
  const fmt = (minute: number) => `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
  return `${fmt(window.startMinute)}-${fmt(window.endMinute)}`;
}

/**
 * 给定当前时间，返回"现在是否高峰 + 建议文案"；now 必传（保持纯函数，调用方注入时钟）。
 * options.localStore=true 时用本地门店时段表（餐饮=饭点前，锚在"到店决策时刻"）。
 * options.windows 可注入按商家真实数据校准出的时段（见 calibrateWindows），不传则用静态行业表。
 */
export function goldenTimeHint(
  category: string | null | undefined,
  now: Date,
  options: { localStore?: boolean; windows?: PublishWindow[] } = {}
): GoldenTimeHint {
  const windows = options.windows?.length ? options.windows : publishWindows(category, options);
  const minute = now.getHours() * 60 + now.getMinutes();
  const isLocalFood = Boolean(options.localStore) && String(category ?? "").toLowerCase() === "food";

  const current = windows.find((w) => minute >= w.startMinute && minute < w.endMinute);
  if (current) {
    return {
      inWindow: true,
      window: current,
      hint: isLocalFood
        ? `现在正是饭点前的决策时段（${formatWindow(current)}），马上发，接住正在想"吃什么"的同城人。`
        : `现在正是高峰时段（${formatWindow(current)}），适合马上发布，别让客人刷到别人家。`,
    };
  }

  const next = windows.find((w) => w.startMinute > minute) ?? windows[0];
  const dayNote = next.startMinute > minute ? "今天" : "明天";
  return {
    inWindow: false,
    window: next,
    hint: isLocalFood
      ? `建议${dayNote} ${formatWindow(next)} 饭点前发布，那会儿同城人正在决定"吃什么"。`
      : `建议${dayNote} ${formatWindow(next)} 高峰时段发布，那会儿刷视频的人最多。`,
  };
}

// ===== 按商家真实回流数据校准时段（数据飞轮：行业模板起步 → 自家数据越用越准）=====

/** 一条发布效果样本：什么时刻发的 + 效果如何（来自 publish_metrics 回流） */
export interface PublishSample {
  /** 发布时刻，当日分钟数 */
  minuteOfDay: number;
  /** 效果值（用播放量即可），仅做时段间相对比较，不看绝对值 */
  engagement: number;
}

export interface ResolvedWindows {
  windows: PublishWindow[];
  /** calibrated=按这家店自己的数据；category=行业经验模板 */
  source: "calibrated" | "category";
  /** 大白话依据，直接可展示给商家（如"按你家最近 12 条视频的实际效果"） */
  basis: string;
  sampleCount: number;
}

/** 样本至少要这么多条才敢用商家自己的数据说话，否则回退行业模板 */
export const CALIBRATION_MIN_SAMPLES = 8;
/** 校准最多产出的时段数（提醒一天最多推这么多次，防打扰） */
const MAX_CALIBRATED_WINDOWS = 3;

/**
 * 按商家自己的回流数据算"哪些钟点发布效果好"。纯函数、可单测。
 *
 * 算法（刻意保持简单可解释）：按发布钟点分桶，每桶得分 = Σ log10(1+播放量)
 * （对数压掉爆款离群值，同时天然带上"这个点位商家常发"的频次权重）；
 * 取得分 ≥ 最高分 60% 的钟点（最多 4 个），相邻钟点合并成连续时段。
 * 样本不足 CALIBRATION_MIN_SAMPLES 时返回 null，调用方回退行业模板。
 */
export function calibrateWindows(samples: PublishSample[]): ResolvedWindows | null {
  const valid = samples.filter(
    (s) => Number.isFinite(s.minuteOfDay) && s.minuteOfDay >= 0 && s.minuteOfDay < 24 * 60 && s.engagement >= 0
  );
  if (valid.length < CALIBRATION_MIN_SAMPLES) return null;

  const hourScores = new Array<number>(24).fill(0);
  for (const s of valid) {
    hourScores[Math.floor(s.minuteOfDay / 60)] += Math.log10(1 + s.engagement);
  }
  const maxScore = Math.max(...hourScores);
  if (maxScore <= 0) return null; // 全是零播放，没有可校准的信号

  const goodHours = hourScores
    .map((score, hour) => ({ hour, score }))
    .filter((h) => h.score >= maxScore * 0.6)
    .sort((a, b) => b.score - a.score)
    .slice(0, 4)
    .map((h) => h.hour)
    .sort((a, b) => a - b);

  // 相邻钟点合并成连续时段（如 19、20 点 → 19:00-21:00）
  const windows: PublishWindow[] = [];
  for (const hour of goodHours) {
    const last = windows[windows.length - 1];
    if (last && last.endMinute === hour * 60) {
      last.endMinute = (hour + 1) * 60;
    } else {
      windows.push({ startMinute: hour * 60, endMinute: (hour + 1) * 60 });
    }
  }

  return {
    windows: windows.slice(0, MAX_CALIBRATED_WINDOWS),
    source: "calibrated",
    basis: `按你家最近 ${valid.length} 条视频的实际效果，这几个点发出去看的人最多`,
    sampleCount: valid.length,
  };
}

/**
 * 时段解析总入口：有足够回流样本 → 用商家自己的数据；不够 → 行业模板兜底。
 * 提醒调度、设置页预览、页面黄金时段提示统一走这里，保证口径一致。
 */
export function resolveWindows(
  category: string | null | undefined,
  options: { localStore?: boolean; samples?: PublishSample[] } = {}
): ResolvedWindows {
  const calibrated = options.samples ? calibrateWindows(options.samples) : null;
  if (calibrated) return calibrated;
  return {
    windows: publishWindows(category, options),
    source: "category",
    basis: options.localStore
      ? "按同类实体店的经验时段（到店决策时刻），等你家数据攒够了会自动换成你自己的"
      : "按同行业的经验时段，等你家数据攒够了会自动换成你自己的",
    sampleCount: options.samples?.length ?? 0,
  };
}

/** 时段去重键（提醒流水 reminder_logs.window_key 用），如 "1140-1320" */
export function windowKey(window: PublishWindow): string {
  return `${window.startMinute}-${window.endMinute}`;
}
