"use client";

import { useCallback, useEffect, useState } from "react";
import { useLocale } from "@frontend/i18n";
import { Button } from "@frontend/components/ui/button";
import { LuCalendarRange, LuLightbulb, LuLoaderCircle, LuTrendingDown, LuTrendingUp } from "react-icons/lu";
import type { WeeklyReportData } from "@backend/core/publish/weekly-report";

interface ReportRow {
  id: string;
  stats: WeeklyReportData | null;
  highlights: string[] | null;
  watchouts: string[] | null;
  nextActions: string[] | null;
  summary: string | null;
  source: "llm" | "rule";
  periodStart: string | null;
  periodEnd: string | null;
  createdAt: string | null;
}

const fmtDay = (iso: string | null, en: boolean) => {
  if (!iso) return "";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "";
  return en ? `${d.getMonth() + 1}/${d.getDate()}` : `${d.getMonth() + 1}月${d.getDate()}日`;
};

/**
 * 账号周报卡片（生成库存页，浅色风格）：一键把近 7 天的数据讲成大白话——
 * 这周发得怎么样、哪种打法最能卖、下周怎么干。
 */
export function WeeklyReport() {
  const locale = useLocale();
  const en = locale === "en";
  const [latest, setLatest] = useState<ReportRow | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const [warning, setWarning] = useState("");

  // 回显最近一份周报，别让老板每次进页面都重跑（周报消耗生成额度）
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch("/api/insights/weekly-report");
        if (!r.ok) return;
        const j = await r.json();
        if (!cancelled && Array.isArray(j.reports) && j.reports[0]) setLatest(j.reports[0]);
      } catch {
        /* 静默：无历史周报即可 */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const run = useCallback(async () => {
    if (running) return;
    setRunning(true);
    setError("");
    setWarning("");
    try {
      const r = await fetch("/api/insights/weekly-report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ locale }),
      });
      const j = await r.json();
      if (!r.ok) {
        setError(j.error || (en ? "Report failed" : "周报生成失败，请稍后重试"));
        return;
      }
      setLatest(j.report);
      if (j.warning) setWarning(j.warning);
    } catch {
      setError(en ? "Report failed" : "周报生成失败，请稍后重试");
    } finally {
      setRunning(false);
    }
  }, [running, locale, en]);

  const stats = latest?.stats ?? null;
  const trend = stats?.viewsTrendPct ?? null;

  return (
    <section className="mt-6 rounded-2xl border border-[#E2E5EA] bg-white p-5 shadow-sm">
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div className="flex items-center gap-2">
          <LuCalendarRange className="size-4 text-[#111111]" />
          <h2 className="text-sm font-black text-[#111111]">{en ? "This week in review" : "本周小结"}</h2>
          {latest && (
            <span className="text-xs font-semibold text-[#8A94A0]">
              {fmtDay(latest.periodStart, en)} – {fmtDay(latest.periodEnd, en)}
            </span>
          )}
          {latest?.source === "rule" && (
            <span className="rounded-full border border-[#DDE2E8] px-2 py-0.5 text-[10px] font-black text-[#596170]">
              {en ? "Local stats" : "本地统计"}
            </span>
          )}
        </div>
        <Button size="sm" className="bg-[#111111] text-white hover:bg-[#2B2B2B]" disabled={running} onClick={run}>
          {running ? <LuLoaderCircle className="size-4 mr-1 animate-spin" /> : null}
          {running ? (en ? "Working…" : "生成中…") : latest ? (en ? "Refresh report" : "更新周报") : en ? "Create report" : "生成本周报告"}
        </Button>
      </div>
      <p className="mt-1 text-xs font-semibold text-[#8A94A0]">
        {en
          ? "Turns the last 7 days of logged numbers into plain talk: what went well, what to watch, what to do next week. Uses 1 generation credit."
          : "把近 7 天回填的数据讲成大白话：这周发得怎么样、要注意什么、下周怎么干。消耗 1 次生成额度。"}
      </p>

      {error && <p className="mt-2 text-xs font-semibold text-[#B42318]">{error}</p>}
      {warning && (
        <p className="mt-2 text-xs font-semibold text-[#B54708]">
          {en ? "AI unavailable, showing local stats: " : "AI 暂不可用，先给你本地统计版："}
          {warning}
        </p>
      )}

      {latest && (
        <div className="mt-4 space-y-3">
          {stats && (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm font-black text-[#111111]">
              <span>{en ? `${stats.thisWeek.entries} logged` : `本周回填 ${stats.thisWeek.entries} 条`}</span>
              <span>{en ? `${stats.thisWeek.views} views` : `总播放 ${stats.thisWeek.views}`}</span>
              {stats.thisWeek.orders > 0 && <span>{en ? `${stats.thisWeek.orders} orders` : `成交 ${stats.thisWeek.orders} 单`}</span>}
              {trend !== null && (
                <span className={`inline-flex items-center gap-1 ${trend >= 0 ? "text-[#067647]" : "text-[#B42318]"}`}>
                  {trend >= 0 ? <LuTrendingUp className="size-3.5" /> : <LuTrendingDown className="size-3.5" />}
                  {en ? `${trend > 0 ? "+" : ""}${trend}% vs last week` : `比上周${trend >= 0 ? "多" : "少"} ${Math.abs(trend)}%`}
                </span>
              )}
            </div>
          )}

          {latest.summary && <p className="text-sm font-semibold text-[#374151]">{latest.summary}</p>}

          <div className="grid gap-3 md:grid-cols-3">
            {Array.isArray(latest.highlights) && latest.highlights.length > 0 && (
              <div className="rounded-xl border border-[#E2E5EA] bg-[#F8FAF9] p-3">
                <p className="text-xs font-black text-[#067647] mb-1">{en ? "What went well" : "这周的亮点"}</p>
                <ul className="space-y-1">
                  {latest.highlights.map((s, i) => (
                    <li key={i} className="text-xs font-semibold text-[#374151]">
                      ✓ {s}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {Array.isArray(latest.watchouts) && latest.watchouts.length > 0 && (
              <div className="rounded-xl border border-[#E2E5EA] bg-[#FFFBF5] p-3">
                <p className="text-xs font-black text-[#B54708] mb-1">{en ? "Watch out" : "要注意的"}</p>
                <ul className="space-y-1">
                  {latest.watchouts.map((s, i) => (
                    <li key={i} className="text-xs font-semibold text-[#374151]">
                      ! {s}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {Array.isArray(latest.nextActions) && latest.nextActions.length > 0 && (
              <div className="rounded-xl border border-[#E2E5EA] bg-[#F7F8FD] p-3">
                <p className="text-xs font-black text-[#3538CD] mb-1 flex items-center gap-1">
                  <LuLightbulb className="size-3.5" />
                  {en ? "Next week" : "下周怎么干"}
                </p>
                <ul className="space-y-1">
                  {latest.nextActions.map((s, i) => (
                    <li key={i} className="text-xs font-semibold text-[#374151]">
                      {i + 1}. {s}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
