"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  Clock3,
  FlaskConical,
  Gauge,
  GitBranch,
  Pencil,
  RotateCcw,
  Save,
  Search,
  Send,
  Star,
  TrendingDown,
} from "lucide-react";
import { fmtPct } from "@backend/shared/utils";
import { Badge } from "@frontend/components/ui/badge";
import { Button } from "@frontend/components/ui/button";
import { Input } from "@frontend/components/ui/input";
import { Textarea } from "@frontend/components/ui/textarea";
import type {
  AgentConfig,
  GoldenEvalCaseDto,
  GoldenEvalPayload,
  GoldenEvalPromotionDto,
  AgentEvalRecord,
  AgentId,
  AgentPromptVersion,
  AgentRunRecord,
  AgentStrategyState,
  ModelEndpointConfig,
  PromptStatus,
} from "@server/admin/agents/types";

type EndpointKey = "primary" | "fallback";
type AdminApiPath = "/api/admin/agents" | "/api/admin/prompts" | "/api/admin/model-evals" | "/api/admin/runs";

const SECRET_REF_OPTIONS: ModelEndpointConfig["secretRef"][] = [
  "llm.primary",
  "llm.fallback",
  "image.primary",
  "image.fallback",
  "video.primary",
  "video.fallback",
  "tts.primary",
  "tts.fallback",
];

const EMPTY_STATE: AgentStrategyState = {
  strategyRevision: 0,
  onlineVersion: "",
  draftVersion: "",
  publishedAt: "",
  agents: [],
  onlineAgents: [],
  draftAgents: [],
  previousAgents: {},
  prompts: [],
  runs: [],
  evals: [],
  audit: [],
};

function mergeState(current: AgentStrategyState, patch: Partial<AgentStrategyState>): AgentStrategyState {
  return {
    strategyRevision: patch.strategyRevision ?? current.strategyRevision,
    onlineVersion: patch.onlineVersion ?? current.onlineVersion,
    draftVersion: patch.draftVersion ?? current.draftVersion,
    publishedAt: patch.publishedAt ?? current.publishedAt,
    agents: patch.agents ?? current.agents,
    onlineAgents: patch.onlineAgents ?? current.onlineAgents,
    draftAgents: patch.draftAgents ?? current.draftAgents,
    previousAgents: patch.previousAgents ?? current.previousAgents,
    prompts: patch.prompts ?? current.prompts,
    runs: patch.runs ?? current.runs,
    evals: patch.evals ?? current.evals,
    audit: patch.audit ?? current.audit,
  };
}

function saveBody(endpoint: AdminApiPath, state: AgentStrategyState) {
  if (endpoint === "/api/admin/agents") return { agents: state.agents };
  if (endpoint === "/api/admin/prompts") return { agents: state.agents, prompts: state.prompts };
  if (endpoint === "/api/admin/model-evals") return { evals: state.evals };
  return state;
}

function saveMethod(endpoint: AdminApiPath) {
  return endpoint === "/api/admin/model-evals" ? "PATCH" : "PUT";
}

function LoadingPanel({ title }: { title: string }) {
  return (
    <div className="rounded-lg border border-border bg-card p-8 text-center text-sm text-muted-foreground">
      正在加载{title}...
    </div>
  );
}

function agentLabel(state: AgentStrategyState, agentId: AgentId) {
  return state.agents.find((agent) => agent.id === agentId)?.name ?? agentId;
}

function statusLabel(status: PromptStatus) {
  if (status === "online") return "线上版本";
  if (status === "eval") return "评测版本";
  return "草稿";
}

function statusVariant(status: PromptStatus) {
  if (status === "online") return "secondary";
  if (status === "eval") return "outline";
  return "ghost";
}

function todayKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function updateEndpoint(agent: AgentConfig, key: EndpointKey, patch: Partial<ModelEndpointConfig>): AgentConfig {
  return { ...agent, [key]: { ...agent[key], ...patch }, updatedAt: new Date().toISOString() };
}

function EndpointEditor({
  label,
  endpoint,
  onChange,
}: {
  label: string;
  endpoint: ModelEndpointConfig;
  onChange: (patch: Partial<ModelEndpointConfig>) => void;
}) {
  return (
    <div className="rounded-lg border border-border bg-background/40 p-3">
      <p className="mb-3 text-xs font-medium text-muted-foreground">{label}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1.5 text-xs text-muted-foreground">
          provider
          <Input value={endpoint.provider} onChange={(e) => onChange({ provider: e.target.value })} className="font-mono text-xs" />
        </label>
        <label className="space-y-1.5 text-xs text-muted-foreground">
          model
          <Input value={endpoint.model} onChange={(e) => onChange({ model: e.target.value })} className="font-mono text-xs" />
        </label>
        <label className="space-y-1.5 text-xs text-muted-foreground sm:col-span-2">
          baseUrl
          <Input value={endpoint.baseUrl} onChange={(e) => onChange({ baseUrl: e.target.value })} className="font-mono text-xs" />
        </label>
        <label className="space-y-1.5 text-xs text-muted-foreground sm:col-span-2">
          服务端凭据引用 secretRef
          <select
            value={endpoint.secretRef}
            onChange={(e) => onChange({ secretRef: e.target.value as ModelEndpointConfig["secretRef"] })}
            className="h-8 w-full rounded-md border border-border bg-background px-2 font-mono text-xs"
          >
            {SECRET_REF_OPTIONS.map((secretRef) => <option key={secretRef} value={secretRef}>{secretRef}</option>)}
          </select>
          <span className={endpoint.secretConfigured ? "text-emerald-400" : "text-amber-400"}>
            {endpoint.secretConfigured ? "对应环境凭据已配置" : "对应环境凭据未配置"}
          </span>
        </label>
        <label className="space-y-1.5 text-xs text-muted-foreground sm:col-span-2">
          visionModel（生产须为空或与 model 相同）
          <Input value={endpoint.visionModel ?? ""} onChange={(e) => onChange({ visionModel: e.target.value || undefined })} className="font-mono text-xs" />
        </label>
        <label className="space-y-1.5 text-xs text-muted-foreground sm:col-span-2">
          供应商不可变 deploymentRevision
          <Input value={endpoint.deploymentRevision ?? ""} onChange={(e) => onChange({ deploymentRevision: e.target.value || undefined })} className="font-mono text-xs" />
        </label>
        <label className="space-y-1.5 text-xs text-muted-foreground">
          revisionEvidenceFile
          <Input value={endpoint.revisionEvidenceFile ?? ""} onChange={(e) => onChange({ revisionEvidenceFile: e.target.value || undefined })} className="font-mono text-xs" />
        </label>
        <label className="space-y-1.5 text-xs text-muted-foreground">
          revisionEvidenceSha256
          <Input value={endpoint.revisionEvidenceSha256 ?? ""} onChange={(e) => onChange({ revisionEvidenceSha256: e.target.value || undefined })} className="font-mono text-xs" />
        </label>
        <p className="text-[11px] text-muted-foreground sm:col-span-2">
          证据文件必须放在服务端 HUIMAI_MODEL_REVISION_EVIDENCE_DIR；生产预检会逐字节核对 SHA-256，浮动别名不会放行。
        </p>
      </div>
    </div>
  );
}

function useStrategyState(endpoint: AdminApiPath) {
  const [state, setState] = useState<AgentStrategyState>(EMPTY_STATE);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    let alive = true;
    fetch(endpoint)
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || "后台数据加载失败");
        return data as Partial<AgentStrategyState>;
      })
      .then((data) => {
        if (alive) setState((current) => mergeState(current, data));
      })
      .catch((error) => {
        if (alive) setLoadError(error instanceof Error ? error.message : "后台数据加载失败");
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [endpoint]);

  const save = (nextState = state) => {
    startTransition(async () => {
      const res = await fetch(endpoint, {
        method: saveMethod(endpoint),
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(saveBody(endpoint, nextState)),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setMessage(data.error || "保存失败");
        return;
      }
      const saved = await res.json();
      setState((current) => mergeState(current, saved));
      setMessage("已保存");
      setTimeout(() => setMessage(""), 1800);
    });
  };

  const action = (agentId: AgentId, actionName: "publish" | "rollback") => {
    startTransition(async () => {
      // 发布前先将当前编辑态写入独立 draft 槽，再由服务端原子发布该 Agent。
      if (actionName === "publish" && endpoint === "/api/admin/agents") {
        const draftRes = await fetch("/api/admin/agents", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ agents: state.agents }),
        });
        if (!draftRes.ok) {
          const data = await draftRes.json().catch(() => ({}));
          setMessage(data.error || "草稿保存失败，未发布");
          return;
        }
      }
      const res = await fetch("/api/admin/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId, action: actionName }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setMessage(data.error || (actionName === "publish" ? "发布失败" : "回滚失败"));
        return;
      }
      const saved = await res.json();
      setState((current) => mergeState(current, saved));
      setMessage(actionName === "publish" ? "已发布到线上" : "已回滚上一版");
      setTimeout(() => setMessage(""), 1800);
    });
  };

  return { state, setState, save, action, message, loading, loadError, isPending };
}

export function AdminDashboard() {
  const [state, setState] = useState<AgentStrategyState>(EMPTY_STATE);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

  useEffect(() => {
    let alive = true;
    Promise.all([
      fetch("/api/admin/agents").then((res) => res.json().then((data) => ({ res, data }))),
      fetch("/api/admin/runs").then((res) => res.json().then((data) => ({ res, data }))),
    ])
      .then(([agents, runs]) => {
        if (!agents.res.ok) throw new Error(agents.data.error || "Agent 数据加载失败");
        if (!runs.res.ok) throw new Error(runs.data.error || "生成记录加载失败");
        if (alive) setState((current) => mergeState(mergeState(current, agents.data), runs.data));
      })
      .catch((error) => {
        if (alive) setLoadError(error instanceof Error ? error.message : "后台数据加载失败");
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  if (loading) return <LoadingPanel title="系统状态" />;
  if (loadError) return <div className="rounded-lg border border-destructive/40 p-6 text-sm text-destructive">{loadError}</div>;

  const today = todayKey();
  const todayRuns = state.runs.filter((run) => run.createdAt.slice(0, 10) === today);
  const failedToday = todayRuns.filter((run) => !run.success).length;
  const failureRate = todayRuns.length ? failedToday / todayRuns.length : 0;
  const enabledAgents = state.agents.filter((agent) => agent.enabled).length;
  const recentErrors = state.runs.filter((run) => !run.success).slice(0, 6);

  const stats = [
    { label: "已启用 Agent 数量", value: enabledAgents, icon: Bot, hint: `共 ${state.agents.length} 个 Agent` },
    { label: "当前线上模型策略版本", value: state.onlineVersion, icon: GitBranch, hint: state.publishedAt ? new Date(state.publishedAt).toLocaleString("zh-CN") : "-" },
    { label: "今日生成任务数", value: todayRuns.length, icon: Clock3, hint: today },
    { label: "今日失败率", value: fmtPct(failureRate), icon: TrendingDown, hint: `${failedToday} 次失败` },
  ];

  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm text-muted-foreground">工作人员后台</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">系统状态</h1>
      </div>

      <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        {stats.map((stat) => {
          const Icon = stat.icon;
          return (
            <div key={stat.label} className="rounded-lg border border-border bg-card p-4">
              <div className="flex items-center justify-between">
                <p className="text-sm text-muted-foreground">{stat.label}</p>
                <Icon className="size-4 text-primary" />
              </div>
              <p className="mt-3 text-2xl font-semibold">{stat.value}</p>
              <p className="mt-1 text-xs text-muted-foreground">{stat.hint}</p>
            </div>
          );
        })}
      </section>

      <section className="grid gap-4 xl:grid-cols-[1.15fr_0.85fr]">
        <div className="rounded-lg border border-border bg-card">
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <div className="flex items-center gap-2">
              <Gauge className="size-4 text-primary" />
              <h2 className="text-sm font-semibold">Agent 运行健康度</h2>
            </div>
            <Badge variant="outline">{state.onlineVersion}</Badge>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-sm">
              <thead className="text-left text-xs text-muted-foreground">
                <tr className="border-b border-border">
                  <th className="px-4 py-3 font-medium">Agent</th>
                  <th className="px-4 py-3 font-medium">线上 prompt</th>
                  <th className="px-4 py-3 font-medium">启用状态</th>
                  <th className="px-4 py-3 font-medium">最近成功率</th>
                  <th className="px-4 py-3 font-medium">平均耗时</th>
                </tr>
              </thead>
              <tbody>
                {state.agents.map((agent) => (
                  <tr key={agent.id} className="border-b border-border/70 last:border-0">
                    <td className="px-4 py-3">
                      <p className="font-medium">{agent.name}</p>
                      <p className="text-xs text-muted-foreground">{agent.description}</p>
                    </td>
                    <td className="px-4 py-3 font-mono text-xs">{agent.promptVersion}</td>
                    <td className="px-4 py-3">
                      <Badge variant={agent.enabled ? "secondary" : "outline"} className={agent.enabled ? "text-emerald-400" : ""}>
                        {agent.enabled ? "已启用" : "已停用"}
                      </Badge>
                    </td>
                    <td className="px-4 py-3">{fmtPct(agent.successRate)}</td>
                    <td className="px-4 py-3">{agent.avgLatencyMs} ms</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="rounded-lg border border-border bg-card">
          <div className="flex items-center gap-2 border-b border-border px-4 py-3">
            <AlertTriangle className="size-4 text-amber-400" />
            <h2 className="text-sm font-semibold">近期模型调用异常</h2>
          </div>
          <div className="divide-y divide-border">
            {recentErrors.length ? (
              recentErrors.map((run) => (
                <div key={run.id} className="p-4">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm font-medium">{run.agentName}</p>
                    <Badge variant="destructive">失败</Badge>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {run.provider}/{run.model} · {run.latencyMs} ms · {new Date(run.createdAt).toLocaleString("zh-CN")}
                  </p>
                  <p className="mt-2 line-clamp-2 text-xs text-destructive">{run.errorReason || "未记录失败原因"}</p>
                </div>
              ))
            ) : (
              <div className="p-8 text-center text-sm text-muted-foreground">暂无近期异常</div>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}

export function AgentsWorkspace() {
  const { state, setState, save, action, message, loading, loadError, isPending } = useStrategyState("/api/admin/agents");
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<AgentId | null>(state.agents[0]?.id ?? null);
  const filtered = state.agents.filter((agent) => `${agent.name}${agent.description}`.toLowerCase().includes(query.toLowerCase()));
  const selected = state.agents.find((agent) => agent.id === editing) ?? filtered[0];

  const updateAgent = (agentId: AgentId, patch: Partial<AgentConfig>) => {
    setState({
      ...state,
      agents: state.agents.map((agent) => agent.id === agentId ? { ...agent, ...patch, updatedAt: new Date().toISOString() } : agent),
    });
  };

  const saveDraft = () => {
    if (selected) {
      const next = {
        ...state,
        agents: state.agents.map((agent) => agent.id === selected.id
          ? { ...agent, updatedAt: new Date().toISOString() }
          : agent),
      };
      setState(next);
      save(next);
    }
  };

  if (loading) return <LoadingPanel title="Agent 配置" />;
  if (loadError) return <div className="rounded-lg border border-destructive/40 p-6 text-sm text-destructive">{loadError}</div>;

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-sm text-muted-foreground">模型策略</p>
          <h1 className="mt-1 text-2xl font-semibold">Agent 模型配置</h1>
          <p className="mt-1 text-xs text-muted-foreground">
            修订 r{state.strategyRevision} · 草稿 {state.draftVersion || "-"} · 线上 {state.onlineVersion || "-"}
          </p>
        </div>
        <div className="relative w-full sm:w-80">
          <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="筛选 Agent" className="pl-8" />
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-[1.15fr_0.85fr]">
        <div className="rounded-lg border border-border bg-card">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[980px] text-sm">
              <thead className="text-left text-xs text-muted-foreground">
                <tr className="border-b border-border">
                  <th className="px-4 py-3 font-medium">Agent 名称</th>
                  <th className="px-4 py-3 font-medium">职责说明</th>
                  <th className="px-4 py-3 font-medium">主模型 primary</th>
                  <th className="px-4 py-3 font-medium">备用模型 fallback</th>
                  <th className="px-4 py-3 font-medium">prompt 版本</th>
                  <th className="px-4 py-3 font-medium">启用状态</th>
                  <th className="px-4 py-3 font-medium">最近成功率</th>
                  <th className="px-4 py-3 font-medium">平均耗时</th>
                  <th className="px-4 py-3 font-medium">操作</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((agent) => (
                  <tr key={agent.id} className="border-b border-border/70 last:border-0">
                    <td className="px-4 py-3 font-medium">{agent.name}</td>
                    <td className="max-w-60 px-4 py-3 text-xs text-muted-foreground">{agent.description}</td>
                    <td className="px-4 py-3 font-mono text-xs">{agent.primary.provider}/{agent.primary.model}</td>
                    <td className="px-4 py-3 font-mono text-xs">{agent.fallback.provider}/{agent.fallback.model}</td>
                    <td className="px-4 py-3 font-mono text-xs">{agent.promptVersion}</td>
                    <td className="px-4 py-3">
                      <Badge variant={agent.enabled ? "secondary" : "outline"} className={agent.enabled ? "text-emerald-400" : ""}>
                        {agent.enabled ? "启用" : "停用"}
                      </Badge>
                    </td>
                    <td className="px-4 py-3">{fmtPct(agent.successRate)}</td>
                    <td className="px-4 py-3">{agent.avgLatencyMs} ms</td>
                    <td className="px-4 py-3">
                      <div className="flex gap-1">
                        <Button size="xs" variant="outline" onClick={() => setEditing(agent.id)}>
                          <Pencil className="size-3" />
                          编辑
                        </Button>
                        <Button size="xs" variant="ghost" onClick={() => action(agent.id, "publish")} disabled={isPending}>
                          <Send className="size-3" />
                          发布
                        </Button>
                        <Button size="xs" variant="ghost" onClick={() => action(agent.id, "rollback")} disabled={!agent.previous || isPending}>
                          <RotateCcw className="size-3" />
                          回滚
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {selected ? (
          <div className="rounded-lg border border-border bg-card p-4">
            <div className="mb-4 flex items-center justify-between">
              <div>
                <h2 className="font-semibold">编辑 Agent</h2>
                <p className="text-xs text-muted-foreground">修改后可先保存草稿，再发布到线上。</p>
              </div>
              <Badge variant="outline">{selected.id}</Badge>
            </div>
            <div className="space-y-3">
              <label className="space-y-1.5 text-xs text-muted-foreground">
                Agent 名称
                <Input value={selected.name} onChange={(e) => updateAgent(selected.id, { name: e.target.value })} />
              </label>
              <label className="space-y-1.5 text-xs text-muted-foreground">
                职责说明
                <Textarea value={selected.description} onChange={(e) => updateAgent(selected.id, { description: e.target.value })} rows={3} />
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={selected.enabled}
                  onChange={(e) => updateAgent(selected.id, { enabled: e.target.checked })}
                />
                启用 Agent
              </label>
              <EndpointEditor
                label="主模型 primary"
                endpoint={selected.primary}
                onChange={(patch) => updateAgent(selected.id, updateEndpoint(selected, "primary", patch))}
              />
              <EndpointEditor
                label="备用模型 fallback"
                endpoint={selected.fallback}
                onChange={(patch) => updateAgent(selected.id, updateEndpoint(selected, "fallback", patch))}
              />
              <div className="flex flex-wrap gap-2 pt-2">
                <Button onClick={saveDraft} disabled={isPending}>
                  <Save className="size-4" />
                  保存草稿
                </Button>
                <Button variant="outline" onClick={() => action(selected.id, "publish")} disabled={isPending}>
                  <Send className="size-4" />
                  发布到线上
                </Button>
                <Button variant="ghost" onClick={() => action(selected.id, "rollback")} disabled={!selected.previous || isPending}>
                  <RotateCcw className="size-4" />
                  回滚上一版
                </Button>
              </div>
              {message ? <p className="text-xs text-emerald-400">{message}</p> : null}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function PromptsWorkspace() {
  const { state, setState, save, message, loading, loadError, isPending } = useStrategyState("/api/admin/prompts");
  const [agentId, setAgentId] = useState<AgentId>(state.agents[0]?.id ?? "script");
  const prompts = state.prompts.filter((prompt) => prompt.agentId === agentId);
  const [promptId, setPromptId] = useState(prompts[0]?.id ?? "");
  const selected = state.prompts.find((prompt) => prompt.id === promptId) ?? prompts[0];

  const updatePrompt = (id: string, patch: Partial<AgentPromptVersion>) => {
    setState({
      ...state,
      prompts: state.prompts.map((prompt) => prompt.id === id ? { ...prompt, ...patch, updatedAt: new Date().toISOString() } : prompt),
    });
  };

  const setPromptStatus = (id: string, status: PromptStatus) => {
    const target = state.prompts.find((prompt) => prompt.id === id);
    if (!target) return;
    const nextPrompts = state.prompts.map((prompt) => {
      if (prompt.agentId !== target.agentId) return prompt;
      if (status === "online" && prompt.id !== id && prompt.status === "online") return { ...prompt, status: "draft" as PromptStatus };
      if (status === "eval" && prompt.id !== id && prompt.status === "eval") return { ...prompt, status: "draft" as PromptStatus };
      return prompt.id === id ? { ...prompt, status, updatedAt: new Date().toISOString() } : prompt;
    });
    const next = {
      ...state,
      prompts: nextPrompts,
      agents: state.agents.map((agent) =>
        status === "online" && agent.id === target.agentId
          ? { ...agent, promptVersion: target.version, updatedAt: new Date().toISOString() }
          : agent,
      ),
    };
    setState(next);
    save(next);
  };

  const addVersion = () => {
    const version = `${agentId}-v${prompts.length + 1}`.replace("topic-script", "topic").replace("product-analysis", "analysis").replace("publish-copy", "publish");
    const nextPrompt: AgentPromptVersion = {
      id: `prompt_${Date.now()}`,
      agentId,
      version,
      content: selected?.content || "",
      status: "draft",
      updatedAt: new Date().toISOString(),
    };
    setState({ ...state, prompts: [nextPrompt, ...state.prompts] });
    setPromptId(nextPrompt.id);
  };

  if (loading) return <LoadingPanel title="提示词管理" />;
  if (loadError) return <div className="rounded-lg border border-destructive/40 p-6 text-sm text-destructive">{loadError}</div>;

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-sm text-muted-foreground">Prompt 版本</p>
          <h1 className="mt-1 text-2xl font-semibold">系统提示词管理</h1>
        </div>
        <div className="flex gap-2">
          <select value={agentId} onChange={(e) => { setAgentId(e.target.value as AgentId); setPromptId(""); }} className="h-8 rounded-md border border-border bg-background px-2 text-sm">
            {state.agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
          </select>
          <Button variant="outline" onClick={addVersion}>
            <Star className="size-4" />
            新建版本
          </Button>
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-[320px_1fr]">
        <div className="rounded-lg border border-border bg-card">
          <div className="border-b border-border px-4 py-3 text-sm font-medium">版本列表</div>
          <div className="divide-y divide-border">
            {prompts.map((prompt) => (
              <button
                key={prompt.id}
                onClick={() => setPromptId(prompt.id)}
                className={`block w-full px-4 py-3 text-left transition-colors hover:bg-muted ${selected?.id === prompt.id ? "bg-primary/10" : ""}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-sm">{prompt.version}</span>
                  <Badge variant={statusVariant(prompt.status)}>{statusLabel(prompt.status)}</Badge>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">{new Date(prompt.updatedAt).toLocaleString("zh-CN")}</p>
              </button>
            ))}
          </div>
        </div>

        {selected ? (
          <div className="rounded-lg border border-border bg-card p-4">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div>
                <h2 className="font-semibold">{agentLabel(state, selected.agentId)}</h2>
                <p className="text-xs text-muted-foreground">支持编辑提示词，设为评测版本或线上版本。</p>
              </div>
              <Input value={selected.version} onChange={(e) => updatePrompt(selected.id, { version: e.target.value })} className="w-44 font-mono text-xs" />
            </div>
            <Textarea
              value={selected.content}
              onChange={(e) => updatePrompt(selected.id, { content: e.target.value })}
              rows={22}
              className="font-mono text-xs"
            />
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button onClick={() => save()} disabled={isPending}>
                <Save className="size-4" />
                保存草稿
              </Button>
              <Button variant="outline" onClick={() => setPromptStatus(selected.id, "eval")} disabled={isPending}>
                <FlaskConical className="size-4" />
                设为评测版本
              </Button>
              <Button variant="outline" onClick={() => setPromptStatus(selected.id, "online")} disabled={isPending}>
                <CheckCircle2 className="size-4" />
                设为线上版本
              </Button>
              {message ? <span className="text-xs text-emerald-400">{message}</span> : null}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

interface ModelEvalsApiPayload {
  strategyRevision: number;
  draftVersion: string;
  onlineVersion: string;
  agents: AgentConfig[];
  prompts: AgentPromptVersion[];
  evals: AgentEvalRecord[];
  mediaJobs: GoldenMediaEvalJobDto[];
  golden: GoldenEvalPayload;
}

type GoldenMediaEvalJobStatus =
  | "pending"
  | "submitting"
  | "submitted"
  | "polling"
  | "succeeded"
  | "failed"
  | "submission_uncertain";

interface GoldenMediaEvalJobDto {
  id: string;
  agentId: string;
  caseId: string;
  candidateRole: "primary" | "fallback";
  candidateKey: string;
  provider: string;
  model: string;
  promptVersion: string;
  strategyRevision: number;
  requestKind: "image-generation" | "video-generation" | "tts-generation";
  status: GoldenMediaEvalJobStatus;
  taskIdCheckpointed: boolean;
  pollAttempts: number;
  maxPollAttempts: number;
  errorCode: string | null;
  errorMessage: string | null;
  artifactUrls: string[];
  createdAt: string;
  startedAt: string | null;
  submittedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
  duplicate?: boolean;
}

const ACTIVE_MEDIA_JOB_STATUSES = new Set<GoldenMediaEvalJobStatus>([
  "pending",
  "submitting",
  "submitted",
  "polling",
]);

const EMPTY_GOLDEN: GoldenEvalPayload = {
  integrityPassed: false,
  integrityIssues: [],
  cases: [],
  promotions: [],
};

function readinessLabel(goldenCase: GoldenEvalCaseDto | undefined) {
  if (!goldenCase) return "未选择 case";
  return goldenCase.ready ? "已就绪" : "未就绪（不会发起付费请求）";
}

function qualityLabel(value: number | null | undefined) {
  return typeof value === "number" ? `${value.toFixed(1)} / 100` : "待评分";
}

function visibleArtifactUrl(value: string) {
  return (value.startsWith("/") && !value.startsWith("//")) || value.startsWith("https://");
}

function mediaJobStatusLabel(status: GoldenMediaEvalJobStatus) {
  if (status === "pending") return "已入队";
  if (status === "submitting") return "正在单次提交";
  if (status === "submitted") return "已持久化任务号";
  if (status === "polling") return "正在恢复轮询";
  if (status === "succeeded") return "产物已就绪";
  if (status === "submission_uncertain") return "提交结果未知（禁止重提）";
  return "失败";
}

function mediaEvalStorageKey(input: {
  agentId: AgentId;
  caseId: string;
  promptVersion: string;
  candidates: readonly ("primary" | "fallback")[];
}) {
  const fingerprint = JSON.stringify({
    agentId: input.agentId,
    caseId: input.caseId,
    promptVersion: input.promptVersion,
    candidates: [...input.candidates].sort(),
  });
  return `huimai:golden-media-operation:${encodeURIComponent(fingerprint)}`;
}

function persistentMediaOperationKey(storageKey: string) {
  try {
    const existing = window.localStorage.getItem(storageKey);
    if (existing) return existing;
    const created = window.crypto.randomUUID();
    window.localStorage.setItem(storageKey, created);
    if (window.localStorage.getItem(storageKey) !== created) throw new Error("write verification failed");
    return created;
  } catch {
    throw new Error("浏览器无法持久化评测幂等键，为避免断网后重复计费，已禁止发起媒体评测");
  }
}

function clearPersistentMediaOperationKey(storageKey: string) {
  try {
    window.localStorage.removeItem(storageKey);
  } catch {
    // 入队成功后即使清理失败，同键重放也只会返回原 job。
  }
}

function PromotionCard({ promotion }: { promotion: GoldenEvalPromotionDto }) {
  return (
    <div className="rounded-md border border-border bg-background/40 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-mono text-xs">{promotion.candidateKey}</p>
        <Badge variant={promotion.passed ? "secondary" : "outline"} className={promotion.passed ? "text-emerald-400" : "text-amber-400"}>
          {promotion.passed ? "达到晋级线" : "未达晋级线"}
        </Badge>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        {promotion.sampleCount} 次 · {promotion.distinctCaseCount} 个不同 case · 成功 {fmtPct(promotion.successRate)} · 结构 {promotion.structurePassRate === null ? "不适用" : fmtPct(promotion.structurePassRate)} · 质量 {qualityLabel(promotion.qualityScore)} · P95 {promotion.p95LatencyMs} ms
      </p>
      <p className="mt-1 text-xs text-muted-foreground">
        成本覆盖 {fmtPct(promotion.costCoverageRate)} · 平均真实成本 {promotion.averageActualCostUsd === null ? "未知（未伪造为 0）" : `$${promotion.averageActualCostUsd.toFixed(6)}`}
      </p>
      {promotion.failures.length ? <p className="mt-2 text-xs text-amber-400">{promotion.failures.join("；")}</p> : null}
    </div>
  );
}

export function ModelEvalsWorkspace() {
  const [payload, setPayload] = useState<ModelEvalsApiPayload>({
    strategyRevision: 0,
    draftVersion: "",
    onlineVersion: "",
    agents: [],
    prompts: [],
    evals: [],
    mediaJobs: [],
    golden: EMPTY_GOLDEN,
  });
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [requestError, setRequestError] = useState("");
  const [agentId, setAgentId] = useState<AgentId>("script");
  const [caseId, setCaseId] = useState("");
  const [candidates, setCandidates] = useState<Array<"primary" | "fallback">>(["primary", "fallback"]);
  const [running, setRunning] = useState(false);
  const [reviewingId, setReviewingId] = useState("");
  const [humanScores, setHumanScores] = useState<Record<string, Record<string, number | "">>>({});

  useEffect(() => {
    let alive = true;
    fetch("/api/admin/model-evals")
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || "评测数据加载失败");
        return data as ModelEvalsApiPayload;
      })
      .then((data) => {
        if (!alive) return;
        setPayload({ ...data, mediaJobs: data.mediaJobs ?? [] });
        if (!data.agents.some((agent) => agent.id === agentId) && data.agents[0]) setAgentId(data.agents[0].id);
      })
      .catch((error) => {
        if (alive) setLoadError(error instanceof Error ? error.message : "评测数据加载失败");
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => { alive = false; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const hasActiveMediaJobs = payload.mediaJobs.some((job) => ACTIVE_MEDIA_JOB_STATUSES.has(job.status));
  useEffect(() => {
    if (!hasActiveMediaJobs) return;
    let alive = true;
    let inFlight = false;
    const refresh = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const res = await fetch("/api/admin/model-evals", { cache: "no-store" });
        const data = await res.json().catch(() => ({})) as Partial<ModelEvalsApiPayload> & { error?: string };
        if (!res.ok) throw new Error(data.error || "评测任务状态加载失败");
        if (alive) setPayload(data as ModelEvalsApiPayload);
      } catch (error) {
        if (alive) setRequestError(error instanceof Error ? error.message : "评测任务状态加载失败");
      } finally {
        inFlight = false;
      }
    };
    const timer = window.setInterval(() => void refresh(), 3_000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [hasActiveMediaJobs]);

  const agent = payload.agents.find((item) => item.id === agentId) ?? payload.agents[0];
  const cases = payload.golden.cases.filter((item) => item.agentId === agentId);
  const selectedCase = cases.find((item) => item.id === caseId) ?? cases[0];
  const evals = payload.evals.filter((item) => item.agentId === agentId).slice(0, 20);
  const promotions = payload.golden.promotions.filter((item) => item.agentId === agentId);
  const mediaJobs = payload.mediaJobs.filter((item) => item.agentId === agentId).slice(0, 20);
  const selectedMediaJobs = mediaJobs.filter((job) =>
    job.caseId === selectedCase?.id && candidates.includes(job.candidateRole));
  const selectedMediaJobActive = selectedMediaJobs.some((job) => ACTIVE_MEDIA_JOB_STATUSES.has(job.status));
  const selectedMediaJobUncertain = selectedMediaJobs.some((job) =>
    job.status === "submission_uncertain"
    || (job.status === "failed" && job.taskIdCheckpointed && job.errorCode === "POLL_TIMEOUT"));

  const startEval = async () => {
    if (!agent || !selectedCase || !selectedCase.ready || candidates.length === 0) return;
    if (selectedMediaJobUncertain) {
      setRequestError("该候选存在提交结果未知或轮询超时任务，需先去供应商后台核对，为避免第二笔计费已禁止重提");
      return;
    }
    if (selectedMediaJobActive) {
      setRequestError("该候选已有持久评测任务在执行，请等待状态收敛");
      return;
    }
    setRequestError("");
    setRunning(true);
    let operationStorageKey = "";
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (selectedCase.outputKind === "media") {
        operationStorageKey = mediaEvalStorageKey({
          agentId,
          caseId: selectedCase.id,
          promptVersion: agent.promptVersion,
          candidates,
        });
        headers["Idempotency-Key"] = persistentMediaOperationKey(operationStorageKey);
      }
      const res = await fetch("/api/admin/model-evals", {
        method: "POST",
        headers,
        body: JSON.stringify({
          agentId,
          caseId: selectedCase.id,
          promptVersion: agent.promptVersion,
          candidateRoles: candidates,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (operationStorageKey && res.status < 500) clearPersistentMediaOperationKey(operationStorageKey);
        setRequestError(data.error || "评测失败");
        return;
      }
      if (selectedCase.outputKind === "media") {
        if (res.status !== 202 || !Array.isArray(data.jobs) || data.jobs.length === 0) {
          throw new Error("媒体评测入队回执不完整；已保留幂等键，请重试查询原任务");
        }
        clearPersistentMediaOperationKey(operationStorageKey);
        const acceptedJobs = data.jobs as GoldenMediaEvalJobDto[];
        setPayload((current) => {
          const acceptedIds = new Set(acceptedJobs.map((job) => job.id));
          return {
            ...current,
            mediaJobs: [...acceptedJobs, ...current.mediaJobs.filter((job) => !acceptedIds.has(job.id))],
            golden: {
              ...current.golden,
              promotions: data.golden?.promotions ?? current.golden.promotions,
            },
          };
        });
        return;
      }
      setPayload((current) => ({
        ...current,
        evals: [...(data.results as AgentEvalRecord[]), ...current.evals],
        golden: {
          ...current.golden,
          promotions: data.golden?.promotions ?? current.golden.promotions,
        },
      }));
    } catch (error) {
      setRequestError(error instanceof Error ? error.message : "评测请求失败");
    } finally {
      setRunning(false);
    }
  };

  const saveHumanReview = async (record: AgentEvalRecord) => {
    const scores = humanScores[record.id] ?? {};
    setReviewingId(record.id);
    setRequestError("");
    const res = await fetch("/api/admin/model-evals", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ evalId: record.id, scores }),
    });
    const data = await res.json().catch(() => ({}));
    setReviewingId("");
    if (!res.ok) {
      setRequestError([data.error, ...(data.issues ?? [])].filter(Boolean).join("："));
      return;
    }
    setPayload((current) => ({
      ...current,
      evals: current.evals.map((item) => item.id === record.id ? data.record : item),
      golden: {
        ...current.golden,
        promotions: data.golden?.promotions ?? current.golden.promotions,
      },
    }));
  };

  if (loading) return <LoadingPanel title="模型评测" />;
  if (loadError) return <div className="rounded-lg border border-destructive/40 p-6 text-sm text-destructive">{loadError}</div>;

  return (
    <div className="space-y-5">
      <div>
        <p className="text-sm text-muted-foreground">Golden Set 候选模型对比</p>
        <h1 className="mt-1 text-2xl font-semibold">模型评测</h1>
        <p className="mt-1 text-xs text-muted-foreground">
          只评测当前 draft 槽（{payload.draftVersion || "-"}）的 primary / fallback，每个候选独立执行，不自动 fallback。
        </p>
      </div>

      {!payload.golden.integrityPassed ? (
        <section className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
          Golden Set 完整性校验未通过：{payload.golden.integrityIssues.join("；") || "未知错误"}
        </section>
      ) : null}

      <section className="rounded-lg border border-border bg-card p-4">
        <div className="grid gap-4 lg:grid-cols-3">
          <label className="space-y-1.5 text-xs text-muted-foreground">
            选择 Agent
            <select value={agentId} onChange={(e) => { setAgentId(e.target.value as AgentId); setCaseId(""); }} className="h-8 w-full rounded-md border border-border bg-background px-2 text-sm">
              {payload.agents.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </label>
          <label className="space-y-1.5 text-xs text-muted-foreground">
            Golden case
            <select value={selectedCase?.id ?? ""} onChange={(e) => setCaseId(e.target.value)} className="h-8 w-full rounded-md border border-border bg-background px-2 text-sm">
              {cases.map((item) => <option key={item.id} value={item.id}>{item.ready ? "●" : "○"} {item.name}</option>)}
            </select>
          </label>
          <div className="space-y-1.5 text-xs text-muted-foreground">
            draft 候选槽
            <div className="flex h-8 items-center gap-3">
              {(["primary", "fallback"] as const).map((name) => (
                <label key={name} className="flex items-center gap-1.5 text-sm text-foreground">
                  <input
                    type="checkbox"
                    checked={candidates.includes(name)}
                    onChange={(e) =>
                      setCandidates((items) => e.target.checked ? [...items, name] : items.filter((item) => item !== name))
                    }
                  />
                  {name === "primary" ? "primary" : "fallback"}
                </label>
              ))}
            </div>
          </div>
        </div>
        <div className="mt-4 rounded-md border border-border bg-background/40 p-3 text-xs">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={selectedCase?.ready ? "secondary" : "outline"} className={selectedCase?.ready ? "text-emerald-400" : "text-amber-400"}>
              {readinessLabel(selectedCase)}
            </Badge>
            <span className="font-mono text-muted-foreground">{selectedCase?.requestKind ?? "-"}</span>
            <span className="text-muted-foreground">prompt {agent?.promptVersion ?? "-"}</span>
          </div>
          <p className="mt-2 text-muted-foreground">{selectedCase?.readinessReason ?? "该 Agent 暂无 Golden case"}</p>
          {selectedCase?.fixtures.map((fixture) => (
            <p key={fixture.fixtureId} className={fixture.ready ? "mt-1 text-emerald-400" : "mt-1 text-amber-400"}>
              fixture {fixture.fixtureId}：{fixture.reason}
            </p>
          ))}
          <div className="mt-3 grid gap-2 md:grid-cols-2">
            {(["primary", "fallback"] as const).map((role) => (
              <p key={role} className="font-mono text-muted-foreground">
                {role}: {agent ? `${agent[role].provider}/${selectedCase?.requestKind === "vision-json" ? agent[role].visionModel || agent[role].model : agent[role].model}` : "-"}
                {agent?.[role].secretConfigured ? " · 凭据已配置" : " · 凭据未配置"}
              </p>
            ))}
          </div>
          {selectedMediaJobUncertain ? (
            <p className="mt-3 text-destructive">存在计费结果待核对任务：请先核对供应商后台，本页不会自动或手动重提。</p>
          ) : null}
          <Button
            onClick={startEval}
            disabled={running
              || candidates.length === 0
              || !selectedCase?.ready
              || !payload.golden.integrityPassed
              || selectedMediaJobActive
              || selectedMediaJobUncertain}
            className="mt-3 w-full md:w-auto"
          >
            <FlaskConical className="size-4" />
            {running ? "正在入队" : selectedMediaJobActive ? "持久任务执行中" : "执行锁定 Golden case"}
          </Button>
        </div>
      </section>

      {requestError ? (
        <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">{requestError}</div>
      ) : null}

      {mediaJobs.length ? (
        <section className="space-y-3 rounded-lg border border-border bg-card p-4">
          <div>
            <h2 className="text-sm font-semibold">媒体评测持久任务</h2>
            <p className="mt-1 text-xs text-muted-foreground">提交与轮询已从 HTTP 请求分离；页面关闭或服务重启后仍可恢复查询。</p>
          </div>
          <div className="grid gap-3 xl:grid-cols-2">
            {mediaJobs.map((job) => {
              const uncertain = job.status === "submission_uncertain"
                || (job.status === "failed" && job.taskIdCheckpointed && job.errorCode === "POLL_TIMEOUT");
              const failed = job.status === "failed";
              const succeeded = job.status === "succeeded";
              return (
                <div key={job.id} className={`rounded-md border p-3 ${uncertain ? "border-destructive/60 bg-destructive/5" : "border-border bg-background/40"}`}>
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <p className="font-mono text-xs">{job.provider}/{job.model}</p>
                      <p className="mt-1 text-xs text-muted-foreground">{job.caseId} · {job.candidateRole} · {new Date(job.createdAt).toLocaleString("zh-CN")}</p>
                    </div>
                    <Badge
                      variant={uncertain || failed ? "destructive" : succeeded ? "secondary" : "outline"}
                      className={succeeded ? "text-emerald-400" : ""}
                    >
                      {mediaJobStatusLabel(job.status)}
                    </Badge>
                  </div>
                  <p className="mt-2 text-xs text-muted-foreground">
                    {job.requestKind === "tts-generation"
                      ? "TTS one-shot（无 taskId，仅执行一次）"
                      : `taskId ${job.taskIdCheckpointed ? "已安全持久化" : "尚未持久化"} · 轮询 ${job.pollAttempts}/${job.maxPollAttempts}`}
                  </p>
                  {job.errorMessage ? <p className={`mt-2 text-xs ${uncertain || failed ? "text-destructive" : "text-amber-400"}`}>{job.errorCode ? `${job.errorCode}：` : ""}{job.errorMessage}</p> : null}
                  {uncertain ? (
                    <p className="mt-2 text-xs font-medium text-destructive">此状态不能证明供应商未收费或任务未完成，系统已禁止该候选重提。</p>
                  ) : null}
                </div>
              );
            })}
          </div>
        </section>
      ) : null}

      <section className="space-y-3 rounded-lg border border-border bg-card p-4">
        <div>
          <h2 className="text-sm font-semibold">候选晋级汇总</h2>
          <p className="mt-1 text-xs text-muted-foreground">按 Agent + candidateKey 聚合；真实成本缺失时保持未知，不以 0 填充。</p>
        </div>
        <div className="grid gap-3 xl:grid-cols-2">
          {promotions.map((promotion) => <PromotionCard key={promotion.candidateKey} promotion={promotion} />)}
          {!promotions.length ? <p className="text-xs text-muted-foreground">还没有足够的 Golden 评测记录。</p> : null}
        </div>
      </section>

      <section className="grid gap-4 xl:grid-cols-2">
        {evals.map((item) => {
          const itemCase = payload.golden.cases.find((goldenCase) => goldenCase.id === item.caseId);
          const needsHumanReview = item.status === "awaiting-human-review" && itemCase?.outputKind === "media";
          return (
          <div key={item.id} className="rounded-lg border border-border bg-card p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="font-mono text-sm">{item.provider}/{item.candidateModel}</p>
                <p className="mt-1 text-xs text-muted-foreground">{item.caseId || item.testCase} · {item.candidateRole || "legacy"} · {item.latencyMs} ms · {new Date(item.createdAt).toLocaleString("zh-CN")}</p>
              </div>
              <div className="flex gap-1">
                <Badge variant={item.errored ? "destructive" : "secondary"}>{item.errored ? "报错" : "完成"}</Badge>
                <Badge variant={item.structurePassed ? "secondary" : "outline"} className={item.structurePassed ? "text-emerald-400" : ""}>
                  {item.requestKind?.endsWith("json") ? `结构 ${item.structurePassed ? "通过" : "失败"}` : item.status === "awaiting-human-review" ? "待人工评审" : "媒体"}
                </Badge>
              </div>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2 rounded-md bg-muted/30 p-3 text-xs text-muted-foreground">
              <span>质量分：{qualityLabel(item.qualityScore)}</span>
              <span>真实成本：{item.actualCostUsd === null || item.actualCostUsd === undefined ? "未知" : `$${item.actualCostUsd.toFixed(6)}`}</span>
              <span className="col-span-2 font-mono">{item.candidateKey || "legacy record"}</span>
            </div>
            <pre className="mt-3 max-h-64 overflow-auto rounded-md bg-muted/40 p-3 text-xs whitespace-pre-wrap">{item.output}</pre>
            {item.artifactUrls?.some(visibleArtifactUrl) ? (
              <div className="mt-3 flex flex-wrap gap-2 text-xs">
                {item.artifactUrls.filter(visibleArtifactUrl).map((url, index) => <a key={`${url}-${index}`} href={url} target="_blank" rel="noreferrer" className="text-primary underline">审核产物 {index + 1}</a>)}
              </div>
            ) : null}
            {needsHumanReview && itemCase ? (
              <div className="mt-3 space-y-3 border-t border-border pt-3">
                <p className="text-xs font-medium">媒体人工 rubric（1-5 分，所有项必填）</p>
                {itemCase.rubric.map((criterion) => (
                  <label key={criterion.id} className="block space-y-1 text-xs text-muted-foreground">
                    {criterion.label} · 权重 {criterion.weight}%
                    <p>{criterion.guidance}</p>
                    <Input
                      type="number"
                      min="1"
                      max="5"
                      step="1"
                      value={humanScores[item.id]?.[criterion.id] ?? ""}
                      onChange={(event) => setHumanScores((current) => ({
                        ...current,
                        [item.id]: {
                          ...current[item.id],
                          [criterion.id]: event.target.value ? Number(event.target.value) : "",
                        },
                      }))}
                      className="h-8 w-24"
                    />
                  </label>
                ))}
                <Button size="sm" variant="outline" onClick={() => saveHumanReview(item)} disabled={reviewingId === item.id}>
                  <Save className="size-3.5" />
                  {reviewingId === item.id ? "保存中" : "保存 rubric 评分"}
                </Button>
              </div>
            ) : null}
          </div>
          );
        })}
        {evals.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground xl:col-span-2">
            暂无评测记录，选择已就绪 Golden case 和 draft 候选槽后开始。
          </div>
        ) : null}
      </section>
    </div>
  );
}

export function RunsWorkspace() {
  const { state, loading, loadError } = useStrategyState("/api/admin/runs");
  const [agentId, setAgentId] = useState<"all" | AgentId>("all");
  const [status, setStatus] = useState<"all" | "success" | "failed">("all");
  const [fallback, setFallback] = useState<"all" | "yes" | "no">("all");
  const [query, setQuery] = useState("");

  const runs = useMemo(() => {
    return state.runs.filter((run) => {
      if (agentId !== "all" && run.agentId !== agentId) return false;
      if (status === "success" && !run.success) return false;
      if (status === "failed" && run.success) return false;
      if (fallback === "yes" && !run.fallbackTriggered) return false;
      if (fallback === "no" && run.fallbackTriggered) return false;
      if (query && !`${run.agentName}${run.provider}${run.model}${run.userLabel}`.toLowerCase().includes(query.toLowerCase())) return false;
      return true;
    });
  }, [agentId, fallback, query, state.runs, status]);

  if (loading) return <LoadingPanel title="生成记录" />;
  if (loadError) return <div className="rounded-lg border border-destructive/40 p-6 text-sm text-destructive">{loadError}</div>;

  return (
    <div className="space-y-5">
      <div>
        <p className="text-sm text-muted-foreground">可追溯调用链</p>
        <h1 className="mt-1 text-2xl font-semibold">生成记录</h1>
      </div>

      <section className="rounded-lg border border-border bg-card p-4">
        <div className="grid gap-3 md:grid-cols-4">
          <select value={agentId} onChange={(e) => setAgentId(e.target.value as "all" | AgentId)} className="h-8 rounded-md border border-border bg-background px-2 text-sm">
            <option value="all">全部 Agent</option>
            {state.agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
          </select>
          <select value={status} onChange={(e) => setStatus(e.target.value as "all" | "success" | "failed")} className="h-8 rounded-md border border-border bg-background px-2 text-sm">
            <option value="all">全部状态</option>
            <option value="success">成功</option>
            <option value="failed">失败</option>
          </select>
          <select value={fallback} onChange={(e) => setFallback(e.target.value as "all" | "yes" | "no")} className="h-8 rounded-md border border-border bg-background px-2 text-sm">
            <option value="all">全部 fallback</option>
            <option value="yes">触发 fallback</option>
            <option value="no">未触发 fallback</option>
          </select>
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索 provider/model" className="pl-8" />
          </div>
        </div>
      </section>

      <section className="rounded-lg border border-border bg-card">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1020px] text-sm">
            <thead className="text-left text-xs text-muted-foreground">
              <tr className="border-b border-border">
                <th className="px-4 py-3 font-medium">时间</th>
                <th className="px-4 py-3 font-medium">请求/项目</th>
                <th className="px-4 py-3 font-medium">agent</th>
                <th className="px-4 py-3 font-medium">实际 provider/model</th>
                <th className="px-4 py-3 font-medium">fallback</th>
                <th className="px-4 py-3 font-medium">状态</th>
                <th className="px-4 py-3 font-medium">失败原因</th>
                <th className="px-4 py-3 font-medium">耗时</th>
                <th className="px-4 py-3 font-medium">真实成本</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run: AgentRunRecord) => (
                <tr key={run.id} className="border-b border-border/70 last:border-0">
                  <td className="px-4 py-3 text-xs text-muted-foreground">{new Date(run.createdAt).toLocaleString("zh-CN")}</td>
                  <td className="px-4 py-3 font-mono text-xs">
                    <div>{run.userLabel}</div>
                    <div className="mt-1 text-[10px] text-muted-foreground">{run.requestId} · attempt {run.attempt}</div>
                  </td>
                  <td className="px-4 py-3">{run.agentName}</td>
                  <td className="px-4 py-3 font-mono text-xs">
                    <div>{run.provider}/{run.model}</div>
                    <div className="mt-1 text-[10px] text-muted-foreground">{run.endpointRole} · r{run.strategyRevision} · {run.codeVersion}</div>
                  </td>
                  <td className="px-4 py-3">
                    <Badge variant={run.fallbackTriggered ? "outline" : "ghost"}>{run.fallbackTriggered ? "是" : "否"}</Badge>
                  </td>
                  <td className="px-4 py-3">
                    <Badge variant={run.success ? "secondary" : "destructive"} className={run.success ? "text-emerald-400" : ""}>
                      {run.success ? "成功" : "失败"}
                    </Badge>
                  </td>
                  <td className="max-w-64 px-4 py-3 text-xs text-destructive">
                    {run.errorCategory ? <div className="mb-1 font-mono text-[10px]">{run.errorCategory}</div> : null}
                    {run.errorReason || run.fallbackReason || "-"}
                  </td>
                  <td className="px-4 py-3">{run.latencyMs} ms</td>
                  <td className="px-4 py-3">{run.costUsd == null ? "未知" : `$${run.costUsd.toFixed(4)}`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {runs.length === 0 ? <div className="p-8 text-center text-sm text-muted-foreground">没有匹配的生成记录</div> : null}
      </section>
    </div>
  );
}
