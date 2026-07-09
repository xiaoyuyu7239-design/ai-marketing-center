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

const EMPTY_STATE: AgentStrategyState = {
  onlineVersion: "",
  draftVersion: "",
  publishedAt: "",
  agents: [],
  prompts: [],
  runs: [],
  evals: [],
};

function mergeState(current: AgentStrategyState, patch: Partial<AgentStrategyState>): AgentStrategyState {
  return {
    onlineVersion: patch.onlineVersion ?? current.onlineVersion,
    draftVersion: patch.draftVersion ?? current.draftVersion,
    publishedAt: patch.publishedAt ?? current.publishedAt,
    agents: patch.agents ?? current.agents,
    prompts: patch.prompts ?? current.prompts,
    runs: patch.runs ?? current.runs,
    evals: patch.evals ?? current.evals,
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
          API Key
          <Input value={endpoint.apiKey} onChange={(e) => onChange({ apiKey: e.target.value })} className="font-mono text-xs" />
        </label>
        <label className="space-y-1.5 text-xs text-muted-foreground sm:col-span-2">
          visionModel
          <Input value={endpoint.visionModel ?? ""} onChange={(e) => onChange({ visionModel: e.target.value || undefined })} className="font-mono text-xs" />
        </label>
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
        setMessage("保存失败");
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
      const res = await fetch("/api/admin/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId, action: actionName }),
      });
      if (!res.ok) {
        setMessage(actionName === "publish" ? "发布失败" : "回滚失败");
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
        agents: state.agents.map((agent) =>
          agent.id === selected.id ? { ...agent, previous: { ...agent, previous: undefined }, updatedAt: new Date().toISOString() } : agent,
        ),
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

const TEST_CASES = [
  "给一款无线降噪耳机生成 20 秒短视频脚本，要求输出 JSON。",
  "围绕“夏天通勤如何防晒”生成一句话主题成片脚本，输出 JSON。",
  "为一款轻食代餐奶昔生成小红书发布标题、标签和文案，输出 JSON。",
];

export function ModelEvalsWorkspace() {
  const { state, setState, save, message, loading, loadError, isPending } = useStrategyState("/api/admin/model-evals");
  const [agentId, setAgentId] = useState<AgentId>(state.agents[0]?.id ?? "script");
  const agent = state.agents.find((item) => item.id === agentId) ?? state.agents[0];
  const promptVersions = state.prompts.filter((prompt) => prompt.agentId === agentId);
  const [promptVersion, setPromptVersion] = useState(promptVersions[0]?.version ?? agent?.promptVersion ?? "");
  const effectivePromptVersion = promptVersion || promptVersions[0]?.version || agent?.promptVersion || "";
  const [testCase, setTestCase] = useState(TEST_CASES[0]);
  const [candidates, setCandidates] = useState<string[]>(["primary", "fallback"]);
  const [running, setRunning] = useState(false);

  const evals = state.evals.filter((item) => item.agentId === agentId).slice(0, 12);

  const startEval = async () => {
    setRunning(true);
    const res = await fetch("/api/admin/model-evals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId, promptVersion: effectivePromptVersion, testCase, candidates }),
    });
    setRunning(false);
    if (!res.ok) return;
    const data = await res.json();
    setState({ ...state, evals: [...(data.results as AgentEvalRecord[]), ...state.evals] });
  };

  const updateScore = (id: string, score: number) => {
    setState({ ...state, evals: state.evals.map((item) => item.id === id ? { ...item, score } : item) });
  };

  if (loading) return <LoadingPanel title="模型评测" />;
  if (loadError) return <div className="rounded-lg border border-destructive/40 p-6 text-sm text-destructive">{loadError}</div>;

  return (
    <div className="space-y-5">
      <div>
        <p className="text-sm text-muted-foreground">模型对比</p>
        <h1 className="mt-1 text-2xl font-semibold">模型评测</h1>
      </div>

      <section className="rounded-lg border border-border bg-card p-4">
        <div className="grid gap-4 lg:grid-cols-4">
          <label className="space-y-1.5 text-xs text-muted-foreground">
            选择 Agent
            <select value={agentId} onChange={(e) => { setAgentId(e.target.value as AgentId); setPromptVersion(""); }} className="h-8 w-full rounded-md border border-border bg-background px-2 text-sm">
              {state.agents.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </label>
          <label className="space-y-1.5 text-xs text-muted-foreground">
            prompt 版本
            <select value={effectivePromptVersion} onChange={(e) => setPromptVersion(e.target.value)} className="h-8 w-full rounded-md border border-border bg-background px-2 text-sm">
              {promptVersions.map((prompt) => <option key={prompt.id} value={prompt.version}>{prompt.version}</option>)}
            </select>
          </label>
          <div className="space-y-1.5 text-xs text-muted-foreground">
            候选模型
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
                  {name === "primary" ? "主模型" : "备用模型"}
                </label>
              ))}
            </div>
          </div>
          <div className="flex items-end">
            <Button onClick={startEval} disabled={running || candidates.length === 0} className="w-full">
              <FlaskConical className="size-4" />
              {running ? "评测中" : "开始评测"}
            </Button>
          </div>
        </div>
        <div className="mt-4 grid gap-3 lg:grid-cols-[260px_1fr]">
          <label className="space-y-1.5 text-xs text-muted-foreground">
            测试样例
            <select value={testCase} onChange={(e) => setTestCase(e.target.value)} className="h-8 w-full rounded-md border border-border bg-background px-2 text-sm">
              {TEST_CASES.map((item) => <option key={item} value={item}>{item.slice(0, 22)}...</option>)}
            </select>
          </label>
          <label className="space-y-1.5 text-xs text-muted-foreground">
            样例内容
            <Textarea value={testCase} onChange={(e) => setTestCase(e.target.value)} rows={3} className="text-sm" />
          </label>
        </div>
      </section>

      <section className="grid gap-4 xl:grid-cols-2">
        {evals.map((item) => (
          <div key={item.id} className="rounded-lg border border-border bg-card p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="font-mono text-sm">{item.provider}/{item.candidateModel}</p>
                <p className="mt-1 text-xs text-muted-foreground">{item.promptVersion} · {item.latencyMs} ms · {new Date(item.createdAt).toLocaleString("zh-CN")}</p>
              </div>
              <div className="flex gap-1">
                <Badge variant={item.errored ? "destructive" : "secondary"}>{item.errored ? "报错" : "完成"}</Badge>
                <Badge variant={item.jsonParsed ? "secondary" : "outline"} className={item.jsonParsed ? "text-emerald-400" : ""}>
                  JSON {item.jsonParsed ? "成功" : "失败"}
                </Badge>
              </div>
            </div>
            <pre className="mt-3 max-h-64 overflow-auto rounded-md bg-muted/40 p-3 text-xs whitespace-pre-wrap">{item.output}</pre>
            <div className="mt-3 flex items-center justify-between gap-3">
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                人工打分
                <Input
                  type="number"
                  min="0"
                  max="10"
                  value={item.score ?? ""}
                  onChange={(e) => updateScore(item.id, Number(e.target.value))}
                  className="h-7 w-20"
                />
              </label>
              <Button size="sm" variant="outline" onClick={() => save()} disabled={isPending}>
                <Save className="size-3.5" />
                保存分数
              </Button>
            </div>
          </div>
        ))}
        {evals.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground xl:col-span-2">
            暂无评测记录，选择 Agent 和候选模型后开始评测。
          </div>
        ) : null}
      </section>
      {message ? <p className="text-xs text-emerald-400">{message}</p> : null}
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
                <th className="px-4 py-3 font-medium">用户/项目</th>
                <th className="px-4 py-3 font-medium">agent</th>
                <th className="px-4 py-3 font-medium">实际 provider/model</th>
                <th className="px-4 py-3 font-medium">fallback</th>
                <th className="px-4 py-3 font-medium">状态</th>
                <th className="px-4 py-3 font-medium">失败原因</th>
                <th className="px-4 py-3 font-medium">耗时</th>
                <th className="px-4 py-3 font-medium">成本估算</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run: AgentRunRecord) => (
                <tr key={run.id} className="border-b border-border/70 last:border-0">
                  <td className="px-4 py-3 text-xs text-muted-foreground">{new Date(run.createdAt).toLocaleString("zh-CN")}</td>
                  <td className="px-4 py-3 font-mono text-xs">{run.userLabel}</td>
                  <td className="px-4 py-3">{run.agentName}</td>
                  <td className="px-4 py-3 font-mono text-xs">{run.provider}/{run.model}</td>
                  <td className="px-4 py-3">
                    <Badge variant={run.fallbackTriggered ? "outline" : "ghost"}>{run.fallbackTriggered ? "是" : "否"}</Badge>
                  </td>
                  <td className="px-4 py-3">
                    <Badge variant={run.success ? "secondary" : "destructive"} className={run.success ? "text-emerald-400" : ""}>
                      {run.success ? "成功" : "失败"}
                    </Badge>
                  </td>
                  <td className="max-w-64 px-4 py-3 text-xs text-destructive">{run.errorReason || "-"}</td>
                  <td className="px-4 py-3">{run.latencyMs} ms</td>
                  <td className="px-4 py-3">${run.costEstimateUsd.toFixed(4)}</td>
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
