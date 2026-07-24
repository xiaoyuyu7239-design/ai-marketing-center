"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, RefreshCw, Search, ShieldCheck, ShieldX, Store } from "lucide-react";
import { Badge } from "@frontend/components/ui/badge";
import { Button } from "@frontend/components/ui/button";
import { Input } from "@frontend/components/ui/input";

// ==================== 商家管理 ====================

interface AdminMerchantRow {
  id: string;
  email: string;
  shopName: string | null;
  category: string | null;
  region: string | null;
  planId: string;
  planName: string;
  monthlyQuota: number;
  quotaBonus: number;
  usedThisMonth: number;
  projectCount: number;
  approvedCount: number;
  publishedCount: number;
  createdAt: string | null;
}

interface AdminPlanRow {
  id: string;
  name: string;
  monthlyGenerationQuota: number;
}

const CATEGORY_LABEL: Record<string, string> = {
  beauty: "美妆护肤",
  food: "食品零食",
  home: "家居日用",
  fashion: "服饰鞋包",
  tech: "数码3C",
  other: "其他",
};

export function MerchantsWorkspace() {
  const [merchants, setMerchants] = useState<AdminMerchantRow[]>([]);
  const [plans, setPlans] = useState<AdminPlanRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [savingId, setSavingId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  // 每行的未保存草稿（planId/quotaBonus）
  const [drafts, setDrafts] = useState<Record<string, { planId: string; quotaBonus: string }>>({});
  const [newPlanOpen, setNewPlanOpen] = useState(false);
  const [newPlan, setNewPlan] = useState({ id: "", name: "", quota: "" });
  const [creatingPlan, setCreatingPlan] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [merchantsRes, plansRes] = await Promise.all([
        fetch("/api/admin/merchants", { cache: "no-store" }),
        fetch("/api/admin/plans", { cache: "no-store" }),
      ]);
      if (!merchantsRes.ok || !plansRes.ok) {
        setLoadError("加载失败，请确认已登录后台");
        return;
      }
      const merchantsData = await merchantsRes.json();
      const plansData = await plansRes.json();
      setMerchants(merchantsData.merchants ?? []);
      setPlans(plansData.plans ?? []);
    } catch {
      setLoadError("网络异常，请重试");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const filtered = useMemo(() => {
    if (!query.trim()) return merchants;
    const q = query.trim().toLowerCase();
    return merchants.filter((m) => `${m.email}${m.shopName ?? ""}${m.region ?? ""}`.toLowerCase().includes(q));
  }, [merchants, query]);

  const createPlan = async () => {
    const quota = Number(newPlan.quota.trim());
    if (!/^[a-z0-9-]{2,32}$/.test(newPlan.id.trim().toLowerCase())) {
      setMessage("套餐 ID 需为 2-32 位小写字母/数字/连字符");
      return;
    }
    if (!newPlan.name.trim()) {
      setMessage("请填写套餐名称");
      return;
    }
    if (!/^\d+$/.test(newPlan.quota.trim())) {
      setMessage("月度额度请填写非负整数");
      return;
    }
    setCreatingPlan(true);
    setMessage(null);
    try {
      const res = await fetch("/api/admin/plans", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: newPlan.id.trim().toLowerCase(), name: newPlan.name.trim(), monthlyGenerationQuota: quota }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMessage(typeof data.error === "string" ? data.error : "新建套餐失败");
        return;
      }
      setMessage(`已新建套餐「${newPlan.name.trim()}」`);
      setNewPlan({ id: "", name: "", quota: "" });
      setNewPlanOpen(false);
      await load();
    } catch {
      setMessage("网络异常，新建套餐失败");
    } finally {
      setCreatingPlan(false);
    }
  };

  const draftFor = (m: AdminMerchantRow) => drafts[m.id] ?? { planId: m.planId, quotaBonus: String(m.quotaBonus) };
  const isDirty = (m: AdminMerchantRow) => {
    const d = draftFor(m);
    return d.planId !== m.planId || d.quotaBonus !== String(m.quotaBonus);
  };

  const save = async (m: AdminMerchantRow) => {
    const d = draftFor(m);
    // 空/非数字的赠送额度不静默当 0 提交，先拦下来
    const bonusTrim = d.quotaBonus.trim();
    if (!/^\d+$/.test(bonusTrim)) {
      setMessage("赠送额度请填写非负整数");
      return;
    }
    setSavingId(m.id);
    setMessage(null);
    try {
      const res = await fetch("/api/admin/merchants", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ merchantId: m.id, planId: d.planId, quotaBonus: Number(bonusTrim) }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMessage(typeof data.error === "string" ? data.error : "保存失败");
        return;
      }
      setMessage(`已更新 ${m.shopName || m.email} 的套餐/额度`);
      // 只清掉刚保存这一行的草稿，保留其它行的未保存编辑
      setDrafts((prev) => {
        const next = { ...prev };
        delete next[m.id];
        return next;
      });
      await load();
    } catch {
      setMessage("网络异常，保存失败");
    } finally {
      setSavingId(null);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-border p-6 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> 正在加载商家列表…
      </div>
    );
  }
  if (loadError) {
    return <div className="rounded-lg border border-destructive/40 p-6 text-sm text-destructive">{loadError}</div>;
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-sm text-muted-foreground">账号 · 套餐 · 用量</p>
          <h1 className="mt-1 text-2xl font-semibold">商家管理</h1>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索邮箱/店铺/地区" className="w-64 pl-8" />
          </div>
          <Button variant="outline" size="sm" onClick={() => setNewPlanOpen((v) => !v)}>
            新建套餐
          </Button>
          <Button variant="outline" size="sm" onClick={() => void load()}>
            <RefreshCw className="size-4" />
            刷新
          </Button>
        </div>
      </div>

      {newPlanOpen && (
        <section className="rounded-lg border border-border bg-card p-4">
          <p className="mb-3 text-sm font-medium">新建套餐（支付未接入前，套餐即“名称 + 月度额度”）</p>
          <div className="flex flex-wrap items-end gap-3">
            <label className="text-xs text-muted-foreground">
              套餐 ID
              <Input value={newPlan.id} onChange={(e) => setNewPlan((p) => ({ ...p, id: e.target.value }))} placeholder="pro" className="mt-1 w-32" />
            </label>
            <label className="text-xs text-muted-foreground">
              名称
              <Input value={newPlan.name} onChange={(e) => setNewPlan((p) => ({ ...p, name: e.target.value }))} placeholder="专业版" className="mt-1 w-40" />
            </label>
            <label className="text-xs text-muted-foreground">
              月度额度
              <Input value={newPlan.quota} onChange={(e) => setNewPlan((p) => ({ ...p, quota: e.target.value }))} inputMode="numeric" placeholder="200" className="mt-1 w-28" />
            </label>
            <Button size="sm" disabled={creatingPlan} onClick={() => void createPlan()}>
              {creatingPlan ? "创建中…" : "创建"}
            </Button>
          </div>
        </section>
      )}

      {message && <div className="rounded-lg border border-border bg-muted/20 px-4 py-2 text-sm">{message}</div>}

      <section className="rounded-lg border border-border bg-card">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1080px] text-sm">
            <thead className="text-left text-xs text-muted-foreground">
              <tr className="border-b border-border">
                <th className="px-4 py-3 font-medium">商家</th>
                <th className="px-4 py-3 font-medium">建档</th>
                <th className="px-4 py-3 font-medium">套餐</th>
                <th className="px-4 py-3 font-medium">赠送额度</th>
                <th className="px-4 py-3 font-medium">本月用量</th>
                <th className="px-4 py-3 font-medium">项目</th>
                <th className="px-4 py-3 font-medium">入库/已发</th>
                <th className="px-4 py-3 font-medium">注册时间</th>
                <th className="px-4 py-3 font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((m) => {
                const d = draftFor(m);
                const overQuota = m.usedThisMonth >= m.monthlyQuota;
                return (
                  <tr key={m.id} className="border-b border-border/70 last:border-0">
                    <td className="px-4 py-3">
                      <p className="font-medium">{m.shopName || "（未填店铺名）"}</p>
                      <p className="font-mono text-xs text-muted-foreground">{m.email}</p>
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">
                      {m.category ? CATEGORY_LABEL[m.category] ?? m.category : "-"}
                      {m.region ? ` · ${m.region}` : ""}
                    </td>
                    <td className="px-4 py-3">
                      <select
                        value={d.planId}
                        onChange={(e) => setDrafts((prev) => ({ ...prev, [m.id]: { ...d, planId: e.target.value } }))}
                        className="h-8 rounded-md border border-border bg-background px-2 text-sm"
                      >
                        {plans
                          // unlimited 是单用户/桌面版内部套餐，不对外售卖，不进可选列表——
                          // 除非该商家当前就在 unlimited 上（保证 select 有匹配项、不误改成别的）
                          .filter((p) => p.id !== "unlimited" || m.planId === "unlimited")
                          .map((p) => (
                            <option key={p.id} value={p.id}>
                              {p.name}（{p.monthlyGenerationQuota}/月）
                            </option>
                          ))}
                      </select>
                    </td>
                    <td className="px-4 py-3">
                      <Input
                        value={d.quotaBonus}
                        onChange={(e) => setDrafts((prev) => ({ ...prev, [m.id]: { ...d, quotaBonus: e.target.value } }))}
                        inputMode="numeric"
                        className="h-8 w-20"
                        aria-label={`${m.email} 的赠送额度`}
                      />
                    </td>
                    <td className="px-4 py-3">
                      <Badge variant={overQuota ? "destructive" : "secondary"}>
                        {m.usedThisMonth}/{m.monthlyQuota}
                      </Badge>
                    </td>
                    <td className="px-4 py-3">{m.projectCount}</td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">
                      {m.approvedCount}/{m.publishedCount}
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">
                      {m.createdAt ? new Date(m.createdAt).toLocaleDateString("zh-CN") : "-"}
                    </td>
                    <td className="px-4 py-3">
                      <Button size="sm" disabled={!isDirty(m) || savingId === m.id} onClick={() => void save(m)}>
                        {savingId === m.id ? "保存中…" : "保存"}
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {filtered.length === 0 ? (
          <div className="p-8 text-center text-sm text-muted-foreground">
            <Store className="mx-auto mb-2 size-6" />
            还没有匹配的商家
          </div>
        ) : null}
      </section>
    </div>
  );
}

// ==================== 内容审核 ====================

interface AdminReviewRow {
  recordId: string;
  merchantId: string;
  merchantEmail: string;
  shopName: string | null;
  projectId: string;
  projectName: string;
  productName: string | null;
  reviewStatus: "pending" | "approved" | "rejected";
  reviewNote: string | null;
  approvedAt: string | null;
  publishedAt: string | null;
  videoUrl: string | null;
}

// pending 当前没有自动进入路径（新内容默认 approved，商家自审），审核台不设"待复核"tab 避免误导运营空等
const REVIEW_TABS = [
  { value: "all", label: "全部" },
  { value: "approved", label: "已通过" },
  { value: "rejected", label: "已驳回" },
] as const;

export function ReviewWorkspace() {
  const [records, setRecords] = useState<AdminReviewRow[]>([]);
  const [status, setStatus] = useState<(typeof REVIEW_TABS)[number]["value"]>("all");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actingId, setActingId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async (filter: string) => {
    setLoading(true);
    setLoadError(null);
    try {
      const qs = filter === "all" ? "" : `?status=${filter}`;
      const res = await fetch(`/api/admin/review${qs}`, { cache: "no-store" });
      if (!res.ok) {
        setLoadError("加载失败，请确认已登录后台");
        return;
      }
      const data = await res.json();
      setRecords(data.records ?? []);
    } catch {
      setLoadError("网络异常，请重试");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(status);
  }, [load, status]);

  const act = async (record: AdminReviewRow, reviewStatus: "approved" | "rejected") => {
    // 驳回时让运营填个原因回传给商家（可留空）
    let reviewNote: string | undefined;
    if (reviewStatus === "rejected") {
      const input = typeof window !== "undefined" ? window.prompt("驳回原因（会展示给商家，可留空）", "") : "";
      if (input === null) return; // 取消
      reviewNote = input.trim() || undefined;
    }
    setActingId(record.recordId);
    setMessage(null);
    try {
      const res = await fetch("/api/admin/review", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ recordId: record.recordId, reviewStatus, ...(reviewNote ? { reviewNote } : {}) }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMessage(typeof data.error === "string" ? data.error : "操作失败");
        return;
      }
      setMessage(
        reviewStatus === "rejected"
          ? `已驳回「${record.productName || record.projectName}」，将从商家待发布库消失`
          : `已通过「${record.productName || record.projectName}」`
      );
      await load(status);
    } catch {
      setMessage("网络异常，操作失败");
    } finally {
      setActingId(null);
    }
  };

  return (
    <div className="space-y-5">
      <div>
        <p className="text-sm text-muted-foreground">商家待发布内容的人工把关</p>
        <h1 className="mt-1 text-2xl font-semibold">内容审核</h1>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {REVIEW_TABS.map((tab) => (
          <button
            key={tab.value}
            type="button"
            onClick={() => setStatus(tab.value)}
            className={`h-8 rounded-md border px-3 text-sm transition ${
              status === tab.value
                ? "border-primary bg-primary/12 text-primary"
                : "border-border text-muted-foreground hover:text-foreground"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {message && <div className="rounded-lg border border-border bg-muted/20 px-4 py-2 text-sm">{message}</div>}

      {loading ? (
        <div className="flex items-center gap-2 rounded-lg border border-border p-6 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> 正在加载审核队列…
        </div>
      ) : loadError ? (
        <div className="rounded-lg border border-destructive/40 p-6 text-sm text-destructive">{loadError}</div>
      ) : (
        <section className="rounded-lg border border-border bg-card">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[960px] text-sm">
              <thead className="text-left text-xs text-muted-foreground">
                <tr className="border-b border-border">
                  <th className="px-4 py-3 font-medium">内容</th>
                  <th className="px-4 py-3 font-medium">商家</th>
                  <th className="px-4 py-3 font-medium">成片</th>
                  <th className="px-4 py-3 font-medium">入库时间</th>
                  <th className="px-4 py-3 font-medium">状态</th>
                  <th className="px-4 py-3 font-medium">操作</th>
                </tr>
              </thead>
              <tbody>
                {records.map((record) => (
                  <tr key={record.recordId} className="border-b border-border/70 last:border-0">
                    <td className="px-4 py-3">
                      <p className="font-medium">{record.productName || record.projectName}</p>
                      <p className="font-mono text-xs text-muted-foreground">{record.projectId.slice(0, 8)}</p>
                    </td>
                    <td className="px-4 py-3 text-xs">
                      <p>{record.shopName || "-"}</p>
                      <p className="font-mono text-muted-foreground">{record.merchantEmail}</p>
                    </td>
                    <td className="px-4 py-3">
                      {record.videoUrl ? (
                        <a href={record.videoUrl} target="_blank" rel="noreferrer" className="text-primary underline-offset-2 hover:underline">
                          查看成片
                        </a>
                      ) : (
                        <span className="text-xs text-muted-foreground">未合成</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">
                      {record.approvedAt ? new Date(record.approvedAt).toLocaleString("zh-CN") : "-"}
                    </td>
                    <td className="px-4 py-3">
                      <Badge
                        variant={record.reviewStatus === "rejected" ? "destructive" : record.reviewStatus === "approved" ? "secondary" : "outline"}
                        className={record.reviewStatus === "approved" ? "text-emerald-400" : ""}
                      >
                        {record.reviewStatus === "approved" ? "已通过" : record.reviewStatus === "rejected" ? "已驳回" : "待复核"}
                      </Badge>
                      {record.reviewStatus === "rejected" && record.reviewNote ? (
                        <p className="mt-1 max-w-48 text-xs text-muted-foreground">原因：{record.reviewNote}</p>
                      ) : null}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex gap-2">
                        {record.reviewStatus !== "approved" && (
                          <Button size="sm" variant="outline" disabled={actingId === record.recordId} onClick={() => void act(record, "approved")}>
                            <ShieldCheck className="size-3.5" />
                            通过
                          </Button>
                        )}
                        {record.reviewStatus !== "rejected" && (
                          <Button size="sm" variant="outline" className="text-destructive" disabled={actingId === record.recordId} onClick={() => void act(record, "rejected")}>
                            <ShieldX className="size-3.5" />
                            驳回
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {records.length === 0 ? <div className="p-8 text-center text-sm text-muted-foreground">这个状态下没有内容</div> : null}
        </section>
      )}
    </div>
  );
}
