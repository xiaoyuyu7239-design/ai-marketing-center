"use client";

import { useState, useEffect, useRef } from "react";
import { useParams } from "next/navigation";
import { LuArrowLeft, LuPlay, LuChevronDown, LuArrowRight, LuLoaderCircle } from "react-icons/lu";
import Link from "next/link";
import { Card, CardContent } from "@frontend/components/ui/card";
import { Button } from "@frontend/components/ui/button";
import { Badge } from "@frontend/components/ui/badge";
import { Label } from "@frontend/components/ui/label";
import { Input } from "@frontend/components/ui/input";
import { useT } from "@frontend/i18n";
import { pollComposition } from "@backend/shared/poll-composition";
import { acquireComposeOperation, clearComposeOperation } from "@frontend/lib/compose-operation";
import { RENDER_PRESETS, DEFAULT_RENDER_PRESET, type RenderPreset } from "@backend/core/media/compose-presets";
import {
  AGENT_GENERATION_SETTINGS_LATEST_KEY,
  parseStoredAgentGenerationSettings,
  projectAgentGenerationSettingsKey,
} from "@backend/core/agent/agent-generation-settings";
import { LanguageToggle } from "@frontend/components/language-toggle";
import { StepProgressIndicator } from "@frontend/components/step-progress";
import { BrandWheatMark } from "@frontend/components/brand-wheat-logo";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@frontend/components/ui/select";
import type { Shot } from "@backend/db/schema";

// 视频片段
interface VideoClipItem {
  shotId: number;
  type: Shot["type"];
  duration: number;
  voiceover: string;
  /** 画面描述：氛围大片模式多数分镜无文字，列表回退展示画面 */
  description: string;
  transition: "ai_start_end" | "ai_reference" | "direct_concat" | "ffmpeg_fade";
}

// 合成配置
interface ComposeConfig {
  ttsEnabled: boolean;
  /** 免费 TTS 音色（未配置付费 TTS 时使用） */
  freeVoice: string;
  bgm: string;
  subtitleSize: number;
  subtitlePosition: "bottom" | "center" | "top";
  aspectRatio: "9:16" | "16:9" | "1:1";
  resolution: "720p" | "1080p";
  /** 渲染质量预设：快速/标准/高清（决定分辨率 + 编码速度/质量） */
  renderPreset: RenderPreset;
  /** 合规：烧 AI 生成标识（TikTok/抖音要求） */
  aiDisclosure: boolean;
  /** 带货：片尾购买 CTA 贴片 */
  ctaEnabled: boolean;
  ctaText: string;
  /** 带货：左下角商品卡贴片（商品图缩略+名+购买引导，需商品图） */
  productCard: boolean;
  /** 卡拉OK逐字高亮字幕（整句留屏，逐字随旁白变色） */
  karaoke: boolean;
  /** 旁白闪避：旁白一响自动压低 BGM、停顿回升，旁白更清晰 */
  bgmDuck: boolean;
}

// 免费配音音色（微软 Edge keyless TTS，无需 Key）——与后端 FREE_TTS_VOICES 对应
// label 改为 i18n key，渲染时经 t() 取对应语言文案
const freeVoiceOptions = [
  { value: "zh-CN-XiaoxiaoNeural", labelKey: "freeVoiceXiaoxiao" },
  { value: "zh-CN-XiaoyiNeural", labelKey: "freeVoiceXiaoyi" },
  { value: "zh-CN-YunxiNeural", labelKey: "freeVoiceYunxi" },
  { value: "zh-CN-YunyangNeural", labelKey: "freeVoiceYunyang" },
  { value: "zh-CN-YunjianNeural", labelKey: "freeVoiceYunjian" },
];

// 背景音乐选项（label 改为 i18n key）
const bgmOptions = [
  { value: "none", labelKey: "bgmNone" },
  { value: "upbeat", labelKey: "bgmUpbeat" },
  { value: "chill", labelKey: "bgmChill" },
  { value: "energetic", labelKey: "bgmEnergetic" },
  { value: "emotional", labelKey: "bgmEmotional" },
];

// 转场标签（值为 i18n key）
const transitionLabels: Record<string, string> = {
  ai_start_end: "transitionAiStartEnd",
  ai_reference: "transitionAiReference",
  direct_concat: "transitionDirectConcat",
  ffmpeg_fade: "transitionFfmpegFade",
};

// 镜头类型标签（labelKey 为 i18n key）
const shotTypeLabels: Record<Shot["type"], { labelKey: string; color: string }> = {
  hook: { labelKey: "shotHook", color: "bg-muted text-muted-foreground" },
  pain_point: { labelKey: "shotPainPoint", color: "bg-muted text-muted-foreground" },
  product_reveal: { labelKey: "shotProductReveal", color: "bg-muted text-muted-foreground" },
  demo: { labelKey: "shotDemo", color: "bg-muted text-muted-foreground" },
  social_proof: { labelKey: "shotSocialProof", color: "bg-muted text-muted-foreground" },
  cta: { labelKey: "shotCta", color: "bg-muted text-muted-foreground" },
};

interface DbShot {
  shotId: number;
  type: VideoClipItem["type"];
  duration: number;
  voiceover: string;
  description?: string;
  transition: VideoClipItem["transition"];
}

// 分镜素材（仅取缩略图所需字段）
interface DbAsset {
  shotId: number;
  filePath: string | null;
  status: string;
}

// 判断素材是图还是视频（视频用 <video> 当封面，图用 <img>）
const isVideoPath = (p: string) => /\.(mp4|webm|mov|m4v)(\?|$)/i.test(p);

export default function VideoPage() {
  const t = useT("video");
  const tc = useT("common");
  const tRef = useRef(t);
  tRef.current = t;
  const { id } = useParams<{ id: string }>();
  const workflowStepHrefs = [`/project/${id}/script`, `/project/${id}/assets`, `/project/${id}/motion`, `/project/${id}/video`, `/project/${id}/export`];
  const [clips, setClips] = useState<VideoClipItem[]>([]);
  // 分镜缩略图：shotId → 素材文件路径（在时间线里直接预览每段画面）
  const [thumbs, setThumbs] = useState<Record<number, string>>({});
  const [projectName, setProjectName] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [paidTtsReady, setPaidTtsReady] = useState(false);
  const [config, setConfig] = useState<ComposeConfig>({
    ttsEnabled: true,
    freeVoice: "zh-CN-XiaoxiaoNeural",
    bgm: "upbeat",
    subtitleSize: 24,
    subtitlePosition: "bottom",
    aspectRatio: "9:16",
    resolution: "1080p",
    renderPreset: DEFAULT_RENDER_PRESET,
    aiDisclosure: true,
    ctaEnabled: false,
    ctaText: "", // 默认空，开启时按当前语言用 ctaPlaceholder 预填（避免英文用户拿到中文默认 CTA）
    productCard: false,
    karaoke: false,
    bgmDuck: false,
  });

  // 合成状态
  const [isComposing, setIsComposing] = useState(false);
  const [composeProgress, setComposeProgress] = useState(0);
  const [composeDone, setComposeDone] = useState(false);
  const [composeError, setComposeError] = useState<string | null>(null);
  const [outputUrl, setOutputUrl] = useState<string | null>(null);
  const [showPostComposeAdjust, setShowPostComposeAdjust] = useState(false);
  // 背景音乐
  const [bgm, setBgm] = useState<{ path: string; name: string } | null>(null);
  const [bgmUploading, setBgmUploading] = useState(false);
  // 免费配音试听状态
  const [previewingVoice, setPreviewingVoice] = useState(false);

  // 试听免费音色：合成一小段并播放
  const previewFreeVoice = async () => {
    if (previewingVoice) return;
    setPreviewingVoice(true);
    try {
      const res = await fetch("/api/tts/free", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ voice: config.freeVoice, text: t("ttsPreviewText") }),
      });
      if (!res.ok) throw new Error(t("errorPreviewFailed"));
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audio.onended = () => URL.revokeObjectURL(url);
      await audio.play();
    } catch {
      /* 试听失败静默（不阻断主流程） */
    } finally {
      setPreviewingVoice(false);
    }
  };
  const uploadBgm = async (file: File) => {
    setBgmUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch(`/api/project/${id}/bgm`, { method: "POST", body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || t("errorUploadFailed"));
      setBgm({ path: data.path, name: data.name });
    } catch {
      setBgm(null);
    } finally {
      setBgmUploading(false);
    }
  };

  // 载入真实分镜（已选脚本）+ 项目名 + 已生成素材
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setLoadError(null);
      try {
        const [projectRes, scriptsRes, assetsRes] = await Promise.all([
          fetch(`/api/project/${id}`),
          fetch(`/api/project/${id}/scripts`),
          fetch(`/api/project/${id}/assets`),
        ]);
        const project = projectRes.ok ? await projectRes.json() : null;
        const scripts = scriptsRes.ok ? await scriptsRes.json() : [];
        const assets = assetsRes.ok ? await assetsRes.json() : [];
        if (cancelled) return;
        if (project) {
          setProjectName(project.name ?? project.productName ?? "");
          const savedSettings = parseStoredAgentGenerationSettings(
            typeof window !== "undefined" ? window.localStorage?.getItem(projectAgentGenerationSettingsKey(id)) : null
          );
          if (savedSettings) {
            setConfig((current) => ({
              ...current,
              aspectRatio: savedSettings.aspectRatio,
              resolution: savedSettings.resolution,
              renderPreset: savedSettings.renderPreset,
            }));
          }
        }
        // 收集每个分镜已生成的画面，作时间线缩略图（已完成且有文件的才算）
        const thumbMap: Record<number, string> = {};
        for (const a of (Array.isArray(assets) ? assets : []) as DbAsset[]) {
          if (a && typeof a.shotId === "number" && a.filePath && a.status === "done" && thumbMap[a.shotId] == null) {
            thumbMap[a.shotId] = a.filePath;
          }
        }
        setThumbs(thumbMap);
        const selected = Array.isArray(scripts)
          ? scripts.find((s: { selected?: boolean }) => s.selected) ?? scripts[0]
          : null;
        // 配音默认值：优先沿用工作台"更多设置"里生成前的选择（本项目 → 全局最近），
        // 兜底按脚本风格（氛围大片=关）。机器音会毁掉氛围感，用户仍可在本页手动改。
        const storedSettings =
          parseStoredAgentGenerationSettings(window.localStorage?.getItem(projectAgentGenerationSettingsKey(id))) ??
          parseStoredAgentGenerationSettings(window.localStorage?.getItem(AGENT_GENERATION_SETTINGS_LATEST_KEY));
        if (storedSettings) {
          setConfig((prev) => ({ ...prev, ttsEnabled: storedSettings.voiceoverEnabled }));
        } else if (selected && (selected as { styleType?: string }).styleType === "mood") {
          setConfig((prev) => ({ ...prev, ttsEnabled: false }));
        }
        if (!selected || !Array.isArray(selected.shots) || selected.shots.length === 0) {
          setLoadError(tRef.current("errorNoScript"));
          setClips([]);
        } else {
          setClips(
            (selected.shots as DbShot[]).map((s) => ({
              shotId: s.shotId,
              type: s.type,
              duration: s.duration,
              voiceover: s.voiceover ?? "",
              description: s.description ?? "",
              transition: s.transition ?? "ai_start_end",
            }))
          );
        }
      } catch (e) {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : tRef.current("errorLoadFailed"));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/ai/status");
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled) setPaidTtsReady(Boolean(data.ttsReady));
      } catch {
        if (!cancelled) setPaidTtsReady(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const totalDuration = clips.reduce((sum, c) => sum + c.duration, 0);

  // 更新片段转场
  const updateTransition = (shotId: number, transition: string) => {
    setClips((prev) =>
      prev.map((c) =>
        c.shotId === shotId ? { ...c, transition: transition as VideoClipItem["transition"] } : c
      )
    );
  };

  // 真实合成：调用 compose API 跑 FFmpeg，配乐观进度动画，完成后拿到真实 mp4
  const startCompose = async () => {
    setIsComposing(true);
    setComposeError(null);
    setComposeDone(false);
    setShowPostComposeAdjust(false);
    setOutputUrl(null);
    setComposeProgress(0);

    // 乐观进度：先爬到 90%，等真实结果回来再到 100%
    const timer = setInterval(() => {
      setComposeProgress((prev) => (prev >= 90 ? 90 : prev + 3));
    }, 200);

    try {
      // 提交合成任务（后台异步），随后轮询状态
      const composePayload = {
        resolution: config.resolution,
        renderPreset: config.renderPreset,
        aspectRatio: config.aspectRatio,
        aiDisclosure: true,
        ...(config.ctaEnabled && config.ctaText.trim() && { ctaText: config.ctaText.trim() }),
        ...(config.productCard && { productCard: true }),
        ...(config.karaoke && { karaoke: true }),
        ...(config.bgmDuck && { bgmDuck: true }),
        ...(bgm?.path && { bgmPath: bgm.path }),
        // 没上传 BGM 且选了非 none 的配乐情绪 → 自动取一条该情绪的免费 CC 配乐（之前这里漏发，下拉形同虚设）
        ...(!bgm?.path && config.bgm !== "none" && { freeBgm: true, bgmMood: config.bgm }),
        // 开启配音时：服务端优先读取已发布 ttsAgent；同时提交免费 Edge keyless TTS 作为兜底。
        ...(config.ttsEnabled && paidTtsReady && {
          tts: { enabled: true },
        }),
        ...(config.ttsEnabled && {
          freeTts: { enabled: true, voice: config.freeVoice },
        }),
      };
      const composeOperation = acquireComposeOperation(id, "video-preview", composePayload);
      const res = await fetch(`/api/project/${id}/compose`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": composeOperation.idempotencyKey,
        },
        body: JSON.stringify(composePayload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        clearComposeOperation(composeOperation);
        throw new Error(typeof data.error === "string" ? data.error : t("errorComposeFailed"));
      }
      const compositionId = typeof data.compositionId === "string" ? data.compositionId : "";
      if (!compositionId) throw new Error(t("errorComposeFailed"));

      // 轮询合成状态，直到 done / failed
      const url = await pollComposition(id, compositionId, {
        failMessage: t("errorComposeAssets"),
        timeoutMessage: t("errorComposeTimeout"),
        onStatus: (status) => {
          if (status === "done" || status === "failed") clearComposeOperation(composeOperation);
        },
      });
      clearComposeOperation(composeOperation);

      clearInterval(timer);
      setComposeProgress(100);
      setOutputUrl(url);
      setComposeDone(true);
    } catch (e) {
      clearInterval(timer);
      setComposeError(e instanceof Error ? e.message : t("errorComposeFailed"));
      setComposeProgress(0);
    } finally {
      setIsComposing(false);
    }
  };

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
            <LanguageToggle />
            {/* 步骤胶囊在窄屏放不下，移动端隐藏（仅进度展示、非导航） */}
            <div className="hidden sm:flex items-center gap-1">
            <StepProgressIndicator
              steps={[t("stepScript"), t("stepAssets"), t("stepMotion"), t("stepVideo"), t("stepExport")]}
              activeIndex={3}
              hrefs={workflowStepHrefs}
              backLabel={tc("backPrevStep")}
            />
            </div>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-6 py-8">
        <div className="mb-6 hidden justify-end">
          {composeDone && outputUrl ? (
            <Link href={`/project/${id}/export`}>
              <Button className="brand-gradient text-white text-sm">
                {t("nextExport")}
                <LuArrowRight className="w-4 h-4 ml-1" />
              </Button>
            </Link>
          ) : (
            <Button
              onClick={startCompose}
              disabled={isComposing || clips.length === 0}
              className="brand-gradient text-white text-sm"
            >
              {isComposing ? (
                <>
                  <LuLoaderCircle className="animate-spin mr-2 h-4 w-4" />
                  {t("composing")}
                </>
              ) : composeDone ? (
                t("composeRedo")
              ) : (
                <>
                  <LuPlay className="w-4 h-4 mr-1" />
                  {t("composeStart")}
                </>
              )}
            </Button>
          )}
        </div>

        <Card className="glass-card mb-5 py-0">
          <CardContent className="px-5 py-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h2 className="text-lg font-semibold">{composeDone ? t("composeReviewTitle") : t("videoHeroTitle")}</h2>
                <p className="mt-0.5 text-sm text-muted-foreground">
                  {composeDone ? t("composeReviewDesc") : t("videoHeroDesc")}
                </p>
                <p className="hidden">{t("timelineMeta", { count: clips.length, duration: totalDuration })}</p>
              </div>
              {composeDone && outputUrl ? (
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Button
                    variant="outline"
                    className="text-sm"
                    onClick={() => setShowPostComposeAdjust((value) => !value)}
                  >
                    {t("composeAdjustCta")}
                  </Button>
                  <Link href={`/project/${id}/export`}>
                    <Button className="brand-gradient text-white text-sm">
                      {t("composeApproveExport")}
                      <LuArrowRight className="w-4 h-4 ml-1" />
                    </Button>
                  </Link>
                </div>
              ) : (
                <Button
                  onClick={startCompose}
                  disabled={isComposing || clips.length === 0}
                  className="brand-gradient text-white text-sm"
                >
                  {isComposing ? (
                    <>
                      <LuLoaderCircle className="animate-spin mr-2 h-4 w-4" />
                      {t("composing")}
                    </>
                  ) : (
                    <>
                      <LuPlay className="w-4 h-4 mr-1" />
                      {t("composeStart")}
                    </>
                  )}
                </Button>
              )}
            </div>
          </CardContent>
        </Card>

        {isComposing && (
          <Card className="glass-card mb-6">
            <CardContent className="p-5">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <h3 className="text-base font-semibold">{t("composeWaitingTitle")}</h3>
                  <p className="mt-1 text-sm text-muted-foreground">{t("composeWaitingDesc")}</p>
                </div>
                <span className="text-sm font-semibold text-muted-foreground">{composeProgress}%</span>
              </div>
              <div className="mt-4 h-2 overflow-hidden rounded-full bg-muted/40">
                <div
                  className="h-full rounded-full brand-gradient transition-all duration-300"
                  style={{ width: `${composeProgress}%` }}
                />
              </div>
            </CardContent>
          </Card>
        )}

        {composeDone && outputUrl && (
          <div className="mb-6 grid gap-4 lg:grid-cols-[1.1fr_1fr]">
            <Card className="glass-card overflow-hidden">
              <CardContent className="p-0">
                <div className="border-b border-border/40 px-5 py-4">
                  <h3 className="text-base font-semibold">{t("composePreviewTitle")}</h3>
                  <p className="mt-1 text-xs text-muted-foreground">{t("composePreviewDesc")}</p>
                </div>
                <div className="bg-black">
                  <div className="mx-auto max-w-[260px]">
                    <video
                      src={outputUrl}
                      controls
                      playsInline
                      className="aspect-[9/16] w-full object-contain"
                    />
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card className="glass-card">
              <CardContent className="p-5">
                <h3 className="text-base font-semibold">{t("composeDecisionTitle")}</h3>
                <p className="mt-1 text-sm text-muted-foreground">{t("composeDecisionDesc")}</p>
                <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-1">
                  <Link href={`/project/${id}/export`}>
                    <Button className="brand-gradient w-full text-white">
                      {t("composeApproveExport")}
                      <LuArrowRight className="w-4 h-4 ml-1" />
                    </Button>
                  </Link>
                  <Button
                    variant="outline"
                    className="w-full"
                    onClick={() => setShowPostComposeAdjust((value) => !value)}
                  >
                    {showPostComposeAdjust ? t("composeHideAdjust") : t("composeAdjustCta")}
                  </Button>
                </div>

                {showPostComposeAdjust && (
                  <div className="mt-5 space-y-4 rounded-xl border border-border/60 bg-muted/10 p-4">
                    <div>
                      <p className="mb-2 text-xs font-medium text-muted-foreground">{t("bgmSectionLabel")}</p>
                      <div className="grid grid-cols-2 gap-2">
                        {bgmOptions.slice(0, 4).map((option) => (
                          <button
                            key={option.value}
                            type="button"
                            onClick={() => setConfig((current) => ({ ...current, bgm: option.value }))}
                            className={`rounded-md border px-3 py-2 text-left text-xs transition ${
                              config.bgm === option.value
                                ? "border-primary bg-primary/10 text-primary"
                                : "border-border/50 bg-background/60 text-muted-foreground hover:border-primary/40"
                            }`}
                          >
                            {t(option.labelKey)}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div>
                      <p className="mb-2 text-xs font-medium text-muted-foreground">{t("subtitleLabel")}</p>
                      <div className="grid grid-cols-3 gap-2">
                        {(["bottom", "center", "top"] as const).map((pos) => (
                          <button
                            key={pos}
                            type="button"
                            onClick={() => setConfig((current) => ({ ...current, subtitlePosition: pos }))}
                            className={`rounded-md border px-3 py-2 text-xs transition ${
                              config.subtitlePosition === pos
                                ? "border-primary bg-primary/10 text-primary"
                                : "border-border/50 bg-background/60 text-muted-foreground hover:border-primary/40"
                            }`}
                          >
                            {pos === "bottom" ? t("subtitleBottom") : pos === "center" ? t("subtitleCenter") : t("subtitleTop")}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div>
                      <p className="mb-2 text-xs font-medium text-muted-foreground">{t("renderQualityLabel")}</p>
                      <div className="grid grid-cols-3 gap-2">
                        {(["fast", "standard", "hd"] as const).map((preset) => (
                          <button
                            key={preset}
                            type="button"
                            onClick={() =>
                              setConfig((current) => ({
                                ...current,
                                renderPreset: preset,
                                resolution: RENDER_PRESETS[preset].resolution,
                              }))
                            }
                            className={`rounded-md border px-3 py-2 text-xs transition ${
                              config.renderPreset === preset
                                ? "border-primary bg-primary/10 text-primary"
                                : "border-border/50 bg-background/60 text-muted-foreground hover:border-primary/40"
                            }`}
                          >
                            {t(`renderPreset_${preset}`)}
                          </button>
                        ))}
                      </div>
                    </div>

                    <Button
                      className="brand-gradient w-full text-white"
                      disabled={isComposing}
                      onClick={startCompose}
                    >
                      {isComposing ? (
                        <>
                          <LuLoaderCircle className="animate-spin mr-2 h-4 w-4" />
                          {t("composing")}
                        </>
                      ) : (
                        t("composeRedoWithAdjust")
                      )}
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        )}

        {!loading && !loadError && clips.length > 0 && (
          <div className="mb-6 grid gap-4 lg:grid-cols-[1.7fr_1fr]">
            <Card className="glass-card">
              <CardContent className="p-5">
                <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                  <h3 className="text-base font-semibold">{t("videoResultTitle")}</h3>
                  <span className="text-xs text-muted-foreground">{t("timelineMeta", { count: clips.length, duration: totalDuration })}</span>
                </div>
                {(() => {
                  const staticCount = clips.filter((c) => thumbs[c.shotId] && !isVideoPath(thumbs[c.shotId])).length;
                  return staticCount > 0 ? (
                    <div className="mt-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
                      {t("staticClipsWarning", { count: staticCount })}
                    </div>
                  ) : null;
                })()}
                <div className="mt-4 space-y-2.5">
                  {clips.map((clip) => {
                    const typeInfo = shotTypeLabels[clip.type];
                    const isMotionClip = thumbs[clip.shotId] ? isVideoPath(thumbs[clip.shotId]) : undefined;
                    return (
                      <div key={clip.shotId} className="rounded-lg border border-border/50 bg-muted/10 p-3">
                        <div className="flex gap-3">
                          <div className="relative h-16 w-24 shrink-0 overflow-hidden rounded-md border border-border/40 bg-muted/30">
                            <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-br from-primary/20 to-primary/5">
                              <LuPlay className="h-4 w-4 text-primary/60" />
                            </div>
                            {thumbs[clip.shotId] &&
                              (isVideoPath(thumbs[clip.shotId]) ? (
                                <video
                                  src={thumbs[clip.shotId]}
                                  muted
                                  playsInline
                                  preload="metadata"
                                  className="absolute inset-0 h-full w-full object-cover"
                                />
                              ) : (
                                // eslint-disable-next-line @next/next/no-img-element
                                <img
                                  src={thumbs[clip.shotId]}
                                  alt=""
                                  className="absolute inset-0 h-full w-full object-cover"
                                />
                              ))}
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="mb-1.5 flex flex-wrap items-center gap-2">
                              <Badge className={`${typeInfo.color} border-0 text-[10px]`}>
                                {t(typeInfo.labelKey)}
                              </Badge>
                              <span className="text-[11px] text-muted-foreground">{clip.duration}s</span>
                              {isMotionClip !== undefined && (
                                <span
                                  className={`text-[10px] ${isMotionClip ? "text-emerald-600 dark:text-emerald-400" : "text-amber-600 dark:text-amber-400"}`}
                                >
                                  {isMotionClip ? t("clipMotionBadge") : t("clipStillBadge")}
                                </span>
                              )}
                            </div>
                            <p className="line-clamp-2 text-sm leading-relaxed text-foreground">{clip.voiceover || clip.description}</p>
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
                <h3 className="text-base font-semibold">{t("videoResultSettingsTitle")}</h3>
                <div className="mt-4 space-y-3">
                  <div className="rounded-lg border border-border/50 bg-muted/10 p-3">
                    <p className="text-xs text-muted-foreground">{t("videoResultCanvas")}</p>
                    <p className="mt-1 text-sm font-medium">{config.aspectRatio} · {config.resolution}</p>
                  </div>
                  <div className="rounded-lg border border-border/50 bg-muted/10 p-3">
                    <p className="text-xs text-muted-foreground">{t("ttsLabel")}</p>
                    <p className="mt-1 text-sm font-medium">{config.ttsEnabled ? t("ttsEnableLabel") : t("videoResultDisabled")}</p>
                  </div>
                  <div className="rounded-lg border border-border/50 bg-muted/10 p-3">
                    <p className="text-xs text-muted-foreground">{t("bgmSectionLabel")}</p>
                    <p className="mt-1 text-sm font-medium">
                      {config.bgm === "none"
                        ? t("bgmNone")
                        : t(bgmOptions.find((option) => option.value === config.bgm)?.labelKey ?? "bgmUpbeat")}
                    </p>
                  </div>
                  <div className="rounded-lg border border-border/50 bg-muted/10 p-3">
                    <p className="text-xs text-muted-foreground">{t("subtitleLabel")}</p>
                    <p className="mt-1 text-sm font-medium">
                      {config.subtitlePosition === "bottom"
                        ? t("subtitleBottom")
                        : config.subtitlePosition === "center"
                        ? t("subtitleCenter")
                        : t("subtitleTop")}
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
        )}

        <details className="hidden">
          <summary className="cursor-pointer list-none rounded-lg border border-border/60 bg-muted/20 px-4 py-2 text-sm font-medium text-muted-foreground transition hover:text-foreground">
            {t("advancedSettings")}
          </summary>
        <div className="mt-4 grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* 左侧：视频时间线 */}
          <div className="lg:col-span-2">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h2 className="text-base font-semibold">{t("timelineTitle")}</h2>
                <p className="text-xs text-muted-foreground mt-0.5">{t("timelineMeta", { count: clips.length, duration: totalDuration })}</p>
              </div>
              <Link href={`/project/${id}/motion`}>
                <Button variant="outline" size="sm" className="text-xs">
                  <LuArrowLeft className="w-3.5 h-3.5 mr-1" />
                  {t("backToMotion")}
                </Button>
              </Link>
            </div>

            <details>
              <summary className="cursor-pointer list-none rounded-lg border border-border/60 bg-muted/20 px-4 py-2 text-sm font-medium text-muted-foreground transition hover:text-foreground">
                {t("viewVideoDetails")}
              </summary>
            <div className="mt-3">
            {loading ? (
              <div className="flex flex-col items-center justify-center rounded-lg border border-border/40 bg-muted/10 py-16 text-muted-foreground">
                <LuLoaderCircle className="mb-3 h-5 w-5 animate-spin" />
                <p className="text-sm">{t("loadingShots")}</p>
              </div>
            ) : loadError ? (
              <div className="rounded-lg border border-destructive/20 bg-destructive/10 p-4 text-sm text-destructive">
                {loadError}
              </div>
            ) : (
              <div className="space-y-1">
                {clips.map((clip, index) => {
                  const typeInfo = shotTypeLabels[clip.type];
                  return (
                    <div key={clip.shotId}>
                      {/* 片段卡片 */}
                      <Card className="glass-card">
                        <CardContent className="p-4">
                          <div className="flex items-center gap-4">
                            {/* 缩略图：有已生成的画面就直接预览，否则回退占位图 */}
                            <div className="w-20 h-14 bg-muted/30 rounded-md shrink-0 overflow-hidden border border-border/30 relative">
                              <div className="absolute inset-0 bg-gradient-to-br from-primary/20 to-primary/5 flex items-center justify-center">
                                <LuPlay className="w-4 h-4 text-primary/60" />
                              </div>
                              {thumbs[clip.shotId] &&
                                (isVideoPath(thumbs[clip.shotId]) ? (
                                  <video
                                    src={thumbs[clip.shotId]}
                                    muted
                                    playsInline
                                    preload="metadata"
                                    className="absolute inset-0 w-full h-full object-cover"
                                  />
                                ) : (
                                  // eslint-disable-next-line @next/next/no-img-element
                                  <img
                                    src={thumbs[clip.shotId]}
                                    alt=""
                                    className="absolute inset-0 w-full h-full object-cover"
                                  />
                                ))}
                            </div>

                            {/* 信息 */}
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2 mb-1">
                                <Badge className={`${typeInfo.color} border-0 text-[10px]`}>
                                  {t(typeInfo.labelKey)}
                                </Badge>
                                <span className="text-xs text-muted-foreground">{clip.duration}s</span>
                              </div>
                              <p className="text-xs text-muted-foreground truncate">
                                🎙 {clip.voiceover}
                              </p>
                            </div>

                            {/* 序号 */}
                            <span className="text-sm font-bold text-muted-foreground/30 shrink-0">
                              {String(clip.shotId).padStart(2, "0")}
                            </span>
                          </div>
                        </CardContent>
                      </Card>

                      {/* 转场选择器（最后一个片段后面不显示） */}
                      {index < clips.length - 1 && (
                        <div className="flex items-center justify-center py-1.5">
                          <details className="text-center">
                            <summary className="cursor-pointer list-none rounded-full border border-border/30 bg-muted/20 px-3 py-1 text-[11px] text-muted-foreground">
                              {t("transitionSetting")}
                            </summary>
                            <div className="mt-1 flex items-center gap-2 px-3 py-1 rounded-full bg-muted/20 border border-border/30">
                              <LuChevronDown className="w-3 h-3 text-muted-foreground" />
                              <select
                                value={clip.transition}
                                onChange={(e) => updateTransition(clip.shotId, e.target.value)}
                                className="text-[11px] text-muted-foreground bg-transparent border-none outline-none cursor-pointer"
                              >
                                <option value="ai_start_end">{t(transitionLabels.ai_start_end)}</option>
                                <option value="ai_reference">{t(transitionLabels.ai_reference)}</option>
                                <option value="direct_concat">{t(transitionLabels.direct_concat)}</option>
                                <option value="ffmpeg_fade">{t(transitionLabels.ffmpeg_fade)}</option>
                              </select>
                            </div>
                          </details>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
            </div>
            </details>
          </div>

          {/* 右侧：合成配置 */}
          <div className="lg:col-span-1 space-y-4">
            <h2 className="text-base font-semibold">{t("composeSettings")}</h2>
            <Card className="glass-card">
              <CardContent className="p-4">
                <p className="text-sm font-medium text-foreground">{t("defaultComposeReady")}</p>
                <p className="mt-1 text-xs text-muted-foreground">{t("timelineMeta", { count: clips.length, duration: totalDuration })}</p>
              </CardContent>
            </Card>

            <details className="space-y-4">
              <summary className="cursor-pointer list-none rounded-lg border border-border/60 bg-muted/20 px-4 py-2 text-sm font-medium text-muted-foreground transition hover:text-foreground">
                {t("advancedSettings")}
              </summary>

            {/* 配音设置 */}
            <Card className="glass-card">
              <CardContent className="p-4 space-y-4">
                <div className="flex items-center justify-between">
                  <Label className="text-sm font-medium">{t("ttsLabel")}</Label>
                  {!paidTtsReady && (
                    <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">{t("ttsFreeBadge")}</span>
                  )}
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-xs text-muted-foreground">{t("ttsEnableLabel")}</span>
                  <button
                    onClick={() => setConfig((c) => ({ ...c, ttsEnabled: !c.ttsEnabled }))}
                    className={`relative w-10 h-5 rounded-full transition-colors ${config.ttsEnabled ? "bg-primary" : "bg-muted"}`}
                  >
                    <div className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-transform ${config.ttsEnabled ? "translate-x-5" : "translate-x-0.5"}`} />
                  </button>
                </div>
                {config.ttsEnabled && paidTtsReady && (
                  <p className="text-[11px] text-muted-foreground">
                    {t("ttsPaidHint")}
                  </p>
                )}
                {config.ttsEnabled && !paidTtsReady && (
                  <div className="space-y-2">
                    <Select value={config.freeVoice} onValueChange={(v) => setConfig((c) => ({ ...c, freeVoice: v ?? c.freeVoice }))}>
                      <SelectTrigger className="bg-muted/30 border-border/50 text-xs">
                        {/* Base UI 的 Select.Value 默认显示原始 value，用函数子节点映射为中文标签 */}
                        <SelectValue>
                          {(value: string) => {
                            const o = freeVoiceOptions.find((o) => o.value === value);
                            return o ? t(o.labelKey) : value;
                          }}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        {freeVoiceOptions.map((o) => (
                          <SelectItem key={o.value} value={o.value}>
                            {t(o.labelKey)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <button
                      onClick={previewFreeVoice}
                      disabled={previewingVoice}
                      className="text-[11px] text-primary hover:underline disabled:opacity-50"
                    >
                      {previewingVoice ? t("ttsPreviewing") : t("ttsPreviewCta")}
                    </button>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* 背景音乐 */}
            <Card className="glass-card">
              <CardContent className="p-4 space-y-3">
                <Label className="text-sm font-medium">{t("bgmSectionLabel")}</Label>
                <Select value={config.bgm} onValueChange={(v) => setConfig((c) => ({ ...c, bgm: v ?? c.bgm }))}>
                  <SelectTrigger className="bg-muted/30 border-border/50 text-xs">
                    {/* Base UI 的 Select.Value 默认显示原始 value，用函数子节点映射为中文标签 */}
                    <SelectValue>
                      {(value: string) => {
                        const o = bgmOptions.find((o) => o.value === value);
                        return o ? t(o.labelKey) : value;
                      }}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {bgmOptions.map((o) => (
                      <SelectItem key={o.value} value={o.value}>
                        {t(o.labelKey)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {/* 旁白闪避：旁白一响压低 BGM、停顿回升，旁白更清晰 */}
                <div className="flex items-center justify-between pt-1">
                  <span className="text-xs text-muted-foreground">{t("bgmDuckLabel")}</span>
                  <button
                    onClick={() => setConfig((c) => ({ ...c, bgmDuck: !c.bgmDuck }))}
                    className={`relative w-10 h-5 rounded-full transition-colors ${config.bgmDuck ? "bg-primary" : "bg-muted"}`}
                  >
                    <div className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-transform ${config.bgmDuck ? "translate-x-5" : "translate-x-0.5"}`} />
                  </button>
                </div>
              </CardContent>
            </Card>

            {/* 字幕设置 */}
            <Card className="glass-card">
              <CardContent className="p-4 space-y-3">
                <Label className="text-sm font-medium">{t("subtitleLabel")}</Label>
                <div className="grid grid-cols-3 gap-2">
                  {(["bottom", "center", "top"] as const).map((pos) => (
                    <button
                      key={pos}
                      onClick={() => setConfig((c) => ({ ...c, subtitlePosition: pos }))}
                      className={`h-9 rounded-md text-xs border transition-all ${
                        config.subtitlePosition === pos
                          ? "border-primary bg-primary/10 text-primary"
                          : "border-border/50 bg-muted/20 text-muted-foreground hover:border-primary/40"
                      }`}
                    >
                      {pos === "bottom" ? t("subtitleBottom") : pos === "center" ? t("subtitleCenter") : t("subtitleTop")}
                    </button>
                  ))}
                </div>
                {/* 卡拉OK逐字高亮字幕（整句留屏，逐字随旁白变色，爆款字幕样式） */}
                <div className="flex items-center justify-between pt-1">
                  <span className="text-xs text-muted-foreground">{t("karaokeLabel")}</span>
                  <button
                    onClick={() => setConfig((c) => ({ ...c, karaoke: !c.karaoke }))}
                    className={`relative w-10 h-5 rounded-full transition-colors ${config.karaoke ? "bg-primary" : "bg-muted"}`}
                  >
                    <div className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-transform ${config.karaoke ? "translate-x-5" : "translate-x-0.5"}`} />
                  </button>
                </div>
              </CardContent>
            </Card>

            {/* 合规与转化：AI 生成标识 + 购买 CTA 片尾 */}
            <Card className="glass-card">
              <CardContent className="p-4 space-y-3">
                <Label className="text-sm font-medium">{t("complianceLabel")}</Label>
                <div className="flex items-center justify-between">
                  <span className="text-xs text-muted-foreground">{t("aiDisclosureLabel")}</span>
                  <span className="rounded-full bg-emerald-500/10 px-2 py-1 text-[11px] font-medium text-emerald-600">
                    {t("aiDisclosureRequired")}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-xs text-muted-foreground">{t("ctaLabel")}</span>
                  <button
                    onClick={() =>
                      setConfig((c) => {
                        const enabling = !c.ctaEnabled;
                        // 开启且文案为空时，用当前语言的 placeholder 预填，保留一键便利又随语言走
                        return { ...c, ctaEnabled: enabling, ctaText: enabling && !c.ctaText.trim() ? t("ctaPlaceholder") : c.ctaText };
                      })
                    }
                    className={`relative w-10 h-5 rounded-full transition-colors ${config.ctaEnabled ? "bg-primary" : "bg-muted"}`}
                  >
                    <div className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-transform ${config.ctaEnabled ? "translate-x-5" : "translate-x-0.5"}`} />
                  </button>
                </div>
                {config.ctaEnabled && (
                  <Input
                    value={config.ctaText}
                    onChange={(e) => setConfig((c) => ({ ...c, ctaText: e.target.value }))}
                    placeholder={t("ctaPlaceholder")}
                    className="bg-muted/30 border-border/50 text-xs"
                  />
                )}
                <div className="flex items-center justify-between">
                  <span className="text-xs text-muted-foreground">{t("productCardLabel")}</span>
                  <button
                    onClick={() => setConfig((c) => ({ ...c, productCard: !c.productCard }))}
                    className={`relative w-10 h-5 rounded-full transition-colors ${config.productCard ? "bg-primary" : "bg-muted"}`}
                  >
                    <div className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-transform ${config.productCard ? "translate-x-5" : "translate-x-0.5"}`} />
                  </button>
                </div>
              </CardContent>
            </Card>

            {/* 画面设置 */}
            <Card className="glass-card">
              <CardContent className="p-4 space-y-4">
                <Label className="text-sm font-medium">{t("canvasLabel")}</Label>
                {/* 渲染质量预设：快速/标准/高清（选中同步分辨率） */}
                <div className="space-y-2">
                  <span className="text-xs text-muted-foreground">{t("renderQualityLabel")}</span>
                  <div className="grid grid-cols-3 gap-2">
                    {(["fast", "standard", "hd"] as const).map((preset) => (
                      <button
                        key={preset}
                        onClick={() =>
                          setConfig((c) => ({ ...c, renderPreset: preset, resolution: RENDER_PRESETS[preset].resolution }))
                        }
                        className={`flex flex-col items-center gap-0.5 rounded-md py-1.5 text-xs border transition-all ${
                          config.renderPreset === preset
                            ? "border-primary bg-primary/10 text-primary"
                            : "border-border/50 bg-muted/20 text-muted-foreground hover:border-primary/40"
                        }`}
                      >
                        <span className="font-medium">{t(`renderPreset_${preset}`)}</span>
                        <span className="text-[10px] opacity-70">{RENDER_PRESETS[preset].resolution}</span>
                      </button>
                    ))}
                  </div>
                  <p className="text-[11px] text-muted-foreground">{t(`renderPresetDesc_${config.renderPreset}`)}</p>
                </div>
                {/* 比例 */}
                <div className="space-y-2">
                  <span className="text-xs text-muted-foreground">{t("aspectRatioLabel")}</span>
                  <div className="grid grid-cols-3 gap-2">
                    {(["9:16", "16:9", "1:1"] as const).map((ratio) => (
                      <button
                        key={ratio}
                        onClick={() => setConfig((c) => ({ ...c, aspectRatio: ratio }))}
                        className={`h-9 rounded-md text-xs border transition-all ${
                          config.aspectRatio === ratio
                            ? "border-primary bg-primary/10 text-primary"
                            : "border-border/50 bg-muted/20 text-muted-foreground hover:border-primary/40"
                        }`}
                      >
                        {ratio === "9:16" ? t("aspectVertical") : ratio === "16:9" ? t("aspectHorizontal") : t("aspectSquare")}
                      </button>
                    ))}
                  </div>
                </div>
                {/* 分辨率 */}
                <div className="space-y-2">
                  <span className="text-xs text-muted-foreground">{t("resolutionLabel")}</span>
                  <div className="grid grid-cols-2 gap-2">
                    {(["720p", "1080p"] as const).map((res) => (
                      <button
                        key={res}
                        onClick={() => setConfig((c) => ({ ...c, resolution: res }))}
                        className={`h-9 rounded-md text-xs border transition-all ${
                          config.resolution === res
                            ? "border-primary bg-primary/10 text-primary"
                            : "border-border/50 bg-muted/20 text-muted-foreground hover:border-primary/40"
                        }`}
                      >
                        {res}
                      </button>
                    ))}
                  </div>
                </div>
              </CardContent>
            </Card>
            </details>

            {/* 合成按钮 */}
            <div className="space-y-3">
              {/* 背景音乐（可选，合成时混入并自动压低让位配音） */}
              <div className="flex items-center justify-between p-3 rounded-lg border border-border/40 bg-muted/10">
                <div className="min-w-0">
                  <p className="text-xs font-medium">{t("bgmOptionalTitle")}</p>
                  <p className="text-[11px] text-muted-foreground truncate">{bgm ? t("bgmSelected", { name: bgm.name }) : t("bgmUploadHint")}</p>
                </div>
                <label className="shrink-0">
                  <input type="file" accept="audio/*" className="hidden" disabled={isComposing || bgmUploading}
                    onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadBgm(f); e.target.value = ""; }} />
                  <span className={`inline-flex items-center h-8 px-3 rounded-md border border-border/60 text-xs cursor-pointer hover:border-primary/50 ${(isComposing || bgmUploading) ? "opacity-50 pointer-events-none" : ""}`}>
                    {bgmUploading ? t("bgmUploading") : bgm ? t("bgmReplace") : t("bgmUploadCta")}
                  </span>
                </label>
              </div>

              {/* 合成进度 */}
              {(isComposing || composeDone) && (
                <div>
                  <div className="h-2 bg-muted/30 rounded-full overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all duration-200 ${composeDone ? "bg-foreground" : "brand-gradient"}`}
                      style={{ width: `${composeProgress}%` }}
                    />
                  </div>
                  <p className="text-xs text-muted-foreground text-center mt-2">
                    {composeDone ? t("composeDoneMsg") : t("composingMsg", { progress: composeProgress })}
                  </p>
                </div>
              )}

              {/* 合成失败提示 */}
              {composeError && (
                <div className="p-3 rounded-lg bg-destructive/10 border border-destructive/20">
                  <p className="text-xs text-destructive">⚠ {composeError}</p>
                </div>
              )}

              {/* 成片预览 */}
              {composeDone && outputUrl && (
                <div className="rounded-lg overflow-hidden border border-border/50 bg-black">
                  <video src={outputUrl} controls className="w-full max-h-[360px]" />
                </div>
              )}

              {composeDone && outputUrl && (
                <>
                  <Button
                    onClick={startCompose}
                    disabled={isComposing || clips.length === 0}
                    className="w-full brand-gradient text-white"
                  >
                    {isComposing ? (
                      <>
                        <LuLoaderCircle className="animate-spin mr-2 h-4 w-4" />
                        {t("composing")}
                      </>
                    ) : (
                      t("composeRedo")
                    )}
                  </Button>
                  <a href={`${outputUrl}?download=1`} download>
                    <Button variant="outline" className="w-full">{t("downloadVideo")}</Button>
                  </a>
                </>
              )}
            </div>
          </div>
        </div>
        </details>
      </main>
    </div>
  );
}
