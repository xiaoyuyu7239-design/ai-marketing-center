"use client";

import { useCallback, useEffect, useState } from "react";
import { useLocale } from "@frontend/i18n";
import { Button } from "@frontend/components/ui/button";
import { Card, CardContent } from "@frontend/components/ui/card";
import { Badge } from "@frontend/components/ui/badge";
import { LuLoaderCircle, LuMinus, LuStethoscope, LuTrendingDown, LuTrendingUp } from "react-icons/lu";
import {
  DIAGNOSIS_DIMENSION_LABELS,
  type DiagnosisDimensionKey,
} from "@backend/core/publish/content-diagnosis";
import type { DiagnosisDimension } from "@backend/db/schema";

interface DiagnosisRow {
  id: string;
  overallScore: number;
  dimensions: DiagnosisDimension[] | null;
  summary: string | null;
  suggestions: string[] | null;
  prediction: "above" | "average" | "below" | null;
  predictionConfidence: "low" | "medium" | "high" | null;
  predictionBasis: string | null;
  source: "llm" | "rule";
  createdAt: string | null;
}

const scoreTone = (score: number) =>
  score >= 75 ? "text-emerald-500" : score >= 55 ? "text-amber-500" : "text-red-500";
const barTone = (score: number) =>
  score >= 75 ? "bg-emerald-500" : score >= 55 ? "bg-amber-500" : "bg-red-500";

/**
 * 发布前诊断卡片：多维内容诊断分 + 相对表现预测。
 * 预测只做"高于/持平/低于账号平均"的方向判断并展示依据——刻意不显示预测播放量数字。
 */
export function PrePublishDiagnosis({ projectId }: { projectId: string }) {
  const locale = useLocale();
  const en = locale === "en";
  const [latest, setLatest] = useState<DiagnosisRow | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const [warning, setWarning] = useState("");

  // 回显最近一次诊断，避免老板每次进页面都重跑一遍（诊断消耗生成额度）
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`/api/project/${projectId}/diagnose`);
        if (!r.ok) return;
        const j = await r.json();
        if (!cancelled && Array.isArray(j.diagnoses) && j.diagnoses[0]) setLatest(j.diagnoses[0]);
      } catch {
        /* 静默：无历史诊断即可 */
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
      const r = await fetch(`/api/project/${projectId}/diagnose`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ platform: "douyin", locale }),
      });
      const j = await r.json();
      if (!r.ok) {
        setError(j.error || (en ? "Diagnosis failed" : "诊断失败，请稍后重试"));
        return;
      }
      setLatest(j.diagnosis);
      if (j.warning) setWarning(j.warning);
    } catch {
      setError(en ? "Diagnosis failed" : "诊断失败，请稍后重试");
    } finally {
      setRunning(false);
    }
  }, [projectId, running, locale, en]);

  const dimLabel = (key: string) =>
    DIAGNOSIS_DIMENSION_LABELS[key as DiagnosisDimensionKey]?.[en ? "en" : "zh"] ?? key;

  const predictionView = (row: DiagnosisRow) => {
    if (row.prediction === "above")
      return { icon: <LuTrendingUp className="w-3.5 h-3.5" />, tone: "text-emerald-500 border-emerald-500/40", text: en ? "Likely above your account average" : "预计高于账号平均" };
    if (row.prediction === "below")
      return { icon: <LuTrendingDown className="w-3.5 h-3.5" />, tone: "text-red-500 border-red-500/40", text: en ? "Likely below your account average" : "预计低于账号平均" };
    if (row.prediction === "average")
      return { icon: <LuMinus className="w-3.5 h-3.5" />, tone: "text-amber-500 border-amber-500/40", text: en ? "Likely around your account average" : "预计与账号平均持平" };
    return { icon: <LuMinus className="w-3.5 h-3.5" />, tone: "text-muted-foreground border-border", text: en ? "Not enough data for a forecast yet" : "样本不足，暂无相对预测" };
  };

  return (
    <Card className="glass-card">
      <CardContent className="p-5">
        <div className="flex items-center justify-between gap-2 mb-1">
          <div className="flex items-center gap-2">
            <LuStethoscope className="w-4 h-4 text-primary" />
            <h3 className="text-sm font-semibold">{en ? "Pre-publish diagnosis" : "发布前诊断"}</h3>
            {latest?.source === "rule" && (
              <Badge variant="outline" className="text-[10px]">
                {en ? "Local quick check" : "本地快检"}
              </Badge>
            )}
          </div>
          <Button size="sm" className="brand-gradient text-white h-8" disabled={running} onClick={run}>
            {running ? <LuLoaderCircle className="w-4 h-4 mr-1 animate-spin" /> : null}
            {running ? (en ? "Diagnosing…" : "诊断中…") : latest ? (en ? "Re-diagnose" : "重新诊断") : en ? "Diagnose" : "开始诊断"}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground mb-3">
          {en
            ? "AI reviews this video's script across 5 dimensions and gives a directional forecast vs. your own history — no made-up view counts. Uses 1 generation credit."
            : "AI 按 5 个维度给这条视频的脚本做体检，并对照你账号自己的历史数据给方向性预测——不猜播放量数字。消耗 1 次生成额度。"}
        </p>

        {error && <p className="text-xs text-red-500 mb-2">{error}</p>}
        {warning && (
          <p className="text-xs text-amber-500 mb-2">
            {en ? "AI unavailable, showing local quick check: " : "AI 暂不可用，已用本地规则快检兜底："}
            {warning}
          </p>
        )}

        {latest && (
          <div className="space-y-3">
            {/* 总分 + 相对预测 */}
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex items-baseline gap-1">
                <span className={`text-3xl font-bold ${scoreTone(latest.overallScore)}`}>{latest.overallScore}</span>
                <span className="text-xs text-muted-foreground">/100</span>
              </div>
              {(() => {
                const p = predictionView(latest);
                return (
                  <span className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs ${p.tone}`}>
                    {p.icon}
                    {p.text}
                    {latest.prediction && (
                      <span className="text-muted-foreground">
                        · {latest.predictionConfidence === "medium" ? (en ? "fair guide" : "比较靠谱") : en ? "rough guide" : "仅供参考"}
                      </span>
                    )}
                  </span>
                );
              })()}
            </div>
            {latest.predictionBasis && <p className="text-[11px] text-muted-foreground">{latest.predictionBasis}</p>}

            {/* 各维度得分条 */}
            {Array.isArray(latest.dimensions) && latest.dimensions.length > 0 && (
              <div className="space-y-1.5">
                {latest.dimensions.map((d) => (
                  <div key={d.key} className="flex items-center gap-2 text-xs">
                    <span className="w-20 shrink-0 text-muted-foreground">{dimLabel(d.key)}</span>
                    <div className="h-1.5 flex-1 rounded-full bg-muted/40 overflow-hidden">
                      <div className={`h-full rounded-full ${barTone(d.score)}`} style={{ width: `${d.score}%` }} />
                    </div>
                    <span className={`w-7 shrink-0 text-right font-medium ${scoreTone(d.score)}`}>{d.score}</span>
                    <span className="hidden sm:block flex-1 text-muted-foreground truncate" title={d.comment}>
                      {d.comment}
                    </span>
                  </div>
                ))}
              </div>
            )}

            {latest.summary && <p className="text-xs">{latest.summary}</p>}

            {Array.isArray(latest.suggestions) && latest.suggestions.length > 0 && (
              <div className="border-t border-border/50 pt-2">
                <p className="text-xs font-medium mb-1">{en ? "How to improve" : "改进建议"}</p>
                <ul className="space-y-0.5">
                  {latest.suggestions.map((s, i) => (
                    <li key={i} className="text-xs text-muted-foreground">
                      · {s}
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
