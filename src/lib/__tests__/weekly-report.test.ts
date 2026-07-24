import { describe, expect, it } from "vitest";
import {
  buildRuleWeeklyReport,
  buildWeeklyReportPrompt,
  collectWeeklyWindows,
  parseWeeklyReportResponse,
  type WeeklyMetricRow,
  type WeeklyReportData,
} from "@backend/core/publish/weekly-report";

const NOW = new Date("2026-07-12T12:00:00Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000);

const row = (partial: Partial<WeeklyMetricRow>): WeeklyMetricRow => ({
  views: 0,
  likes: 0,
  comments: 0,
  shares: 0,
  orders: 0,
  createdAt: daysAgo(1),
  style: "scene",
  ...partial,
});

describe("周报：双周窗口统计与趋势", () => {
  it("近 7 天进本周、7-14 天进上周、更早/无时间的不计", () => {
    const { thisWeek, lastWeek } = collectWeeklyWindows(
      [
        row({ views: 1000, orders: 2, createdAt: daysAgo(1) }),
        row({ views: 500, createdAt: daysAgo(6) }),
        row({ views: 300, createdAt: daysAgo(8) }),
        row({ views: 9999, createdAt: daysAgo(20) }),
        row({ views: 7777, createdAt: null }),
      ],
      NOW
    );
    expect(thisWeek.entries).toBe(2);
    expect(thisWeek.views).toBe(1500);
    expect(thisWeek.orders).toBe(2);
    expect(thisWeek.bestViews).toBe(1000);
    expect(lastWeek.entries).toBe(1);
    expect(lastWeek.views).toBe(300);
  });

  it("趋势 =（本周-上周）/上周；上周没数据不硬编趋势（null）", () => {
    const up = collectWeeklyWindows([row({ views: 1500, createdAt: daysAgo(1) }), row({ views: 1000, createdAt: daysAgo(8) })], NOW);
    expect(up.viewsTrendPct).toBe(50);
    const noBase = collectWeeklyWindows([row({ views: 1500, createdAt: daysAgo(1) })], NOW);
    expect(noBase.viewsTrendPct).toBeNull();
  });
});

describe("周报：LLM 结果解析", () => {
  it("列表限 3 条、超长截断；全空返回 null", () => {
    const parsed = parseWeeklyReportResponse({
      highlights: ["a", "b", "c", "d"],
      watchouts: ["x".repeat(100)],
      nextActions: [],
      summary: "这周不错",
    });
    expect(parsed!.highlights).toHaveLength(3);
    expect(parsed!.watchouts[0]).toHaveLength(60);
    expect(parseWeeklyReportResponse({ highlights: [], watchouts: [], nextActions: [], summary: "" })).toBeNull();
    expect(parseWeeklyReportResponse(null)).toBeNull();
  });
});

describe("周报：规则兜底（只说数据立得住的话）", () => {
  const base = (over: Partial<WeeklyReportData>): WeeklyReportData => ({
    thisWeek: { entries: 5, views: 8000, likes: 300, comments: 40, shares: 20, orders: 3, bestViews: 3000 },
    lastWeek: { entries: 4, views: 10000, likes: 0, comments: 0, shares: 0, orders: 0, bestViews: 0 },
    viewsTrendPct: -20,
    topStyle: { style: "scene", samples: 3, avgViews: 2000, engagementRate: 0.05, conversionRate: 0.001, totalOrders: 3 },
    retroNotes: ["开头直接上成品图", "结尾报价格"],
    ...over,
  });

  it("总结含条数/播放/趋势，亮点含最高播放与最能卖风格，复盘经验进下周行动", () => {
    const report = buildRuleWeeklyReport(base({}), "zh", (s) => (s === "scene" ? "场景安利" : s));
    expect(report.summary).toContain("5 条");
    expect(report.summary).toContain("8000");
    expect(report.summary).toContain("少 20%");
    expect(report.highlights.join()).toContain("3000");
    expect(report.highlights.join()).toContain("场景安利");
    expect(report.nextActions).toEqual(["开头直接上成品图", "结尾报价格"]);
  });

  it("播放大跌给提醒；数据少提醒多回填；没有复盘经验给保底行动", () => {
    const report = buildRuleWeeklyReport(
      base({ viewsTrendPct: -35, retroNotes: [], thisWeek: { entries: 1, views: 100, likes: 0, comments: 0, shares: 0, orders: 0, bestViews: 100 } }),
      "zh"
    );
    expect(report.watchouts.join()).toContain("多发多填");
    expect(report.watchouts.join()).toContain("掉了不少");
    expect(report.nextActions[0]).toContain("回来填数据");
  });
});

describe("周报：prompt 构建", () => {
  it("把算好的数字端给 LLM：本周/上周/趋势/风格/复盘经验齐全", () => {
    const prompt = buildWeeklyReportPrompt(
      {
        thisWeek: { entries: 5, views: 8000, likes: 300, comments: 40, shares: 20, orders: 3, bestViews: 3000 },
        lastWeek: { entries: 4, views: 10000, likes: 0, comments: 0, shares: 0, orders: 1, bestViews: 0 },
        viewsTrendPct: -20,
        topStyle: { style: "scene", samples: 3, avgViews: 2000, engagementRate: 0.05, conversionRate: 0.002, totalOrders: 3 },
        retroNotes: ["开头直接上成品图"],
      },
      "zh",
      () => "场景安利"
    );
    expect(prompt).toContain("回填 5 条");
    expect(prompt).toContain("比上周少 20%");
    expect(prompt).toContain("场景安利");
    expect(prompt).toContain("开头直接上成品图");
  });
});
