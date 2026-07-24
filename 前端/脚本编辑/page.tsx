"use client";

import { useState, useEffect, useMemo, useRef } from "react";
import { useParams, useRouter } from "next/navigation";
import { LuWand, LuClock, LuImage, LuArrowRight, LuBookmarkPlus, LuLoaderCircle, LuTriangleAlert, LuCircleCheck, LuCircleX, LuPencil } from "react-icons/lu";
import { checkScriptCompliance } from "@backend/core/publish/ad-compliance";
import { checkPublishReadiness } from "@backend/core/publish/publish-readiness";
import Link from "next/link";
import { Card, CardContent } from "@frontend/components/ui/card";
import { Button } from "@frontend/components/ui/button";
import { Badge } from "@frontend/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@frontend/components/ui/tabs";
import { Textarea } from "@frontend/components/ui/textarea";
import { Input } from "@frontend/components/ui/input";
import type { Shot } from "@backend/db/schema";
import { useTemplateStore } from "@frontend/stores/template-store";
import { useT, useLocale } from "@frontend/i18n";
import { friendlyError } from "@backend/shared/friendly-error";
import { LanguageToggle } from "@frontend/components/language-toggle";
import { BrandWheatMark } from "@frontend/components/brand-wheat-logo";
import { SHOT_TYPE_INFO, STYLE_LABEL_KEYS } from "@backend/shared/shot-constants";
import { StepProgressIndicator } from "@frontend/components/step-progress";
import { pollComposition } from "@backend/shared/poll-composition";
import { acquireComposeOperation, clearComposeOperation } from "@frontend/lib/compose-operation";
import {
  parseStoredAgentGenerationSettings,
  projectAgentGenerationSettingsKey,
} from "@backend/core/agent/agent-generation-settings";

// 后端 scripts 表返回的脚本结构
interface DbScript {
  id: string;
  title: string | null;
  styleType: string;
  totalDuration: number | null;
  shots: Shot[];
  selected: boolean | null;
}

export default function ScriptPage() {
  const t = useT("script");
  const tc = useT("common");
  const locale = useLocale();
  const tRef = useRef(t);
  tRef.current = t;
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const workflowStepHrefs = [`/project/${id}/script`, `/project/${id}/assets`, `/project/${id}/motion`, `/project/${id}/video`, `/project/${id}/export`];
  const [selectedScript, setSelectedScript] = useState(0);
  // AI 超时降级成模板时，工作台会把 warning 存进 sessionStorage——如实展示，别让老板把罐头模板当 AI 成稿
  const [fallbackWarning, setFallbackWarning] = useState<string | null>(null);
  useEffect(() => {
    setFallbackWarning(window.sessionStorage?.getItem(`clipforge_script_warning:${id}`) ?? null);
  }, [id]);
  const [scripts, setScripts] = useState<
    { id: string; title: string; styleType: string; totalDuration: number; shots: Shot[] }[]
  >([]);
  const [loading, setLoading] = useState(true);
  const [projectName, setProjectName] = useState("");
  // 项目元信息：空态「重新生成脚本」时复用
  const [projectMeta, setProjectMeta] = useState<{
    productName: string;
    category: string;
    description: string;
    productImages: string[];
    videoMode: string;
    contentType: string;
    topic: string;
  } | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [genError, setGenError] = useState("");

  // 按 projectId 拉取真实脚本（落库于 scripts 表）
  const loadScripts = async () => {
    setLoading(true);
    try {
      const [scriptsRes, projectRes] = await Promise.all([
        fetch(`/api/project/${id}/scripts`),
        fetch(`/api/project/${id}`),
      ]);
      const dbScripts: DbScript[] = scriptsRes.ok ? await scriptsRes.json() : [];
      if (projectRes.ok) {
        const proj = await projectRes.json();
        setProjectName(proj.name ?? proj.productName ?? "");
        setProjectMeta({
          productName: proj.productName ?? "",
          category: proj.productCategory ?? "",
          description: proj.productDescription ?? "",
          productImages: Array.isArray(proj.productImages) ? proj.productImages : [],
          videoMode: proj.videoMode ?? "product_closeup",
          contentType: proj.contentType ?? "product",
          topic: proj.topic ?? "",
        });
      }
      if (Array.isArray(dbScripts) && dbScripts.length > 0) {
        setScripts(
          dbScripts.map((s) => ({
            id: s.id,
            title: s.title ?? tRef.current("untitledScript"),
            styleType: s.styleType,
            totalDuration: s.totalDuration ?? 0,
            shots: s.shots ?? [],
          }))
        );
        const selIdx = dbScripts.findIndex((s) => s.selected);
        setSelectedScript(selIdx >= 0 ? selIdx : 0);
      } else {
        // 无真实脚本：保持空，由渲染层显示「去生成」空态
        // （修复 issue #3：旧逻辑回退到德宝示例数据，导致用户进自己项目却看到别人的 demo，
        //  误以为「找不到我自己创建的任务」）
        setScripts([]);
      }
    } catch {
      setScripts([]);
    } finally {
      setLoading(false);
    }
  };

  // 空态点击「生成脚本」：topic 主题项目走去商品化脚本引擎，带货项目走商品脚本引擎
  const handleGenerate = async () => {
    if (!projectMeta) return;
    setIsGenerating(true);
    setGenError("");
    try {
      const isTopic = projectMeta.contentType === "topic";
      const savedSettings = parseStoredAgentGenerationSettings(
        typeof window !== "undefined" ? window.localStorage?.getItem(projectAgentGenerationSettingsKey(id)) : null
      );
      const targetDuration = savedSettings?.targetDuration ?? (isTopic ? 25 : 30);
      // topic 项目用 /api/topic/script（无需商品）；否则用带货脚本引擎
      const endpoint = isTopic ? "/api/topic/script" : "/api/llm/script";
      const payload = isTopic
        ? {
            projectId: id,
            topic: projectMeta.topic || projectName,
            targetDuration,
          }
        : {
            projectId: id,
            productName: projectMeta.productName,
            category: projectMeta.category,
            productDescription: projectMeta.description,
            targetDuration,
            // 脚本输出语言跟随界面语言（英文品名的商品在中文用户这里也该出中文脚本）
            locale,
            // 沿用老板在工作台"更多设置"里点选的内容方向，而不是写死 auto 丢掉他的选择
            styleType: savedSettings?.styleType ?? "auto",
            videoMode: projectMeta.videoMode,
            productImages: projectMeta.productImages,
            timeoutMs: 60000,
            maxTokens: 5000,
          };
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error(e.error || t("errorGenFailedCheckLlm"));
      }
      // 重新生成结果如实同步兜底状态：真 AI 成功则清掉旧警告，仍是模板兜底则更新提示
      const regenData = await res.clone().json().catch(() => ({} as { warning?: string }));
      if (regenData?.warning) {
        window.sessionStorage?.setItem(`clipforge_script_warning:${id}`, String(regenData.warning));
        setFallbackWarning(String(regenData.warning));
      } else {
        window.sessionStorage?.removeItem(`clipforge_script_warning:${id}`);
        setFallbackWarning(null);
      }
      await loadScripts();
    } catch (err) {
      setGenError(friendlyError(err, locale));
    } finally {
      setIsGenerating(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const [scriptsRes, projectRes] = await Promise.all([
          fetch(`/api/project/${id}/scripts`),
          fetch(`/api/project/${id}`),
        ]);
        const dbScripts: DbScript[] = scriptsRes.ok ? await scriptsRes.json() : [];
        if (projectRes.ok) {
          const proj = await projectRes.json();
          if (!cancelled) {
            setProjectName(proj.name ?? proj.productName ?? "");
            setProjectMeta({
              productName: proj.productName ?? "",
              category: proj.productCategory ?? "",
              description: proj.productDescription ?? "",
              productImages: Array.isArray(proj.productImages) ? proj.productImages : [],
              videoMode: proj.videoMode ?? "product_closeup",
              contentType: proj.contentType ?? "product",
              topic: proj.topic ?? "",
            });
          }
        }
        if (cancelled) return;
        if (Array.isArray(dbScripts) && dbScripts.length > 0) {
          setScripts(
            dbScripts.map((s) => ({
              id: s.id,
              title: s.title ?? tRef.current("untitledScript"),
              styleType: s.styleType,
              totalDuration: s.totalDuration ?? 0,
              shots: s.shots ?? [],
            }))
          );
          // 默认选中已标记 selected 的方案
          const selIdx = dbScripts.findIndex((s) => s.selected);
          setSelectedScript(selIdx >= 0 ? selIdx : 0);
        } else {
          // 无真实脚本：保持空，由渲染层显示「去生成」空态
          // （修复 issue #3：旧逻辑回退到德宝示例数据，导致用户进自己项目却看到别人的 demo，
          //  误以为「找不到我自己创建的任务」）
          setScripts([]);
        }
      } catch {
        if (!cancelled) setScripts([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  const currentScript = scripts[selectedScript];
  // 出片前广告法合规扫描：对当前脚本旁白+贴片做规则校验，命中风险词则警示（不拦截）
  const adViolations = useMemo(
    () => (currentScript ? checkScriptCompliance(currentScript.shots as { voiceover?: string; textOverlay?: { text?: string } | null }[]) : []),
    [currentScript]
  );
  // 发布前限流自检：违禁词/钩子/时长/字幕/CTA/三段式 逐项体检（AIGC 标签项交由合成页，这里不检）
  const readiness = useMemo(
    () => (currentScript ? checkPublishReadiness(currentScript.shots as Shot[], currentScript.totalDuration, { locale }) : null),
    [currentScript, locale]
  );

  // 模板相关状态
  const { addTemplate } = useTemplateStore();
  const [showSaveDialog, setShowSaveDialog] = useState(false);
  const [templateName, setTemplateName] = useState("");
  // 重新生成会删库重建（route 先 delete 旧脚本），不可恢复——已有脚本时先二次确认，防误点丢稿
  const [regenConfirmOpen, setRegenConfirmOpen] = useState(false);
  const [savedTip, setSavedTip] = useState(false);
  const [memoryStatus, setMemoryStatus] = useState<"" | "saving" | "saved" | "failed">("");

  /** 点击"存为模板"按钮 */
  const handleSaveAsTemplate = () => {
    setTemplateName("");
    setShowSaveDialog(true);
  };

  /** 确认保存模板 */
  const doSaveTemplate = () => {
    if (!templateName.trim() || !currentScript) return;
    addTemplate({
      id: crypto.randomUUID(),
      name: templateName.trim(),
      styleType: currentScript.styleType,
      shots: currentScript.shots as Shot[],
      totalDuration: currentScript.totalDuration,
      useCount: 0,
      createdAt: new Date(),
    });
    setShowSaveDialog(false);
    setSavedTip(true);
    setTimeout(() => setSavedTip(false), 3000);
  };

  /** 记住当前满意脚本风格：后端会在下次生成时自动注入店铺习惯 */
  const rememberCurrentStyle = async () => {
    if (!currentScript || memoryStatus === "saving") return;
    setMemoryStatus("saving");
    try {
      const res = await fetch("/api/memory/store", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "learn-script", projectId: id, scriptId: currentScript.id }),
      });
      if (!res.ok) throw new Error("learn failed");
      setMemoryStatus("saved");
      setTimeout(() => setMemoryStatus(""), 2200);
    } catch {
      setMemoryStatus("failed");
      setTimeout(() => setMemoryStatus(""), 2600);
    }
  };

  const [selectionTip, setSelectionTip] = useState(false);
  const persistSelection = async (index: number) => {
    setSelectedScript(index);
    const target = scripts[index];
    if (!target) return;
    try {
      await fetch(`/api/project/${id}/scripts`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ selectedScriptId: target.id }),
      });
      setSelectionTip(true);
      setTimeout(() => setSelectionTip(false), 1500);
    } catch {
      // 本地已经切换；下游若仍读旧选择，用户还可再次点击。
    }
  };

  const [editingShotId, setEditingShotId] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState({ voiceover: "", description: "" });
  const [editStatus, setEditStatus] = useState<"" | "saving" | "saved" | "failed">("");
  const startEditShot = (shot: Shot) => {
    setEditingShotId(shot.shotId);
    setEditDraft({ voiceover: shot.voiceover ?? "", description: shot.description ?? "" });
    setEditStatus("");
  };
  const cancelEditShot = () => {
    setEditingShotId(null);
    setEditStatus("");
  };
  const saveEditShot = async (shotId: number) => {
    if (!currentScript) return;
    setEditStatus("saving");
    setScripts((prev) =>
      prev.map((script) =>
        script.id === currentScript.id
          ? {
              ...script,
              shots: script.shots.map((shot) =>
                shot.shotId === shotId
                  ? { ...shot, voiceover: editDraft.voiceover.trim(), description: editDraft.description.trim() }
                  : shot
              ),
            }
          : script
      )
    );
    try {
      const res = await fetch(`/api/project/${id}/scripts`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scriptId: currentScript.id,
          shotTexts: [{ shotId, voiceover: editDraft.voiceover, description: editDraft.description }],
        }),
      });
      if (!res.ok) throw new Error("save failed");
      setEditStatus("saved");
      setEditingShotId(null);
      setTimeout(() => setEditStatus(""), 1500);
    } catch {
      setEditStatus("failed");
    }
  };

  const [autoFinishing, setAutoFinishing] = useState(false);
  const [autoFinishStage, setAutoFinishStage] = useState("");
  const [autoFinishError, setAutoFinishError] = useState("");
  const autoFinish = async () => {
    if (!currentScript || autoFinishing) return;
    setAutoFinishing(true);
    setAutoFinishError("");
    try {
      setAutoFinishStage(t("autoFinishSelecting"));
      await fetch(`/api/project/${id}/scripts`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ selectedScriptId: currentScript.id }),
      }).catch(() => {});

      setAutoFinishStage(t("autoFinishAssets"));
      await fetch(`/api/project/${id}/stock-fill`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: "all", mediaType: "auto" }),
      }).catch(() => {});

      const savedSettings = parseStoredAgentGenerationSettings(
        typeof window !== "undefined" ? window.localStorage?.getItem(projectAgentGenerationSettingsKey(id)) : null
      );
      setAutoFinishStage(t("autoFinishComposing"));
      const composePayload = {
        freeTts: { enabled: true },
        ...(savedSettings?.renderPreset && { renderPreset: savedSettings.renderPreset }),
        ...(savedSettings?.resolution && { resolution: savedSettings.resolution }),
        ...(savedSettings?.aspectRatio && { aspectRatio: savedSettings.aspectRatio }),
      };
      const composeOperation = acquireComposeOperation(id, "script-auto-finish", composePayload);
      const composeRes = await fetch(`/api/project/${id}/compose`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": composeOperation.idempotencyKey,
        },
        body: JSON.stringify(composePayload),
      });
      if (!composeRes.ok) {
        clearComposeOperation(composeOperation);
        throw new Error(t("autoFinishFailed"));
      }
      const data = await composeRes.json().catch(() => ({}));
      const compositionId = typeof data.compositionId === "string" ? data.compositionId : "";
      if (!compositionId) throw new Error(t("autoFinishFailed"));
      const url = await pollComposition(id, compositionId, {
        // FFmpeg 单任务最长 10 分钟，还需给排队/TTS 留出窗口；超时只停止等待，不误报后台失败。
        timeoutMs: 15 * 60 * 1000,
        failMessage: t("autoFinishFailed"),
        onStatus: (status) => {
          if (status === "done" || status === "failed") clearComposeOperation(composeOperation);
        },
      });
      clearComposeOperation(composeOperation);
      if (!url) throw new Error(t("autoFinishFailed"));
      router.push(`/project/${id}/export`);
    } catch (err) {
      setAutoFinishError(friendlyError(err, locale));
      setAutoFinishing(false);
    }
  };

  // 顶部导航（空态/正常态共用）
  const headerBar = (
    <header className="sticky top-0 z-50 border-b border-border/50 bg-background/80 backdrop-blur-xl">
      <div className="mx-auto flex h-14 max-w-7xl items-center justify-between px-6">
        <div className="flex items-center gap-4">
          <Link href="/project/agent" className="flex items-center gap-3">
            <BrandWheatMark className="h-9 w-7 text-foreground" />
          </Link>
          <span className="text-muted-foreground">/</span>
          <span className="text-sm text-muted-foreground truncate max-w-[40vw] sm:max-w-xs">{projectName || t("defaultProjectName")}</span>
        </div>
        <LanguageToggle />
      </div>
    </header>
  );

  // 加载中：骨架屏（模拟脚本卡片布局，比纯转圈更显「秒开」、降低等待焦虑）
  if (loading) {
    return (
      <div className="workflow-light min-h-screen grid-bg">
        {headerBar}
        <div className="max-w-7xl mx-auto px-6 py-8 space-y-4" aria-busy="true" aria-label={t("loadingScripts")}>
          {[0, 1, 2].map((i) => (
            <Card key={i} className="glass-card animate-pulse">
              <CardContent className="p-5 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="h-4 w-40 rounded bg-muted/60" />
                  <div className="h-4 w-16 rounded bg-muted/40" />
                </div>
                <div className="h-2 w-full rounded bg-muted/40" />
                <div className="flex gap-2">
                  <div className="h-6 w-20 rounded bg-muted/40" />
                  <div className="h-6 w-20 rounded bg-muted/40" />
                  <div className="h-6 w-24 rounded bg-muted/30" />
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    );
  }

  // 空态：该项目还没有真实脚本（修复 #3：不再展示德宝示例，给出可恢复的「生成脚本」入口）
  if (scripts.length === 0) {
    return (
      <div className="workflow-light min-h-screen grid-bg">
        {headerBar}
        <div className="mx-auto max-w-md flex flex-col items-center justify-center py-28 px-6 text-center">
          <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-muted/40 mb-5">
            <LuWand className="w-8 h-8 text-muted-foreground" />
          </div>
          <h2 className="text-lg font-semibold mb-2">{t("emptyTitle")}</h2>
          <p className="text-sm text-muted-foreground mb-6">
            {t("emptyDesc", { name: projectName || t("emptyDescThisProject") })}
          </p>
          {genError && (
            <p className="text-sm text-destructive mb-4">{genError}</p>
          )}
          <div className="flex items-center gap-3">
            <Button onClick={handleGenerate} disabled={isGenerating} className="brand-gradient text-white">
              {isGenerating ? (
                <>
                  <LuLoaderCircle className="w-4 h-4 mr-2 animate-spin" />
                  {tc("generating")}
                </>
              ) : (
                <>
                  <LuWand className="w-4 h-4 mr-2" />
                  {t("generateScript")}
                </>
              )}
            </Button>
            <Link href="/project/agent">
              <Button variant="outline">{t("backToProjects")}</Button>
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="workflow-light min-h-screen grid-bg">
      {/* 顶部导航 */}
      <header className="sticky top-0 z-50 border-b border-border/50 bg-background/80 backdrop-blur-xl">
        <div className="mx-auto flex h-14 max-w-7xl items-center justify-between px-6">
          <div className="flex items-center gap-4">
            <Link href="/project/agent" className="flex items-center gap-3">
              <BrandWheatMark className="h-9 w-7 text-foreground" />
            </Link>
            <span className="text-muted-foreground">/</span>
            <span className="text-sm text-muted-foreground truncate max-w-[40vw] sm:max-w-xs">{projectName || t("defaultProjectName")}</span>
          </div>

          {/* 步骤进度 */}
          <div className="flex items-center gap-1">
            {/* 步骤胶囊在窄屏放不下，移动端隐藏（仅进度展示、非导航） */}
            <div className="hidden sm:flex items-center gap-1">
            <StepProgressIndicator
              steps={[t("stepScript"), t("stepAssets"), t("stepMotion"), t("stepVideo"), t("stepExport")]}
              activeIndex={0}
              hrefs={workflowStepHrefs}
              backLabel={tc("backPrevStep")}
            />
            </div>
            <LanguageToggle />
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-6 py-8">
        <div className="space-y-6">
          {/* 左侧：脚本方案选择 */}
          <div>
            <Card className="glass-card py-0">
              <CardContent className="px-5 py-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <h2 className="text-lg font-semibold">{t("scriptHeroTitle")}</h2>
                    <p className="mt-0.5 text-sm text-muted-foreground">{t("scriptHeroDesc")}</p>
                    {fallbackWarning && (
                      <p className="mt-1.5 text-sm font-medium text-amber-600 dark:text-amber-400">
                        ⚠ {fallbackWarning}{t("fallbackRegenHint")}
                      </p>
                    )}
                    {currentScript && (
                      <div className="hidden">
                        <span className="rounded-full bg-muted px-2.5 py-1 text-foreground">{t("currentVersion")}</span>
                        <span>{STYLE_LABEL_KEYS[currentScript.styleType] ? t(STYLE_LABEL_KEYS[currentScript.styleType]) : currentScript.styleType}</span>
                        <span>{t("shotCount", { n: currentScript.shots.length })}</span>
                        <span>{currentScript.totalDuration}s</span>
                      </div>
                    )}
                  </div>
                  <Link href={`/project/${id}/assets`}>
                    <Button className="brand-gradient text-white text-sm">
                      {t("nextStepAssets")}
                      <LuArrowRight className="w-4 h-4 ml-1" />
                    </Button>
                  </Link>
                </div>
              </CardContent>
            </Card>

            {currentScript && (
              <div className="mt-4 grid gap-4 lg:grid-cols-[1.7fr_1fr]">
                <Card className="glass-card">
                  <CardContent className="p-5">
                    <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                      <h3 className="text-base font-semibold">{t("scriptResultTitle")}</h3>
                      <span className="text-xs text-muted-foreground">
                        {t("scriptResultMeta", { n: currentScript.shots.length, duration: currentScript.totalDuration })}
                      </span>
                    </div>
                    <div className="mt-4 space-y-2.5">
                      {currentScript.shots.map((shot, index) => {
                        const typeInfo = SHOT_TYPE_INFO[shot.type];
                        return (
                          <div key={shot.shotId} className="rounded-lg border border-border/50 bg-muted/10 p-3">
                            <div className="flex gap-3">
                              <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-foreground text-xs font-semibold text-background">
                                {index + 1}
                              </span>
                              <div className="min-w-0 flex-1">
                                <div className="mb-1.5 flex flex-wrap items-center gap-2">
                                  <Badge className={`${typeInfo.color} border-0 text-[10px]`}>
                                    {t(typeInfo.labelKey)}
                                  </Badge>
                                  <span className="text-[11px] text-muted-foreground">{shot.duration}s</span>
                                </div>
                                {/* 分镜的主角是画面与动作，文字只是贴在画面上的点缀 */}
                                <p className="text-sm leading-relaxed text-foreground">
                                  {shot.description || t("scriptResultFallback")}
                                </p>
                                {shot.camera && (
                                  <p className="mt-1 text-xs text-muted-foreground">🎥 {shot.camera}</p>
                                )}
                                {shot.voiceover && (
                                  <p className="mt-1 text-xs text-muted-foreground">💬 {shot.voiceover}</p>
                                )}
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </CardContent>
                </Card>

                <Card className="glass-card">
                  <CardContent className="p-5">
                    <h3 className="text-base font-semibold">{t("scriptResultInsightTitle")}</h3>
                    <div className="mt-4 space-y-3">
                      <div className="rounded-lg border border-border/50 bg-muted/10 p-3">
                        <p className="text-xs text-muted-foreground">{t("scriptResultStructure")}</p>
                        <p className="mt-1 text-sm font-medium">
                          {currentScript.shots.map((shot) => t(SHOT_TYPE_INFO[shot.type].labelKey)).join(" / ")}
                        </p>
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <div className="rounded-lg border border-border/50 bg-muted/10 p-3">
                          <p className="text-xs text-muted-foreground">{t("scriptResultDuration")}</p>
                          <p className="mt-1 text-sm font-semibold">{currentScript.totalDuration}s</p>
                        </div>
                        <div className="rounded-lg border border-border/50 bg-muted/10 p-3">
                          <p className="text-xs text-muted-foreground">{t("scriptResultShots")}</p>
                          <p className="mt-1 text-sm font-semibold">{currentScript.shots.length}</p>
                        </div>
                      </div>
                      <div className="rounded-lg border border-border/50 bg-muted/10 p-3">
                        <p className="text-xs text-muted-foreground">{t("scriptResultCheck")}</p>
                        <p className="mt-1 text-sm font-medium">
                          {readiness
                            ? t(
                                readiness.overall === "ready"
                                  ? "readinessReady"
                                  : "scriptResultNeedsReview"
                              )
                            : t("readinessReady")}
                        </p>
                      </div>
                      <div className="rounded-lg border border-border/50 bg-muted/10 p-3">
                        <p className="text-xs text-muted-foreground">{t("scriptResultAdRisk")}</p>
                        <p className="mt-1 text-sm font-medium">
                          {adViolations.length === 0 ? t("scriptResultNoRisk") : t("adComplianceTitle", { n: adViolations.length })}
                        </p>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </div>
            )}

            <details className="mt-3 hidden">
              <summary className="cursor-pointer list-none rounded-lg border border-border/60 bg-muted/20 px-4 py-2 text-sm font-medium text-muted-foreground transition hover:text-foreground">
                {t("scriptAdvancedActions")}
              </summary>
            <div className="mt-2 flex flex-wrap items-center gap-2">
                {savedTip && (
                  <span className="text-xs text-muted-foreground animate-in fade-in">{t("savedAsTemplate")}</span>
                )}
                {selectionTip && (
                  <span className="text-xs text-muted-foreground animate-in fade-in">{t("selectionSaved")}</span>
                )}
                {memoryStatus === "saved" && (
                  <span className="text-xs text-muted-foreground animate-in fade-in">{t("memorySaved")}</span>
                )}
                {memoryStatus === "failed" && (
                  <span className="text-xs text-destructive animate-in fade-in">{t("memoryFailed")}</span>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  className="text-xs"
                  disabled={memoryStatus === "saving"}
                  onClick={rememberCurrentStyle}
                  title={t("memoryRememberHint")}
                >
                  <LuBookmarkPlus className="w-3.5 h-3.5 mr-1" />
                  {memoryStatus === "saving" ? t("memorySaving") : t("memoryRemember")}
                </Button>
                <Button variant="outline" size="sm" disabled={isGenerating} className="text-xs" onClick={() => setRegenConfirmOpen(true)}>
                  <LuWand className="w-3.5 h-3.5 mr-1" />
                  {t("regenerate")}
                </Button>
                <Button variant="outline" size="sm" className="text-xs" onClick={handleSaveAsTemplate}>
                  <LuBookmarkPlus className="w-3.5 h-3.5 mr-1" />
                  {t("saveAsTemplate")}
                </Button>
            </div>
            </details>

            <details className="mt-4 hidden">
              <summary className="cursor-pointer list-none rounded-lg border border-border/60 bg-muted/20 px-4 py-2 text-sm font-medium text-muted-foreground transition hover:text-foreground">
                {t("viewMoreScripts")}
              </summary>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                {scripts.map((script, index) => (
                  <Card
                    key={script.id}
                    className={`cursor-pointer transition-all ${selectedScript === index ? "ring-2 ring-primary neon-glow" : "glass-card card-hover"}`}
                    onClick={() => persistSelection(index)}
                  >
                    <CardContent className="p-4">
                      <div className="flex items-start justify-between mb-2">
                        <h3 className="font-medium text-sm">{script.title}</h3>
                        <Badge variant="secondary" className="text-xs shrink-0 ml-2">
                          {STYLE_LABEL_KEYS[script.styleType] ? t(STYLE_LABEL_KEYS[script.styleType]) : script.styleType}
                        </Badge>
                      </div>
                      <div className="flex items-center gap-3 text-xs text-muted-foreground">
                        <span>{t("shotCount", { n: script.shots.length })}</span>
                        <span>{script.totalDuration}s</span>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            </details>

            {readiness && readiness.overall !== "ready" && (
              <Card
                className={`mt-4 hidden ${
                  readiness.overall === "needsWork"
                    ? "border-foreground/30 bg-muted/30"
                    : "border-border bg-muted/30"
                }`}
              >
                <CardContent className="p-4">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold">{t("quickCheckTitle")}</span>
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                        readiness.overall === "needsWork"
                          ? "bg-foreground text-background"
                          : "bg-muted text-muted-foreground"
                      }`}
                    >
                      {t(
                        readiness.overall === "needsWork"
                          ? "readinessNeedsWork"
                          : "readinessRisky"
                      )}
                    </span>
                  </div>
                  <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                    {t(
                      readiness.overall === "needsWork"
                        ? "quickCheckNeedsWorkDesc"
                        : "quickCheckRiskyDesc"
                    )}
                  </p>
                  <details className="mt-3">
                    <summary className="cursor-pointer list-none text-xs font-medium text-foreground hover:underline">
                      {t("quickCheckDetails")}
                    </summary>
                    <ul className="mt-2 space-y-1.5">
                      {readiness.items.map((it) => (
                        <li key={it.key} className="flex items-start gap-2 text-xs">
                          {it.status === "pass" ? (
                            <LuCircleCheck className="w-3.5 h-3.5 text-foreground mt-0.5 shrink-0" />
                          ) : it.status === "fail" ? (
                            <LuCircleX className="w-3.5 h-3.5 text-foreground mt-0.5 shrink-0" />
                          ) : (
                            <LuTriangleAlert className="w-3.5 h-3.5 text-muted-foreground mt-0.5 shrink-0" />
                          )}
                          <span className={it.status === "fail" ? "text-foreground" : "text-muted-foreground"}>
                            {it.message}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </details>
                </CardContent>
              </Card>
            )}
          </div>

          {/* 右侧：分镜详情编辑 */}
          <div>
            <details className="hidden">
              <summary className="cursor-pointer list-none rounded-lg border border-border/60 bg-muted/20 px-4 py-2 text-sm font-medium text-muted-foreground transition hover:text-foreground">
                {t("viewShotDetails")}
              </summary>
              <div className="mt-3">
            <Tabs defaultValue="timeline" className="w-full">
              <div className="flex items-center justify-between mb-4">
                <TabsList className="hidden sm:flex">
                  <TabsTrigger value="timeline">{t("tabTimeline")}</TabsTrigger>
                  <TabsTrigger value="text">{t("tabText")}</TabsTrigger>
                </TabsList>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    className="text-sm"
                    disabled={autoFinishing}
                    onClick={autoFinish}
                    title={t("autoFinishHint")}
                  >
                    {autoFinishing ? (
                      <>
                        <LuLoaderCircle className="w-4 h-4 mr-1 animate-spin" />
                        {autoFinishStage || t("autoFinish")}
                      </>
                    ) : (
                      <>
                        <LuWand className="w-4 h-4 mr-1" />
                        {t("autoFinish")}
                      </>
                    )}
                  </Button>
                  <Link href={`/project/${id}/assets`}>
                    <Button className="brand-gradient text-white text-sm" disabled={autoFinishing}>
                      {t("nextStepAssets")}
                      <LuArrowRight className="w-4 h-4 ml-1" />
                    </Button>
                  </Link>
                </div>
              </div>

              {autoFinishError && (
                <div className="mb-4 rounded-lg border border-destructive/40 bg-destructive/5 px-4 py-2.5 text-xs text-destructive">
                  {autoFinishError}
                </div>
              )}

              <TabsContent value="timeline" className="mt-0">
                <details>
                  <summary className="cursor-pointer list-none rounded-lg border border-border/60 bg-muted/20 px-4 py-2 text-sm font-medium text-muted-foreground transition hover:text-foreground">
                    {t("viewShotDetails")}
                  </summary>
                <div className="mt-3 space-y-3">
                  {adViolations.length > 0 && (
                    <Card className="border-border bg-muted/30">
                      <CardContent className="p-4">
                        <div className="flex items-center gap-2 mb-1">
                          <LuTriangleAlert className="w-4 h-4 text-muted-foreground" />
                          <span className="text-sm font-semibold">{t("adComplianceTitle", { n: adViolations.length })}</span>
                        </div>
                        <p className="text-xs text-muted-foreground mb-2.5">{t("adComplianceHint")}</p>
                        <div className="flex flex-wrap gap-1.5">
                          {adViolations.map((v) => (
                            <span
                              key={v.term}
                              title={v.suggestion}
                              className="rounded-md border border-border bg-muted px-2 py-0.5 text-xs cursor-help"
                            >
                              「{v.term}」· {v.category}
                            </span>
                          ))}
                        </div>
                      </CardContent>
                    </Card>
                  )}
                  {currentScript?.shots.map((shot, index) => {
                    const typeInfo = SHOT_TYPE_INFO[shot.type];
                    return (
                      <Card key={shot.shotId} className="glass-card overflow-hidden">
                        <CardContent className="p-0">
                          <div className="flex">
                            {/* 左侧序号和类型 */}
                            <div className="flex flex-col items-center justify-center w-16 py-4 border-r border-border/50 shrink-0">
                              <span className="text-lg font-bold text-muted-foreground/50">{String(index + 1).padStart(2, "0")}</span>
                              <Badge className={`${typeInfo.color} border-0 text-[10px] mt-1`}>{t(typeInfo.labelKey)}</Badge>
                              <span className="text-[10px] text-muted-foreground mt-1">{shot.duration}s</span>
                            </div>
                            {/* 右侧内容 */}
                            <div className="flex-1 p-4">
                              <div className="flex items-start justify-between gap-4">
                                <div className="flex-1">
                                  <p className="text-sm leading-relaxed mb-2">{shot.description}</p>
                                  <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                                    <span className="flex items-center gap-1">
                                      <LuClock className="w-3 h-3" />
                                      {shot.camera}
                                    </span>
                                    <span className="flex items-center gap-1">
                                      {shot.visualSource === "product_image" ? t("visualProductImage") : shot.visualSource === "ai_generate" ? t("visualAiGenerate") : t("visualUserUpload")}
                                    </span>
                                    {editingShotId !== shot.shotId && (
                                      <button
                                        type="button"
                                        className="flex items-center gap-1 text-foreground hover:underline"
                                        onClick={() => startEditShot(shot)}
                                      >
                                        <LuPencil className="w-3 h-3" />
                                        {t("editShot")}
                                      </button>
                                    )}
                                  </div>
                                </div>
                                {/* 画面预览区：商品原图分镜直接显示已上传的商品图，让小白第一眼就看到画面；AI 分镜此阶段尚未出图 */}
                                <div className="w-20 h-14 bg-muted/30 rounded-md shrink-0 overflow-hidden flex items-center justify-center border border-border/30 relative">
                                  {shot.visualSource === "product_image" && projectMeta?.productImages?.[0] ? (
                                    // eslint-disable-next-line @next/next/no-img-element
                                    <img
                                      src={projectMeta.productImages[0]}
                                      alt=""
                                      className="absolute inset-0 w-full h-full object-cover"
                                    />
                                  ) : shot.visualSource === "product_image" ? (
                                    <span className="text-[10px] text-muted-foreground">{t("productImageShort")}</span>
                                  ) : (
                                    <LuImage className="w-4 h-4 text-muted-foreground/40" />
                                  )}
                                </div>
                              </div>
                              {editingShotId === shot.shotId ? (
                                <div className="mt-3 space-y-2 rounded-md border border-foreground/20 bg-muted/30 p-2.5">
                                  <div>
                                    <label className="text-[10px] text-muted-foreground">{t("editVoiceoverLabel")}</label>
                                    <Textarea
                                      className="mt-1 min-h-[64px] bg-background/50 text-xs leading-relaxed"
                                      value={editDraft.voiceover}
                                      onChange={(event) => setEditDraft((draft) => ({ ...draft, voiceover: event.target.value }))}
                                    />
                                  </div>
                                  <div>
                                    <label className="text-[10px] text-muted-foreground">{t("editDescriptionLabel")}</label>
                                    <Textarea
                                      className="mt-1 min-h-[48px] bg-background/50 text-xs leading-relaxed"
                                      value={editDraft.description}
                                      onChange={(event) => setEditDraft((draft) => ({ ...draft, description: event.target.value }))}
                                    />
                                  </div>
                                  <div className="flex items-center justify-end gap-2">
                                    {editStatus === "failed" && <span className="mr-auto text-[10px] text-destructive">{t("editSaveFailed")}</span>}
                                    <Button variant="outline" size="sm" className="h-7 text-xs" onClick={cancelEditShot}>{tc("cancel")}</Button>
                                    <Button size="sm" className="h-7 text-xs brand-gradient text-white" disabled={editStatus === "saving"} onClick={() => saveEditShot(shot.shotId)}>
                                      {tc("save")}
                                    </Button>
                                  </div>
                                </div>
                              ) : (
                                shot.voiceover && (
                                  <div className="mt-3 p-2.5 bg-muted/30 rounded-md">
                                    <p className="text-xs text-muted-foreground leading-relaxed">
                                      🎙 {shot.voiceover}
                                    </p>
                                  </div>
                                )
                              )}
                            </div>
                          </div>
                        </CardContent>
                      </Card>
                    );
                  })}
                </div>
                </details>
              </TabsContent>

              <TabsContent value="text" className="mt-0">
                <Card className="glass-card">
                  <CardContent className="p-6 space-y-4">
                    <h3 className="font-medium text-sm mb-2">{t("fullVoiceover")}</h3>
                    <Textarea
                      className="min-h-[300px] bg-background/50 text-sm leading-relaxed"
                      value={currentScript?.shots.map((s) => s.voiceover).filter(Boolean).join("\n\n") ?? ""}
                      readOnly
                    />
                    <p className="text-xs text-muted-foreground">{t("textReadOnlyHint")}</p>
                    <p className="text-xs text-muted-foreground">
                      {t("statsChars", { n: currentScript?.shots.reduce((sum, s) => sum + (s.voiceover?.length || 0), 0) ?? 0 })} ·
                      {t("statsDuration", { n: currentScript?.totalDuration ?? 0 })} ·
                      {t("statsSpeed", { n: Math.round((currentScript?.shots.reduce((sum, s) => sum + (s.voiceover?.length || 0), 0) || 0) / (currentScript?.totalDuration || 1) * 10) / 10 })}
                    </p>
                  </CardContent>
                </Card>
              </TabsContent>
            </Tabs>
              </div>
            </details>
          </div>
        </div>
      </main>

      {/* 保存模板弹窗 */}
      {showSaveDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <Card className="glass-card w-full max-w-md mx-4">
            <CardContent className="p-6 space-y-4">
              <h3 className="text-base font-semibold">{t("saveTemplateTitle")}</h3>
              <p className="text-xs text-muted-foreground">{t("saveTemplateDesc")}</p>
              <Input
                placeholder={t("templateNamePlaceholder")}
                value={templateName}
                onChange={(e) => setTemplateName(e.target.value)}
              />
              <div className="flex justify-end gap-2">
                <Button variant="outline" size="sm" onClick={() => setShowSaveDialog(false)}>{tc("cancel")}</Button>
                <Button size="sm" className="brand-gradient text-white" onClick={doSaveTemplate} disabled={!templateName.trim()}>{tc("save")}</Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* 重新生成二次确认：删旧脚本不可逆，防误点 */}
      {regenConfirmOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <Card className="glass-card w-full max-w-md mx-4">
            <CardContent className="p-6 space-y-4">
              <h3 className="text-base font-semibold flex items-center gap-2">
                <LuTriangleAlert className="w-4 h-4 text-muted-foreground shrink-0" />
                {t("regenConfirmTitle")}
              </h3>
              <p className="text-xs text-muted-foreground leading-relaxed">{t("regenConfirmDesc")}</p>
              <div className="flex justify-end gap-2">
                <Button variant="outline" size="sm" onClick={() => setRegenConfirmOpen(false)}>{t("regenConfirmCancel")}</Button>
                <Button
                  size="sm"
                  className="brand-gradient text-white"
                  onClick={() => {
                    setRegenConfirmOpen(false);
                    handleGenerate();
                  }}
                >
                  {t("regenConfirmOk")}
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
