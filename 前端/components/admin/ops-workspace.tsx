"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, CircleDollarSign, DatabaseBackup, HeartPulse, ListTodo } from "lucide-react";
import { Badge } from "@frontend/components/ui/badge";
import type { OpsSnapshot } from "@server/admin/ops";

function duration(ms: number | null) {
  if (ms === null) return "-";
  if (ms < 60_000) return `${Math.round(ms / 1_000)} 秒`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} 分钟`;
  return `${(ms / 3_600_000).toFixed(1)} 小时`;
}

export function OpsWorkspace() {
  const [snapshot, setSnapshot] = useState<OpsSnapshot | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    const load = () => fetch("/api/admin/ops", { cache: "no-store" })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "读取运维告警失败");
        if (alive) setSnapshot(data);
      })
      .catch((reason) => {
        if (alive) setError(reason instanceof Error ? reason.message : "读取运维告警失败");
      });
    void load();
    const timer = window.setInterval(load, 30_000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, []);

  if (error) return <div className="rounded-lg border border-destructive/40 p-6 text-sm text-destructive">{error}</div>;
  if (!snapshot) return <div className="rounded-lg border border-border bg-card p-8 text-center text-sm text-muted-foreground">正在读取运维状态...</div>;

  const cards = [
    { label: "待执行 / 运行中", value: `${snapshot.queue.pending} / ${snapshot.queue.running}`, hint: `最老等待 ${duration(snapshot.queue.oldestPendingAgeMs)}`, icon: ListTodo },
    { label: "24h 模型失败率", value: `${(snapshot.providers.failureRate24h * 100).toFixed(1)}%`, hint: `${snapshot.providers.failures24h}/${snapshot.providers.attempts24h} attempts`, icon: HeartPulse },
    {
      label: "真实成本覆盖",
      value: snapshot.costs.coverageRate24h === null ? "无样本" : `${(snapshot.costs.coverageRate24h * 100).toFixed(1)}%`,
      hint: `${snapshot.costs.pricedAttempts24h}/${snapshot.costs.successfulAttempts24h} attempts · 已知 $${snapshot.costs.knownCostUsd24h.toFixed(4)}`,
      icon: CircleDollarSign,
    },
    { label: "最近完成备份", value: snapshot.backup.available ? duration(snapshot.backup.ageMs) + "前" : "不可用", hint: snapshot.backup.configured ? "目标目录已配置" : "BACKUP_DIR 未配置", icon: DatabaseBackup },
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-sm text-muted-foreground">邀请内测值守</p>
          <h1 className="mt-1 text-2xl font-semibold">运维告警</h1>
          <p className="mt-1 text-xs text-muted-foreground">每 30 秒刷新 · {new Date(snapshot.generatedAt).toLocaleString("zh-CN")}</p>
        </div>
        <Badge variant={snapshot.status === "critical" ? "destructive" : "outline"}>
          {snapshot.status === "critical" ? "阻止放行" : snapshot.status === "warning" ? "需要关注" : "当前健康"}
        </Badge>
      </div>

      <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        {cards.map((card) => {
          const Icon = card.icon;
          return (
            <div key={card.label} className="rounded-lg border border-border bg-card p-4">
              <div className="flex items-center justify-between"><p className="text-sm text-muted-foreground">{card.label}</p><Icon className="size-4 text-primary" /></div>
              <p className="mt-3 text-2xl font-semibold">{card.value}</p>
              <p className="mt-1 text-xs text-muted-foreground">{card.hint}</p>
            </div>
          );
        })}
      </section>

      <section className="rounded-lg border border-border bg-card">
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          {snapshot.status === "healthy" ? <CheckCircle2 className="size-4 text-emerald-500" /> : <AlertTriangle className="size-4 text-amber-500" />}
          <h2 className="text-sm font-semibold">当前告警与处置</h2>
        </div>
        <div className="divide-y divide-border">
          {snapshot.alerts.map((item) => (
            <div key={item.id} className="grid gap-2 p-4 md:grid-cols-[130px_1fr_1fr]">
              <Badge variant={item.severity === "critical" ? "destructive" : "outline"} className="w-fit">
                {item.severity === "critical" ? "严重" : item.severity === "warning" ? "警告" : "信息"}
              </Badge>
              <div><p className="text-sm font-medium">{item.title}</p><p className="mt-1 text-xs text-muted-foreground">{item.detail}</p></div>
              <div><p className="text-xs font-medium text-muted-foreground">建议处置</p><p className="mt-1 text-sm">{item.action}</p></div>
            </div>
          ))}
        </div>
      </section>

      <section className="rounded-lg border border-border bg-card p-4">
        <h2 className="text-sm font-semibold">本机 readiness</h2>
        <div className="mt-3 flex flex-wrap gap-2">
          {Object.entries(snapshot.readiness).map(([name, ok]) => <Badge key={name} variant={ok ? "secondary" : "destructive"}>{name}: {ok ? "通过" : "失败"}</Badge>)}
        </div>
      </section>
    </div>
  );
}
