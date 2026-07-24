"use client";

import { useCallback, useEffect, useState } from "react";
import { useLocale } from "@frontend/i18n";
import { Button } from "@frontend/components/ui/button";
import { Card, CardContent } from "@frontend/components/ui/card";
import { Badge } from "@frontend/components/ui/badge";
import { LuClipboardCheck, LuLightbulb, LuLoaderCircle, LuMinus, LuTrendingDown, LuTrendingUp } from "react-icons/lu";

interface RetroRow {
  id: string;
  predicted: "above" | "average" | "below" | null;
  actual: "above" | "average" | "below" | null;
  actualBasis: string | null;
  highlights: string[] | null;
  issues: string[] | null;
  nextActions: string[] | null;
  summary: string | null;
  source: "llm" | "rule";
  createdAt: string | null;
}

const DIRECTION_TEXT: Record<"above" | "average" | "below", { zh: string; en: string }> = {
  above: { zh: "比平时好", en: "better than usual" },
  average: { zh: "和平时差不多", en: "about usual" },
  below: { zh: "比平时弱", en: "weaker than usual" },
};

/**
 * 单条视频复盘卡片：数据回填后一键复盘——这条表现如何、哪里好、哪里差、下条怎么改。
 * "下条试试"会自动记进店铺记忆，下次生成脚本带上（有则改之的闭环就在这）。
 */
export function VideoRetro({ projectId }: { projectId: string }) {
  const locale = useLocale();
  const en = locale === "en";
  const [latest, setLatest] = useState<RetroRow | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const [warning, setWarning] = useState("");

  // 回显最近一次复盘，别让老板每次进页面都重跑（复盘消耗生成额度）
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`/api/project/${projectId}/retro`);
        if (!r.ok) return;
        const j = await r.json();
        if (!cancelled && Array.isArray(j.retros) && j.retros[0]) setLatest(j.retros[0]);
      } catch {
        /* 静默：无历史复盘即可 */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const run = useCallback(async () => {
    if (running) return;
    setRunning(true);
    setError("");
    setWarning("");
    try {
      const r = await fetch(`/api/project/${projectId}/retro`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ locale }),
      });
      const j = await r.json();
      if (!r.ok) {
        setError(j.error || (en ? "Retro failed" : "复盘失败，请稍后重试"));
        return;
      }
      setLatest(j.retro);
      if (j.warning) setWarning(j.warning);
    } catch {
      setError(en ? "Retro failed" : "复盘失败，请稍后重试");
    } finally {
      setRunning(false);
    }
  }, [projectId, running, locale, en]);

  const direction = (d: "above" | "average" | "below") => DIRECTION_TEXT[d][en ? "en" : "zh"];

  const actualView = (row: RetroRow) => {
    if (row.actual === "above")
      return { icon: <LuTrendingUp className="w-3.5 h-3.5" />, tone: "text-emerald-500 border-emerald-500/40", text: en ? "This video did better than your usual" : "这条比你平时的视频表现更好" };
    if (row.actual === "below")
      return { icon: <LuTrendingDown className="w-3.5 h-3.5" />, tone: "text-red-500 border-red-500/40", text: en ? "This video did worse than your usual" : "这条比你平时的视频弱一些" };
    if (row.actual === "average")
      return { icon: <LuMinus className="w-3.5 h-3.5" />, tone: "text-amber-500 border-amber-500/40", text: en ? "About your usual level" : "这条和你平时的视频差不多" };
    return { icon: <LuMinus className="w-3.5 h-3.5" />, tone: "text-muted-foreground border-border", text: en ? "Not enough data to compare yet" : "数据还少，暂时比不出好坏" };
  };

  return (
    <Card className="glass-card">
      <CardContent className="p-5">
        <div className="flex items-center justify-between gap-2 mb-1">
          <div className="flex items-center gap-2">
            <LuClipboardCheck className="w-4 h-4 text-primary" />
            <h3 className="text-sm font-semibold">{en ? "Video retro" : "这条视频的复盘"}</h3>
            {latest?.source === "rule" && (
              <Badge variant="outline" className="text-[10px]">
                {en ? "Local quick take" : "本地快评"}
              </Badge>
            )}
          </div>
          <Button size="sm" className="brand-gradient text-white h-8" disabled={running} onClick={run}>
            {running ? <LuLoaderCircle className="w-4 h-4 mr-1 animate-spin" /> : null}
            {running ? (en ? "Working…" : "复盘中…") : latest ? (en ? "Redo retro" : "重新复盘") : en ? "Run retro" : "一键复盘"}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground mb-3">
          {en
            ? "After logging the numbers above, get a plain-talk retro: what worked, what dragged, what to try next — and the 'try next' tips feed your next script automatically. Uses 1 generation credit."
            : "把上面的数据填好后点一下：这条表现怎么样、哪里好、哪里拖后腿、下条怎么改——「下条试试」会自动记住，下次生成脚本直接带上。消耗 1 次生成额度。"}
        </p>

        {error && <p className="text-xs text-red-500 mb-2">{error}</p>}
        {warning && (
          <p className="text-xs text-amber-500 mb-2">
            {en ? "AI unavailable, showing local quick take: " : "AI 暂不可用，先给你本地快评："}
            {warning}
          </p>
        )}

        {latest && (
          <div className="space-y-3">
            {/* 实际表现 + 预测对照 */}
            <div className="flex flex-wrap items-center gap-2">
              {(() => {
                const a = actualView(latest);
                return (
                  <span className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs ${a.tone}`}>
                    {a.icon}
                    {a.text}
                  </span>
                );
              })()}
              {latest.predicted && latest.actual && (
                <span className="text-xs text-muted-foreground">
                  {en
                    ? `Pre-publish call: ${direction(latest.predicted)} → actual: ${direction(latest.actual)}${latest.predicted === latest.actual ? " — called it!" : " — off this time, the AI learns from it"}`
                    : `发布前预测「${direction(latest.predicted)}」→ 实际「${direction(latest.actual)}」${latest.predicted === latest.actual ? "，蒙对了！" : "，这次没对上，AI 会跟着数据修正"}`}
                </span>
              )}
            </div>
            {latest.actualBasis && <p className="text-[11px] text-muted-foreground">{latest.actualBasis}</p>}

            {latest.summary && <p className="text-xs">{latest.summary}</p>}

            {Array.isArray(latest.highlights) && latest.highlights.length > 0 && (
              <div>
                <p className="text-xs font-medium mb-1 text-emerald-500">{en ? "What worked" : "做对了什么"}</p>
                <ul className="space-y-0.5">
                  {latest.highlights.map((s, i) => (
                    <li key={i} className="text-xs text-muted-foreground">
                      ✓ {s}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {Array.isArray(latest.issues) && latest.issues.length > 0 && (
              <div>
                <p className="text-xs font-medium mb-1 text-red-500">{en ? "What dragged" : "哪里拖了后腿"}</p>
                <ul className="space-y-0.5">
                  {latest.issues.map((s, i) => (
                    <li key={i} className="text-xs text-muted-foreground">
                      ✗ {s}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {Array.isArray(latest.nextActions) && latest.nextActions.length > 0 && (
              <div className="border-t border-border/50 pt-2">
                <p className="text-xs font-medium mb-1 flex items-center gap-1">
                  <LuLightbulb className="w-3.5 h-3.5 text-amber-500" />
                  {en ? "Try next (auto-remembered for your next script)" : "下条试试（已自动记住，下次生成脚本会带上）"}
                </p>
                <ul className="space-y-0.5">
                  {latest.nextActions.map((s, i) => (
                    <li key={i} className="text-xs text-muted-foreground">
                      {i + 1}. {s}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
