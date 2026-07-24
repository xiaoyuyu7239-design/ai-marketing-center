import { describe, expect, it } from "vitest";
import {
  CALIBRATION_MIN_SAMPLES,
  calibrateWindows,
  formatWindow,
  goldenTimeHint,
  publishWindows,
  resolveWindows,
  windowKey,
  type PublishSample,
} from "@backend/core/publish/golden-time";

const at = (hour: number, minute = 0) => new Date(2026, 6, 10, hour, minute);

describe("golden-time 黄金发布时间", () => {
  it("每个品类都有时段表，未知品类回退 other", () => {
    for (const category of ["beauty", "food", "home", "fashion", "tech", "other"]) {
      expect(publishWindows(category).length).toBeGreaterThan(0);
    }
    expect(publishWindows("unknown-xyz")).toEqual(publishWindows("other"));
    expect(publishWindows(null)).toEqual(publishWindows("other"));
  });

  it("时段格式化为 HH:MM-HH:MM", () => {
    expect(formatWindow({ startMinute: 19 * 60, endMinute: 21 * 60 + 30 })).toBe("19:00-21:30");
  });

  it("高峰时段内提示马上发布", () => {
    const hint = goldenTimeHint("beauty", at(20, 30));
    expect(hint.inWindow).toBe(true);
    expect(hint.hint).toContain("适合马上发布");
  });

  it("时段之外指向今天下一个时段", () => {
    const hint = goldenTimeHint("beauty", at(15, 0));
    expect(hint.inWindow).toBe(false);
    expect(hint.hint).toContain("今天");
    expect(formatWindow(hint.window)).toBe("19:00-22:00");
  });

  it("过了当天最后一个时段则指向明天第一个时段", () => {
    const hint = goldenTimeHint("beauty", at(23, 0));
    expect(hint.inWindow).toBe(false);
    expect(hint.hint).toContain("明天");
    expect(formatWindow(hint.window)).toBe("12:00-13:30");
  });

  it("时段边界：开始分钟在窗内，结束分钟不在", () => {
    expect(goldenTimeHint("beauty", at(19, 0)).inWindow).toBe(true);
    expect(goldenTimeHint("beauty", at(22, 0)).inWindow).toBe(false);
  });
});

describe("本地门店时段（localStore）", () => {
  it("本地餐饮用饭点前窗口（10:30 起），电商餐饮保持 11:00 起", () => {
    expect(formatWindow(publishWindows("food", { localStore: true })[0])).toBe("10:30-12:00");
    expect(formatWindow(publishWindows("food")[0])).toBe("11:00-13:00");
  });

  it("本地餐饮有夜宵窗口（21:30-23:00）", () => {
    const windows = publishWindows("food", { localStore: true });
    expect(windows.some((w) => formatWindow(w) === "21:30-23:00")).toBe(true);
  });

  it("本地餐饮提示语锚在'到店决策时刻'（饭点/吃什么）", () => {
    const inWindow = goldenTimeHint("food", at(10, 45), { localStore: true });
    expect(inWindow.inWindow).toBe(true);
    expect(inWindow.hint).toContain("饭点");
    const outWindow = goldenTimeHint("food", at(14, 0), { localStore: true });
    expect(outWindow.inWindow).toBe(false);
    expect(outWindow.hint).toContain("吃什么");
  });

  it("没有本地时段表的品类回退通用表；非本地商家完全不受影响", () => {
    expect(publishWindows("home", { localStore: true })).toEqual(publishWindows("home"));
    expect(goldenTimeHint("beauty", at(20, 30), { localStore: false }).hint).toContain("适合马上发布");
  });
});

describe("时段校准（按商家自己的回流数据）", () => {
  const sample = (hour: number, engagement: number): PublishSample => ({ minuteOfDay: hour * 60 + 15, engagement });

  it("样本不足最低条数时返回 null（回退行业模板）", () => {
    const samples = Array.from({ length: CALIBRATION_MIN_SAMPLES - 1 }, () => sample(19, 1000));
    expect(calibrateWindows(samples)).toBeNull();
  });

  it("样本集中在晚间高播放时，校准出晚间时段", () => {
    const samples = [
      ...Array.from({ length: 6 }, () => sample(19, 5000)),
      ...Array.from({ length: 4 }, () => sample(20, 4000)),
      ...Array.from({ length: 3 }, () => sample(9, 30)), // 早上发过但没人看
    ];
    const result = calibrateWindows(samples);
    expect(result).not.toBeNull();
    expect(result!.source).toBe("calibrated");
    // 相邻的 19、20 点合并成一个连续时段
    expect(result!.windows.some((w) => w.startMinute <= 19 * 60 && w.endMinute >= 21 * 60)).toBe(true);
    // 低效果的早上 9 点不该入选
    expect(result!.windows.every((w) => w.startMinute >= 10 * 60)).toBe(true);
    expect(result!.basis).toContain("你家");
  });

  it("全是零播放的样本没有信号，返回 null", () => {
    const samples = Array.from({ length: 10 }, () => sample(19, 0));
    expect(calibrateWindows(samples)).toBeNull();
  });

  it("非法样本（分钟越界/负播放）被过滤，不影响其余样本", () => {
    const samples = [
      ...Array.from({ length: 9 }, () => sample(12, 2000)),
      { minuteOfDay: -5, engagement: 100 },
      { minuteOfDay: 25 * 60, engagement: 100 },
      { minuteOfDay: 600, engagement: -1 },
    ];
    const result = calibrateWindows(samples);
    expect(result).not.toBeNull();
    expect(result!.sampleCount).toBe(9);
  });

  it("resolveWindows：够样本用校准，不够回退行业模板并给大白话依据", () => {
    const enough = Array.from({ length: 10 }, () => sample(19, 3000));
    expect(resolveWindows("beauty", { samples: enough }).source).toBe("calibrated");
    const fallback = resolveWindows("beauty", { samples: [] });
    expect(fallback.source).toBe("category");
    expect(fallback.windows).toEqual(publishWindows("beauty"));
    expect(fallback.basis).toContain("同行业");
    const localFallback = resolveWindows("food", { localStore: true, samples: [] });
    expect(localFallback.windows).toEqual(publishWindows("food", { localStore: true }));
    expect(localFallback.basis).toContain("实体店");
  });

  it("校准出的时段可注入 goldenTimeHint 驱动提示语", () => {
    const windows = [{ startMinute: 15 * 60, endMinute: 16 * 60 }];
    const hint = goldenTimeHint("beauty", at(15, 30), { windows });
    expect(hint.inWindow).toBe(true);
  });

  it("windowKey 生成去重键", () => {
    expect(windowKey({ startMinute: 1140, endMinute: 1320 })).toBe("1140-1320");
  });
});
