"use client";

import { type CSSProperties, type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  AlertCircle,
  ArrowUp,
  BellRing,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock,
  FileVideo2,
  History,
  ImagePlus,
  Loader2,
  Menu,
  MonitorSmartphone,
  MoreHorizontal,
  PackageSearch,
  Play,
  Search,
  SlidersHorizontal,
  Sparkles,
  X,
} from "lucide-react";
import { useLocale } from "@frontend/i18n";
import { friendlyError } from "@backend/shared/friendly-error";
import { MAX_PRODUCT_IMAGES, isSupportedImageFile } from "@backend/shared/image-file";
import { useAgentDraftStore } from "@frontend/stores/agent-draft-store";
import { useVideoApprovalStore } from "@frontend/stores/video-approval-store";
import { BrandWheatMark } from "@frontend/components/brand-wheat-logo";
import {
  LOW_GENERATION_INVENTORY_THRESHOLD,
  coerceGenerationProjects,
  coerceRankedPublishCandidates,
  compactCount,
  filterProjects,
  formatProjectDate,
  isLowGenerationInventory,
  isProjectApproved,
  isProjectComplete,
  projectCover,
  projectStageHref,
  projectStatusClass,
  projectStatusText,
  projectTitle,
  publishPickStrategyOptions,
  rankTodayPublishCandidates,
  sortProjectsByUpdatedDesc,
  type GenerationProject,
  type RankedPublishCandidate,
} from "@frontend/lib/generation-records";
import {
  AGENT_GENERATION_SETTINGS_LATEST_KEY,
  DEFAULT_AGENT_GENERATION_SETTINGS,
  normalizeAgentGenerationSettings,
  parseStoredAgentGenerationSettings,
  projectAgentGenerationSettingsKey,
  type AgentAspectRatio,
  type AgentGenerationSettings,
  type AgentResolution,
  type AgentTargetDuration,
} from "@backend/core/agent/agent-generation-settings";
import type { RenderPreset } from "@backend/core/media/compose-presets";

interface PickedImage {
  id: string;
  url: string;
  file: File;
}

const showcaseItems = [
  { videoSrc: "/case-videos/case-01.mp4" },
  { videoSrc: "/case-videos/case-02.mp4" },
  { videoSrc: "/case-videos/case-03.mp4" },
  { videoSrc: "/case-videos/case-04.mp4" },
  { videoSrc: "/case-videos/case-05.mp4" },
];

const showcaseRows = Array.from({ length: Math.ceil(showcaseItems.length / 3) }, (_, index) =>
  showcaseItems.slice(index * 3, index * 3 + 3)
);

const userSessionKey = "clipforge_user_session";

const qualityOptions: { value: "standard" | "hd"; label: string; resolution: AgentResolution; renderPreset: RenderPreset }[] = [
  { value: "standard", label: "标准", resolution: "720p", renderPreset: "fast" },
  { value: "hd", label: "高清", resolution: "1080p", renderPreset: "hd" },
];

const aspectRatioOptions: { value: AgentAspectRatio; label: string; detail: string }[] = [
  { value: "9:16", label: "竖屏", detail: "短视频" },
  { value: "16:9", label: "横屏", detail: "横版投放" },
  { value: "1:1", label: "方形", detail: "信息流" },
];

const agentLayoutStyle = {
  "--agent-rail-width": "clamp(72px, 5.8vw, 84px)",
} as CSSProperties;

const targetDurationOptions: { value: AgentTargetDuration; label: string }[] = [
  { value: 15, label: "15s" },
  { value: 30, label: "30s" },
  { value: 45, label: "45s" },
];

const wrappedUnderlayClass =
  "shadow-[0_0_0_1px_rgba(17,24,39,0.035),0_2px_8px_rgba(17,24,39,0.08),0_10px_0_rgba(17,24,39,0.13)]";

const PUBLISH_REMINDER_INITIAL_DELAY_MS = 12_000;
const PUBLISH_REMINDER_INTERVAL_MS = 30 * 60 * 1000;

function inferProductName(idea: string, images: PickedImage[]) {
  const text = idea.trim();
  if (text) return text.slice(0, 60);
  const fileName = images[0]?.file.name.replace(/\.[^.]+$/, "").trim();
  return fileName || "商品推广";
}

function publishHref(project: GenerationProject) {
  return `/project/${project.id}/export?publishReady=1`;
}

function hasSavedUserSession() {
  try {
    return typeof window !== "undefined" && window.localStorage?.getItem(userSessionKey) !== null;
  } catch {
    return false;
  }
}

function saveUserSession(phone: string) {
  try {
    window.localStorage?.setItem(userSessionKey, JSON.stringify({ phone, loggedAt: new Date().toISOString() }));
  } catch {
    // 登录态仅用于当前前端体验；存储不可用时仍允许用户进入创作界面。
  }
}

export default function AgentProjectPage() {
  const router = useRouter();
  const locale = useLocale();
  const draft = useAgentDraftStore((state) => state.draft);
  const clearDraft = useAgentDraftStore((state) => state.clearDraft);
  const approvedVideos = useVideoApprovalStore((state) => state.approved);
  const publishedVideos = useVideoApprovalStore((state) => state.published);
  const approveProject = useVideoApprovalStore((state) => state.approveProject);
  const unapproveProject = useVideoApprovalStore((state) => state.unapproveProject);
  const dailyPickCount = useVideoApprovalStore((state) => state.dailyPickCount);
  const setDailyPickCount = useVideoApprovalStore((state) => state.setDailyPickCount);
  const publishPickStrategy = useVideoApprovalStore((state) => state.publishPickStrategy);
  const setPublishPickStrategy = useVideoApprovalStore((state) => state.setPublishPickStrategy);

  const [idea, setIdea] = useState("");
  const [images, setImages] = useState<PickedImage[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uploadHint, setUploadHint] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ percent: number; message: string } | null>(null);
  const [pendingPublishOpen, setPendingPublishOpen] = useState(false);
  const [publishReminderVisible, setPublishReminderVisible] = useState(false);
  const [historyItems, setHistoryItems] = useState<GenerationProject[]>([]);
  const [historyQuery, setHistoryQuery] = useState("");
  const [isLoadingHistory, setIsLoadingHistory] = useState(true);
  const [pendingPublishRankedItems, setPendingPublishRankedItems] = useState<RankedPublishCandidate[]>([]);
  const [isPickingPublishItems, setIsPickingPublishItems] = useState(false);
  const [publishPickSource, setPublishPickSource] = useState<"llm" | "rule">("rule");
  const [historyPanelOpen, setHistoryPanelOpen] = useState(false);
  const [loginOpen, setLoginOpen] = useState(false);
  const [isUserLoggedIn, setIsUserLoggedIn] = useState(false);
  const [phone, setPhone] = useState("");
  const [verificationCode, setVerificationCode] = useState("");
  const [codeSent, setCodeSent] = useState(false);
  const [agreed, setAgreed] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsHydrated, setSettingsHydrated] = useState(false);
  const [generationSettings, setGenerationSettings] = useState<AgentGenerationSettings>(DEFAULT_AGENT_GENERATION_SETTINGS);

  const fileRef = useRef<HTMLInputElement>(null);
  const initializedRef = useRef(false);
  const imagesRef = useRef<PickedImage[]>([]);

  const appendFiles = useCallback((files: File[] | FileList | null) => {
    if (!files) return;
    const incoming = Array.from(files);
    if (incoming.length === 0) return;

    const current = imagesRef.current;
    const remaining = MAX_PRODUCT_IMAGES - current.length;
    if (remaining <= 0) {
      setUploadHint(`最多上传 ${MAX_PRODUCT_IMAGES} 张商品图`);
      return;
    }

    const imageFiles = incoming.filter(isSupportedImageFile);
    const next = imageFiles
      .slice(0, remaining)
      .map((file) => ({ id: crypto.randomUUID(), url: URL.createObjectURL(file), file }));

    if (next.length === 0) {
      setUploadHint("未识别到图片，请选择 PNG、JPG、WebP、HEIC 等图片文件");
      return;
    }

    const updated = [...current, ...next];
    imagesRef.current = updated;
    setImages(updated);

    const ignoredCount = incoming.length - imageFiles.length;
    const overflowCount = Math.max(0, imageFiles.length - remaining);
    const hints = [`已添加 ${next.length} 张`];
    if (overflowCount > 0) hints.push(`已达 ${MAX_PRODUCT_IMAGES} 张上限`);
    if (ignoredCount > 0) hints.push(`${ignoredCount} 个文件不是图片，已忽略`);
    setUploadHint(hints.join("，"));
  }, []);

  useEffect(() => {
    imagesRef.current = images;
  }, [images]);

  useEffect(() => {
    setIsUserLoggedIn(hasSavedUserSession());
  }, []);

  useEffect(() => {
    const saved = parseStoredAgentGenerationSettings(
      typeof window !== "undefined" ? window.localStorage?.getItem(AGENT_GENERATION_SETTINGS_LATEST_KEY) : null
    );
    if (saved) setGenerationSettings(saved);
    setSettingsHydrated(true);
  }, []);

  useEffect(() => {
    if (!settingsHydrated) return;
    try {
      window.localStorage?.setItem(AGENT_GENERATION_SETTINGS_LATEST_KEY, JSON.stringify(generationSettings));
    } catch {
      // 仅记住用户上次选择；存储不可用时仍可继续生成。
    }
  }, [generationSettings, settingsHydrated]);

  useEffect(() => {
    return () => {
      imagesRef.current.forEach((image) => URL.revokeObjectURL(image.url));
    };
  }, []);

  useEffect(() => {
    if (initializedRef.current) return;
    initializedRef.current = true;

    const queryPrompt = new URLSearchParams(window.location.search).get("prompt")?.trim() ?? "";
    const prompt = draft?.prompt?.trim() || queryPrompt;
    if (prompt) setIdea(prompt);
    if (draft?.files?.length) appendFiles(draft.files);
    clearDraft();
  }, [appendFiles, clearDraft, draft]);

  useEffect(() => {
    let ignore = false;

    async function loadGenerationHistory() {
      setIsLoadingHistory(true);
      try {
        const res = await fetch("/api/project", { cache: "no-store" });
        const data: unknown = await res.json().catch(() => []);
        if (!res.ok || ignore) return;

        setHistoryItems(sortProjectsByUpdatedDesc(coerceGenerationProjects(data)));
      } catch {
        if (!ignore) setHistoryItems([]);
      } finally {
        if (!ignore) setIsLoadingHistory(false);
      }
    }

    loadGenerationHistory();
    return () => {
      ignore = true;
    };
  }, []);

  const removeImage = (id: string) => {
    setImages((prev) => {
      const target = prev.find((image) => image.id === id);
      if (target) URL.revokeObjectURL(target.url);
      const next = prev.filter((image) => image.id !== id);
      imagesRef.current = next;
      if (next.length === 0) {
        setUploadHint(null);
        setSettingsOpen(false);
      }
      return next;
    });
  };

  const clearImages = () => {
    imagesRef.current.forEach((image) => URL.revokeObjectURL(image.url));
    imagesRef.current = [];
    setImages([]);
    setUploadHint(null);
    setSettingsOpen(false);
  };

  const canSubmit = images.length > 0;
  const primaryImage = images[0];
  const extraImages = images.slice(1, 4);
  const hiddenExtraImageCount = Math.max(0, images.length - 4);
  const canLogin = phone.trim().length > 0 && verificationCode.trim().length > 0 && agreed;
  const fallbackPendingPublishItems = useMemo(
    () => rankTodayPublishCandidates(historyItems, approvedVideos, dailyPickCount, publishPickStrategy, new Date(), publishedVideos),
    [approvedVideos, dailyPickCount, historyItems, publishedVideos, publishPickStrategy]
  );
  const pendingPublishItems = pendingPublishRankedItems.length > 0 ? pendingPublishRankedItems : fallbackPendingPublishItems;
  useEffect(() => {
    if (!pendingPublishOpen) return;
    let ignore = false;

    if (fallbackPendingPublishItems.length === 0) {
      setPendingPublishRankedItems([]);
      setPublishPickSource("rule");
      setIsPickingPublishItems(false);
      return;
    }

    setPendingPublishRankedItems(fallbackPendingPublishItems);
    setPublishPickSource("rule");
    setIsPickingPublishItems(true);

    async function rankPendingItems() {
      try {
        const res = await fetch("/api/llm/publish-ranker", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            projects: historyItems,
            approved: approvedVideos,
            published: publishedVideos,
            count: dailyPickCount,
            strategy: publishPickStrategy,
          }),
        });
        const data: unknown = await res.json().catch(() => ({}));
        if (!res.ok || ignore) return;
        const response = data as { candidates?: unknown; source?: unknown };
        const ranked = coerceRankedPublishCandidates(response.candidates);
        setPendingPublishRankedItems(ranked.length > 0 ? ranked : fallbackPendingPublishItems);
        setPublishPickSource(response.source === "llm" ? "llm" : "rule");
      } catch {
        if (!ignore) {
          setPendingPublishRankedItems(fallbackPendingPublishItems);
          setPublishPickSource("rule");
        }
      } finally {
        if (!ignore) setIsPickingPublishItems(false);
      }
    }

    rankPendingItems();
    return () => {
      ignore = true;
    };
  }, [
    approvedVideos,
    dailyPickCount,
    fallbackPendingPublishItems,
    historyItems,
    pendingPublishOpen,
    publishedVideos,
    publishPickStrategy,
  ]);
  const approvedInventoryCount = useMemo(
    () => historyItems.filter((project) => isProjectApproved(project, approvedVideos)).length,
    [approvedVideos, historyItems]
  );
  const hasLowInventory = !isLoadingHistory && isLowGenerationInventory(approvedInventoryCount);
  const inventoryDeficit = Math.max(0, LOW_GENERATION_INVENTORY_THRESHOLD - approvedInventoryCount);
  const pendingPublishCount = pendingPublishItems.length;
  const publishReminderCandidate = pendingPublishItems[0];
  const filteredHistoryItems = useMemo(
    () => filterProjects(historyItems, historyQuery),
    [historyItems, historyQuery]
  );

  useEffect(() => {
    if (pendingPublishCount === 0) {
      setPublishReminderVisible(false);
      return;
    }

    let ignore = false;
    const showReminder = () => {
      if (!ignore) setPublishReminderVisible(true);
    };
    const firstTimer = window.setTimeout(showReminder, PUBLISH_REMINDER_INITIAL_DELAY_MS);
    const interval = window.setInterval(showReminder, PUBLISH_REMINDER_INTERVAL_MS);

    return () => {
      ignore = true;
      window.clearTimeout(firstTimer);
      window.clearInterval(interval);
    };
  }, [pendingPublishCount]);

  const selectedQuality =
    qualityOptions.find((item) => item.resolution === generationSettings.resolution) ??
    qualityOptions[0];
  const selectedAspectRatio = aspectRatioOptions.find((item) => item.value === generationSettings.aspectRatio) ?? aspectRatioOptions[0];
  const generationSummary = `${selectedAspectRatio.label} · ${generationSettings.targetDuration}s · ${selectedQuality.label}`;
  const shouldShowUploadHint = Boolean(uploadHint && !/^已添加 \d+ 张$/.test(uploadHint));

  const updateGenerationSettings = (patch: Partial<AgentGenerationSettings>) => {
    setGenerationSettings((current) => normalizeAgentGenerationSettings({ ...current, ...patch }));
  };

  const selectQuality = (quality: typeof qualityOptions[number]) => {
    setGenerationSettings((current) => ({
      ...current,
      renderPreset: quality.renderPreset,
      resolution: quality.resolution,
    }));
  };

  const handleLoginSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canLogin) return;
    saveUserSession(phone.trim());
    setIsUserLoggedIn(true);
    setLoginOpen(false);
    router.replace("/project/agent");
  };

  const handleSubmit = async () => {
    if (!canSubmit || isSubmitting) return;
    setIsSubmitting(true);
    setError(null);

    const productName = inferProductName(idea, images);
    const productDescription = idea.trim();

    try {
      setProgress({ percent: 16, message: "正在接收素材" });
      const projectRes = await fetch("/api/project", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: `${productName} 推广`,
          productName,
          productCategory: "other",
          productDescription,
          productImages: [],
          videoMode: "product_closeup",
        }),
      });
      const project = await projectRes.json().catch(() => ({}));
      if (!projectRes.ok || !project.id) throw new Error(project.error || "项目创建失败");
      try {
        window.localStorage?.setItem(projectAgentGenerationSettingsKey(project.id), JSON.stringify(generationSettings));
      } catch {
        // 项目级生成偏好用于后续页面默认值；写入失败不阻断主流程。
      }

      setProgress({ percent: 38, message: "正在上传商品图片" });
      const formData = new FormData();
      images.forEach((image) => formData.append("files", image.file));
      formData.append("projectId", project.id);
      const uploadRes = await fetch("/api/upload", { method: "POST", body: formData });
      const uploadData = await uploadRes.json().catch(() => ({}));
      if (!uploadRes.ok || !Array.isArray(uploadData.paths)) throw new Error(uploadData.error || "图片上传失败");

      const patchRes = await fetch(`/api/project/${project.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ productImages: uploadData.paths }),
      });
      if (!patchRes.ok) throw new Error("项目图片保存失败");

      setProgress({ percent: 70, message: "Agent 正在生成短片方案" });
      const scriptRes = await fetch("/api/llm/script", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: project.id,
          productName,
          category: "other",
          productDescription,
          targetDuration: generationSettings.targetDuration,
          styleType: "auto",
          videoMode: "product_closeup",
          productImages: uploadData.paths,
          platforms: "douyin",
          quick: true,
          count: 1,
          timeoutMs: 10000,
          maxTokens: 2500,
        }),
      });
      const scriptData = await scriptRes.json().catch(() => ({}));
      if (!scriptRes.ok) throw new Error(scriptData.error || "脚本生成失败");

      setProgress({ percent: 100, message: "正在进入生成工作台" });
      router.push(`/project/${project.id}/script`);
    } catch (err) {
      setError(friendlyError(err, locale));
      setIsSubmitting(false);
      setProgress(null);
    }
  };

  return (
    <div className="relative min-h-screen text-[#111111]" style={agentLayoutStyle}>
      <video className="fixed inset-0 h-full w-full object-cover" autoPlay muted loop playsInline preload="auto" aria-hidden="true">
        <source src="/showcase-bg.mp4" type="video/mp4" />
      </video>
      <div className="fixed inset-0 bg-[#F6F7F9]/75" aria-hidden="true" />
      <div className="relative z-[1]">
      <aside className="fixed inset-y-0 left-0 z-20 hidden w-[var(--agent-rail-width)] flex-col items-center border-r border-[#E2E5EA] bg-white px-2 py-6 lg:flex xl:px-3 xl:py-7">
        <Link href="/project/agent" className="mb-12 grid h-11 w-9 place-items-center text-[#111827] xl:mb-14 xl:h-12 xl:w-10" aria-label="创作界面">
          <BrandWheatMark className="h-10 w-8 xl:h-11 xl:w-9" />
        </Link>
        <nav className="flex flex-1 flex-col items-center gap-7 text-[12px] font-semibold text-[#3E4652] xl:gap-8 xl:text-[13px]">
          <span className="flex flex-col items-center gap-1.5 text-[#111111]">
            <Sparkles className="size-6 stroke-[2.6] xl:size-7" />
            <span>生成</span>
          </span>
          <Link href="/products" className="flex flex-col items-center gap-1.5">
            <span className="relative">
              <PackageSearch className="size-6 stroke-[2.4] xl:size-7" />
              {!isLoadingHistory && (
                <span
                  className={`absolute -right-3 -top-2 grid min-w-5 place-items-center rounded-full px-1.5 py-0.5 text-[10px] font-black leading-none ${
                    hasLowInventory ? "bg-[#111111] text-white" : "bg-[#E2E5EA] text-[#3E4652]"
                  }`}
                  aria-label={`生成库存 ${approvedInventoryCount} 条`}
                >
                  {compactCount(approvedInventoryCount)}
                </span>
              )}
            </span>
            <span>生成库存</span>
          </Link>
          <div className="flex flex-col items-center gap-2">
            <button
              type="button"
              onClick={() => setPendingPublishOpen((open) => !open)}
              className={`flex flex-col items-center gap-1.5 transition hover:text-[#111111] ${pendingPublishOpen ? "text-[#111111]" : ""}`}
            >
              <span className="relative">
                <FileVideo2 className="size-6 stroke-[2.4] xl:size-7" />
                {!isLoadingHistory && pendingPublishCount > 0 && (
                  <span
                    className="absolute -right-3 -top-2 grid min-w-5 place-items-center rounded-full bg-[#111111] px-1.5 py-0.5 text-[10px] font-black leading-none text-white"
                    aria-label={`今日待发布 ${pendingPublishCount} 条`}
                  >
                    {compactCount(pendingPublishCount)}
                  </span>
                )}
              </span>
              <span>待发布</span>
            </button>
            <button
              type="button"
              onClick={() => setPendingPublishOpen((open) => !open)}
              className="grid size-6 place-items-center rounded-full bg-[#E2E5EA] text-[#747B86] transition hover:bg-[#D7DDE5] hover:text-[#4B5563] xl:size-7"
              aria-expanded={pendingPublishOpen}
              aria-label={pendingPublishOpen ? "收起待发布列表" : "展开待发布列表"}
            >
              {pendingPublishOpen ? <ChevronLeft className="size-3.5 xl:size-4" /> : <ChevronRight className="size-3.5 xl:size-4" />}
            </button>
          </div>
        </nav>
        <div className="flex flex-col items-center gap-6 text-[#747B86]">
          <button
            type="button"
            onClick={() => {
              if (isUserLoggedIn) {
                router.replace("/project/agent");
                return;
              }
              setLoginOpen(true);
            }}
            className="rounded-md px-1 py-1 text-[13px] font-extrabold tracking-[0.08em] text-[#6B7280] transition hover:text-[#111111] xl:text-[14px]"
            aria-label={isUserLoggedIn ? "进入我的创作界面" : "登录"}
          >
            {isUserLoggedIn ? "我的" : "登录"}
          </button>
          <Menu className="size-5 xl:size-6" />
        </div>
      </aside>

      {pendingPublishOpen && (
        <aside className="fixed inset-y-0 left-[var(--agent-rail-width)] z-30 hidden w-[276px] border-r border-[#E0E3E8] bg-[#F1F1F3]/95 px-4 py-7 text-[#111111] shadow-[18px_0_42px_rgba(17,24,39,0.06)] backdrop-blur lg:block">
          <button
            type="button"
            onClick={() => setPendingPublishOpen(false)}
            className="absolute -left-6 top-[42%] grid size-12 place-items-center rounded-full bg-[#999999] text-white shadow-sm transition hover:bg-[#848484]"
            aria-label="收起待发布列表"
          >
            <ChevronLeft className="size-7 stroke-[2.4]" />
          </button>

          <div className="flex items-center justify-between text-xs font-semibold text-[#8F949B]">
            <span>今日待发布</span>
            <Link href="/products" className="transition hover:text-[#111111]">
              库存 {approvedInventoryCount}
            </Link>
          </div>

          {hasLowInventory && (
            <Link
              href="/project/agent"
              className="mt-4 block rounded-2xl border border-[#E2E5EA] bg-white/78 px-3 py-3 text-[#111111] shadow-sm transition hover:border-[#C7CDD6] hover:bg-white"
            >
              <span className="flex items-center justify-between text-xs font-black">
                <span>库存不足</span>
                <span>{approvedInventoryCount}/{LOW_GENERATION_INVENTORY_THRESHOLD}</span>
              </span>
              <span className="mt-1 block text-[12px] font-semibold leading-5 text-[#6F7885]">
                建议再生成 {inventoryDeficit} 条项目视频补足库存。
              </span>
            </Link>
          )}

          <div className="mt-4 rounded-2xl bg-white/70 px-3 py-3 shadow-sm">
            <div className="mb-2 flex items-center justify-between text-xs font-bold text-[#747B86]">
              <span>发布数</span>
              <span>{dailyPickCount} 条</span>
            </div>
            <div className="grid grid-cols-5 gap-1">
              {[1, 2, 3, 4, 5].map((count) => (
                <button
                  key={count}
                  type="button"
                  onClick={() => setDailyPickCount(count)}
                  className={`h-7 rounded-lg text-xs font-black transition ${
                    dailyPickCount === count
                      ? "bg-[#111111] text-white"
                      : "bg-[#EEF0F3] text-[#737B86] hover:bg-[#E0E4E9]"
                  }`}
                >
                  {count}
                </button>
              ))}
            </div>
          </div>

          <div className="mt-3 rounded-2xl bg-white/70 px-3 py-3 shadow-sm">
            <div className="mb-2 flex items-center justify-between text-xs font-bold text-[#747B86]">
              <span>推荐方式</span>
              <span>{isPickingPublishItems ? "择优中" : publishPickSource === "llm" ? "LLM" : "兜底"}</span>
            </div>
            <div className="grid grid-cols-3 gap-1">
              {publishPickStrategyOptions.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => setPublishPickStrategy(option.value)}
                  className={`h-7 rounded-lg text-[11px] font-black transition ${
                    publishPickStrategy === option.value
                      ? "bg-[#111111] text-white"
                      : "bg-[#EEF0F3] text-[#737B86] hover:bg-[#E0E4E9]"
                  }`}
                >
                  {option.shortLabel}
                </button>
              ))}
            </div>
          </div>

          <div className="mt-7 space-y-3">
            {isLoadingHistory ? (
              <>
                <div className="h-12 animate-pulse rounded-2xl bg-[#E7E8EA]" />
                <div className="h-16 animate-pulse rounded-2xl bg-[#E7E8EA]" />
              </>
            ) : pendingPublishItems.length > 0 ? (
              pendingPublishItems.map((candidate, index) => {
                const project = candidate.project;
                const cover = projectCover(project);
                return (
                  <Link
                    key={project.id}
                    href={publishHref(project)}
                    className={`flex items-center gap-3 transition hover:translate-x-0.5 ${
                      index === 0 ? "py-1" : "rounded-2xl bg-[#E7E7E9] px-3 py-2.5"
                    }`}
                  >
                    <span className="grid size-12 shrink-0 place-items-center overflow-hidden rounded-xl bg-white text-[#8B929B]">
                      {cover ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={cover} alt="" className="h-full w-full object-cover" />
                      ) : (
                        <FileVideo2 className="size-5" />
                      )}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold text-[#111111]">{projectTitle(project)}</span>
                      <span className="mt-0.5 block truncate text-xs font-medium text-[#8D929A]">
                        {projectStatusText(project.status)} · {candidate.reason}
                      </span>
                    </span>
                    <MoreHorizontal className="size-4 shrink-0 text-[#A0A4AA]" />
                  </Link>
                );
              })
            ) : (
              <div className="rounded-2xl bg-[#E7E7E9] px-4 py-4 text-sm font-semibold text-[#7B828C]">
                {approvedInventoryCount > 0 ? "暂无待发布内容" : "先认可成片入库"}
              </div>
            )}
          </div>
        </aside>
      )}

      {loginOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 px-4 py-8">
          <div className="relative w-full max-w-[520px] rounded-[24px] bg-white px-7 py-7 text-[#111111] shadow-[0_24px_70px_rgba(0,0,0,0.24)] sm:px-8">
            <button
              type="button"
              onClick={() => setLoginOpen(false)}
              className="absolute right-7 top-7 grid size-7 place-items-center rounded-full text-[#111111] transition hover:bg-[#F0F1F3]"
              aria-label="关闭登录"
            >
              <X className="size-6 stroke-[3]" />
            </button>

            <div className="flex items-center gap-2 text-[16px] font-black text-[#111111]">
              <BrandWheatMark className="h-8 w-7 text-[#111111]" />
              <span>绘卖AI</span>
            </div>
            <h2 className="mt-3 text-[28px] font-black leading-tight tracking-normal text-[#111111]">
              欢迎登录绘卖
            </h2>

            <form className="mt-8 space-y-5" onSubmit={handleLoginSubmit}>
              <label className="block">
                <span className="text-[15px] font-extrabold text-[#111111]">手机号</span>
                <input
                  value={phone}
                  onChange={(event) => setPhone(event.target.value)}
                  type="tel"
                  inputMode="tel"
                  autoFocus
                  placeholder="请输入手机号"
                  className="mt-2.5 h-12 w-full rounded-xl border-0 bg-[#F0F0F1] px-4 text-[16px] font-semibold text-[#111111] outline-none placeholder:text-[#9BA3AD]"
                />
              </label>

              <label className="block">
                <span className="text-[15px] font-extrabold text-[#111111]">验证码</span>
                <div className="mt-2.5 flex h-12 overflow-hidden rounded-xl bg-[#F0F0F1]">
                  <input
                    value={verificationCode}
                    onChange={(event) => setVerificationCode(event.target.value)}
                    inputMode="numeric"
                    placeholder="请输入验证码"
                    className="min-w-0 flex-1 border-0 bg-transparent px-4 text-[16px] font-semibold text-[#111111] outline-none placeholder:text-[#9BA3AD]"
                  />
                  <button
                    type="button"
                    onClick={() => setCodeSent(true)}
                    disabled={phone.trim().length === 0}
                    className="m-1 min-w-[112px] rounded-xl border border-white bg-white/70 px-3 text-[14px] font-extrabold text-[#B2B7BE] transition enabled:text-[#6B7280] enabled:hover:text-[#111111] disabled:cursor-not-allowed"
                  >
                    {codeSent ? "已发送" : "发送验证码"}
                  </button>
                </div>
              </label>

              <button
                type="submit"
                disabled={!canLogin}
                className="h-12 w-full rounded-xl bg-[#D9DDE2] text-[16px] font-extrabold text-white transition enabled:bg-[#111111] enabled:hover:bg-[#2B2B2B] disabled:cursor-not-allowed"
              >
                登录
              </button>

              <label className="flex cursor-pointer items-center gap-3 text-[13px] font-semibold text-[#5F6874]">
                <input
                  type="checkbox"
                  checked={agreed}
                  onChange={(event) => setAgreed(event.target.checked)}
                  className="peer sr-only"
                />
                <span className="grid size-5 shrink-0 place-items-center rounded-md border-2 border-[#728095] text-white peer-checked:border-[#111111] peer-checked:bg-[#111111]">
                  <span className="text-[12px] leading-none">✓</span>
                </span>
                <span>
                  已阅读并同意<span className="font-extrabold text-[#111111]">用户服务协议</span>、
                  <span className="font-extrabold text-[#111111]">隐私政策</span>、
                  <span className="font-extrabold text-[#111111]">AI功能使用须知</span>
                </span>
              </label>
            </form>
          </div>
        </div>
      )}

      <div className={pendingPublishOpen ? "lg:pl-[calc(var(--agent-rail-width)+276px)]" : "lg:pl-[var(--agent-rail-width)]"}>
        <header className="flex h-16 items-center justify-between px-5 lg:hidden">
          <Link href="/project/agent" className="grid h-12 w-10 place-items-center text-[#111827]" aria-label="创作界面">
            <BrandWheatMark className="h-11 w-9" />
          </Link>
          <Link href="/settings" className="rounded-lg border border-[#DDE2E8] bg-white px-3 py-2 text-sm font-semibold text-[#222222]">
            设置
          </Link>
        </header>

        <main className="mx-auto flex min-h-screen w-full max-w-[1180px] flex-col px-5 pb-12 pt-6 sm:px-8 lg:px-10 lg:pt-16">
          <section className="relative mx-auto w-full max-w-[960px]">
            <div className="-mt-1 mb-4 flex justify-end sm:absolute sm:-top-9 sm:right-0 sm:mb-0">
              <button
                type="button"
                onClick={() => setHistoryPanelOpen(true)}
                className={`inline-flex h-11 items-center gap-2 rounded-xl border border-[#DDE2E8] bg-white px-4 text-[14px] font-extrabold text-[#111111] transition hover:border-[#B8C0CB] hover:bg-[#F7F8FA] ${wrappedUnderlayClass}`}
                aria-haspopup="dialog"
              >
                <History className="size-4" />
                历史记录
              </button>
            </div>
            <h1 className="text-center text-[28px] font-extrabold leading-tight text-[#111111] sm:text-[36px]">
              一键绘成，即刻开卖
            </h1>

            <div className={`mt-7 rounded-2xl border border-[#DFE4EA] bg-white p-2.5 sm:p-3 ${wrappedUnderlayClass}`}>
              <div
                className={`space-y-3 ${isDragging ? "rounded-xl ring-2 ring-[#6B7280]/25" : ""}`}
                onDragOver={(event) => {
                  event.preventDefault();
                  setIsDragging(true);
                }}
                onDragLeave={(event) => {
                  event.preventDefault();
                  setIsDragging(false);
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  setIsDragging(false);
                  appendFiles(event.dataTransfer.files);
                }}
              >
                <div className="flex min-h-[104px] gap-3">
                  <button
                    type="button"
                    onClick={() => fileRef.current?.click()}
                    className="relative flex h-[72px] w-[60px] shrink-0 -rotate-3 items-center justify-center overflow-hidden rounded-lg border border-dashed border-[#D7DDE5] bg-[#F5F6F8] text-[#7D8794] shadow-sm transition hover:border-[#9AA3AF] hover:text-[#111111]"
                    aria-label={primaryImage ? "继续添加商品图片" : "上传商品图片"}
                  >
                    {primaryImage ? (
                      <>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={primaryImage.url} alt="已上传商品图片预览" className="h-full w-full object-cover" />
                        <span className="absolute inset-x-1.5 bottom-1.5 rounded-full bg-black/70 px-2 py-0.5 text-[10px] font-bold text-white">
                          添加
                        </span>
                      </>
                    ) : (
                      <span className="flex flex-col items-center gap-1 text-[11px] font-bold leading-none">
                        <ImagePlus className="size-5" />
                        添加
                      </span>
                    )}
                  </button>
                  <input
                    ref={fileRef}
                    type="file"
                    accept="image/*"
                    multiple
                    hidden
                    onChange={(event) => {
                      appendFiles(event.target.files);
                      event.currentTarget.value = "";
                    }}
                  />
                  <div className="flex min-w-0 flex-1 flex-col">
                    <textarea
                      value={idea}
                      onChange={(event) => setIdea(event.target.value)}
                      placeholder="可以补一句：想突出便宜、好用、送礼。没想法也可以空着，AI 会看图先写。"
                      className="min-h-[92px] flex-1 resize-none border-0 bg-transparent text-[15px] leading-6 text-[#222222] outline-none placeholder:text-[#A4ACB8]"
                    />
                  </div>
                </div>

                {images.length > 0 && primaryImage && (
                  <div className="rounded-xl border border-[#E6EAF0] bg-[#F6F7F9] p-3">
                    <div className="flex gap-3 sm:items-center">
                      <div className="relative h-20 w-20 shrink-0 overflow-hidden rounded-xl border border-white bg-white shadow-sm">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={primaryImage.url} alt="已上传商品图片预览" className="h-full w-full object-cover" />
                        <span className="absolute left-1.5 top-1.5 rounded-full bg-black/65 px-2 py-0.5 text-[10px] font-bold text-white">
                          主图
                        </span>
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="text-[15px] font-extrabold text-[#111111]">商品图已收到</p>
                          <span className="rounded-full bg-white px-2.5 py-1 text-[12px] font-bold text-[#596474]">
                            {images.length} 张
                          </span>
                        </div>
                        <p className="mt-1 text-[13px] font-semibold leading-5 text-[#68717E]">
                          下一步点“开始生成视频”，AI 会先帮你写脚本。
                        </p>
                        {shouldShowUploadHint && <p className="mt-1 text-[12px] font-semibold text-[#8A94A0]">{uploadHint}</p>}

                        {extraImages.length > 0 && (
                          <div className="mt-3 flex items-center gap-2">
                            {extraImages.map((image, index) => (
                              <button
                                key={image.id}
                                type="button"
                                onClick={() => removeImage(image.id)}
                                className="group relative h-10 w-10 overflow-hidden rounded-lg border border-white bg-white shadow-sm"
                                aria-label={`删除第 ${index + 2} 张商品图`}
                              >
                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                <img src={image.url} alt={`已上传商品图 ${index + 2}`} className="h-full w-full object-cover" />
                                <span className="absolute inset-0 grid place-items-center bg-black/45 text-[10px] font-bold text-white opacity-0 transition group-hover:opacity-100">
                                  删除
                                </span>
                              </button>
                            ))}
                            {hiddenExtraImageCount > 0 && (
                              <span className="grid h-10 min-w-10 place-items-center rounded-lg bg-white px-2 text-xs font-bold text-[#68717E]">
                                +{hiddenExtraImageCount}
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => fileRef.current?.click()}
                        disabled={images.length >= MAX_PRODUCT_IMAGES}
                        className="h-8 rounded-lg bg-white px-3 text-[13px] font-extrabold text-[#2F3742] transition hover:bg-[#ECEFF3] disabled:cursor-not-allowed disabled:opacity-45"
                      >
                        {images.length >= MAX_PRODUCT_IMAGES ? "图片已够用" : "继续加图"}
                      </button>
                      <button
                        type="button"
                        onClick={clearImages}
                        className="h-8 rounded-lg px-3 text-[13px] font-bold text-[#7A8491] transition hover:bg-white hover:text-[#2F3742]"
                      >
                        清空重传
                      </button>
                    </div>
                  </div>
                )}

                <div className="flex flex-col gap-3 border-t border-[#EEF1F4] pt-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="rounded-full bg-[#F0F2F5] px-2.5 py-1 text-[12px] font-extrabold text-[#2F3742]">
                        默认生成：{generationSummary}
                      </span>
                      <button
                        type="button"
                        onClick={() => setSettingsOpen((open) => !open)}
                        className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[13px] font-bold text-[#6C7582] transition hover:bg-[#F0F2F5] hover:text-[#111111]"
                        aria-expanded={settingsOpen}
                      >
                        <SlidersHorizontal className="size-3.5" />
                        更多设置
                        <ChevronDown className={`size-3.5 transition ${settingsOpen ? "rotate-180" : ""}`} />
                      </button>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={handleSubmit}
                    disabled={!canSubmit || isSubmitting}
                    className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-[#E2E5EA] px-5 text-[15px] font-extrabold text-white transition enabled:bg-[#111111] enabled:hover:bg-[#2A2A2A] disabled:cursor-not-allowed sm:w-auto"
                    aria-label="开始生成视频"
                  >
                    {isSubmitting ? (
                      <>
                        <Loader2 className="size-4 animate-spin" />
                        正在生成
                      </>
                    ) : (
                      <>
                        {canSubmit ? "开始生成视频" : "先上传商品图"}
                        <ArrowUp className="size-4" />
                      </>
                    )}
                  </button>
                </div>

                {settingsOpen && (
                  <div className="rounded-xl border border-[#E8ECF1] bg-[#FAFBFC] p-3">
                    <div className="grid gap-3 sm:grid-cols-3">
                      <div>
                        <div className="flex items-center gap-1.5 text-[12px] font-extrabold text-[#6F7885]">
                          <MonitorSmartphone className="size-3.5" />
                          画面
                        </div>
                        <div className="mt-2 grid grid-cols-3 gap-1.5 sm:grid-cols-1">
                          {aspectRatioOptions.map((option) => {
                            const selected = generationSettings.aspectRatio === option.value;
                            return (
                              <button
                                key={option.value}
                                type="button"
                                onClick={() => updateGenerationSettings({ aspectRatio: option.value })}
                                className={`min-h-12 rounded-lg border px-2 text-center text-[12px] font-extrabold transition ${
                                  selected
                                    ? "border-[#111111] bg-[#E8E8E8] text-[#111111]"
                                    : "border-[#E5E9EF] bg-white text-[#6E7784] hover:border-[#B8C0CB]"
                                }`}
                              >
                                <span className="block">{option.label}</span>
                                <span className="block text-[11px] font-bold text-[#8A94A0]">{option.value}</span>
                              </button>
                            );
                          })}
                        </div>
                      </div>

                      <div>
                        <div className="flex items-center gap-1.5 text-[12px] font-extrabold text-[#6F7885]">
                          <Clock className="size-3.5" />
                          时长
                        </div>
                        <div className="mt-2 grid grid-cols-3 gap-1.5 sm:grid-cols-1">
                          {targetDurationOptions.map((option) => {
                            const selected = generationSettings.targetDuration === option.value;
                            return (
                              <button
                                key={option.value}
                                type="button"
                                onClick={() => updateGenerationSettings({ targetDuration: option.value })}
                                className={`min-h-12 rounded-lg border px-2 text-[13px] font-extrabold transition ${
                                  selected
                                    ? "border-[#111111] bg-[#E8E8E8] text-[#111111]"
                                    : "border-[#E5E9EF] bg-white text-[#6E7784] hover:border-[#B8C0CB]"
                                }`}
                              >
                                {option.label}
                              </button>
                            );
                          })}
                        </div>
                      </div>

                      <div>
                        <div className="text-[12px] font-extrabold text-[#6F7885]">清晰度</div>
                        <div className="mt-2 grid grid-cols-2 gap-1.5 sm:grid-cols-1">
                          {qualityOptions.map((option) => {
                            const selected = generationSettings.resolution === option.resolution;
                            return (
                              <button
                                key={option.value}
                                type="button"
                                onClick={() => selectQuality(option)}
                                className={`min-h-12 rounded-lg border px-2 text-center text-[12px] font-extrabold transition ${
                                  selected
                                    ? "border-[#111111] bg-[#E8E8E8] text-[#111111]"
                                    : "border-[#E5E9EF] bg-white text-[#6E7784] hover:border-[#B8C0CB]"
                                }`}
                              >
                                <span className="inline-flex items-center gap-1">
                                  {selected && <Check className="size-3.5" />}
                                  {option.label}
                                </span>
                                <span className="block text-[11px] font-bold text-[#8A94A0]">{option.resolution}</span>
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </div>
              {progress && (
                <div className="mt-2">
                  <div className="h-2 overflow-hidden rounded-full bg-[#ECEFF3]">
                    <div className="h-full rounded-full bg-[#111111] transition-all" style={{ width: `${progress.percent}%` }} />
                  </div>
                  <p className="mt-2 text-xs font-semibold text-[#68717E]">{progress.message}</p>
                </div>
              )}
              {error && (
                <div className="mt-2 flex items-start gap-2 rounded-lg border border-[#D7DDE5] bg-[#F5F6F8] px-3 py-2 text-sm font-medium text-[#2C333D]">
                  <AlertCircle className="mt-0.5 size-4 shrink-0" />
                  <span>{error}</span>
                </div>
              )}
            </div>

            <div className="mt-12 flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
              <div className="flex items-center gap-4 text-[14px] font-bold text-[#68717E] sm:gap-7">
                <span className={`inline-flex h-11 items-center rounded-lg border border-[#DDE2E8] bg-white px-6 text-[#111111] ${wrappedUnderlayClass}`}>
                  案例展示
                </span>
              </div>
              <div className={`flex h-11 w-full items-center gap-3 rounded-lg border border-[#DDE2E8] bg-white px-4 text-[#8A94A0] lg:w-[340px] ${wrappedUnderlayClass}`}>
                <Search className="size-5" />
                <span className="text-sm font-medium">搜索商品、模板或案例</span>
              </div>
            </div>

            <div className="mt-8 space-y-4">
              {showcaseRows.map((row, rowIndex) => (
                <div key={`showcase-row-${rowIndex}`} className="relative pb-4">
                  <div className="pointer-events-none absolute inset-x-0 bottom-0 h-4 rounded-b-lg bg-[#D5D8DD]" />
                  <div className="relative grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                    {row.map((item) => (
                      <div key={item.videoSrc} className="group min-w-0 overflow-hidden rounded-lg border border-[#DDE2E8] bg-white">
                        <div className="relative aspect-[9/16] bg-[#E8EAED]">
                          <video
                            className="h-full w-full object-cover"
                            src={item.videoSrc}
                            aria-label="案例展示视频"
                            autoPlay
                            muted
                            loop
                            playsInline
                            preload="metadata"
                          />
                          <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(180deg,rgba(0,0,0,0.18),rgba(0,0,0,0)_26%,rgba(0,0,0,0.18))]" />
                          <div className="absolute right-4 top-4 grid size-9 place-items-center rounded-full bg-white/64 text-[#303741] backdrop-blur-sm">
                            <Play className="ml-0.5 size-4 fill-[#303741] text-[#303741]" />
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </section>
        </main>
      </div>
      {hasLowInventory && (
        <div className="fixed bottom-4 left-4 z-40 flex h-11 max-w-[calc(100vw-32px)] items-center gap-2 rounded-xl border border-[#DDE2E8] bg-white/92 px-3 text-[#111111] shadow-[0_12px_34px_rgba(17,24,39,0.14)] backdrop-blur sm:bottom-6 sm:left-[calc(var(--agent-rail-width)+24px)]">
          <PackageSearch className="size-4 shrink-0" />
          <span className="whitespace-nowrap text-[13px] font-black">
            库存 {approvedInventoryCount}/{LOW_GENERATION_INVENTORY_THRESHOLD}
          </span>
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            className="ml-1 inline-flex h-7 shrink-0 items-center justify-center rounded-lg bg-[#111111] px-2.5 text-[12px] font-black text-white transition hover:bg-[#2B2B2B]"
          >
            补充
          </button>
        </div>
      )}
      {publishReminderVisible && publishReminderCandidate && (
        <div
          className="fixed bottom-4 right-4 z-40 w-[calc(100vw-32px)] max-w-[360px] rounded-2xl border border-[#DDE2E8] bg-white p-4 text-[#111111] shadow-[0_18px_54px_rgba(17,24,39,0.18)] sm:bottom-6 sm:right-6"
          role="status"
          aria-live="polite"
        >
          <div className="flex items-start gap-3">
            <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-[#F0F2F5] text-[#111111]">
              <BellRing className="size-5" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-start justify-between gap-3">
                <p className="text-sm font-black">今日待发布 {compactCount(pendingPublishCount)} 条</p>
                <button
                  type="button"
                  onClick={() => setPublishReminderVisible(false)}
                  className="grid size-6 shrink-0 place-items-center rounded-full text-[#7A8491] transition hover:bg-[#F0F2F5] hover:text-[#111111]"
                  aria-label="关闭待发布提醒"
                >
                  <X className="size-3.5" />
                </button>
              </div>
              <p className="mt-1 line-clamp-2 text-[13px] font-semibold leading-5 text-[#6F7885]">
                建议及时发布「{projectTitle(publishReminderCandidate.project)}」，保持当天发布节奏。
              </p>
              <div className="mt-3 flex gap-2">
                <Link
                  href={publishHref(publishReminderCandidate.project)}
                  className="inline-flex h-9 flex-1 items-center justify-center rounded-xl bg-[#111111] px-3 text-[13px] font-black text-white transition hover:bg-[#2B2B2B]"
                >
                  去发布
                </Link>
                <button
                  type="button"
                  onClick={() => {
                    setPendingPublishOpen(true);
                    setPublishReminderVisible(false);
                  }}
                  className="inline-flex h-9 items-center justify-center rounded-xl border border-[#DDE2E8] bg-white px-3 text-[13px] font-black text-[#2F3742] transition hover:bg-[#F4F6F8]"
                >
                  查看全部
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
      {historyPanelOpen && (
        <div className="fixed inset-0 z-50 flex justify-end bg-[#111111]/25 p-3 backdrop-blur-[2px] sm:p-5" role="dialog" aria-modal="true" aria-labelledby="history-panel-title">
          <button type="button" className="absolute inset-0 cursor-default" aria-label="关闭历史记录" onClick={() => setHistoryPanelOpen(false)} />
          <section className="relative flex h-full w-full max-w-[560px] flex-col overflow-hidden rounded-2xl border border-[#DDE2E8] bg-white shadow-[0_24px_80px_rgba(17,24,39,0.24)]">
            <div className="flex items-start justify-between gap-4 border-b border-[#EEF1F4] px-5 py-4">
              <div>
                <h2 id="history-panel-title" className="text-[20px] font-black text-[#111111]">
                  历史记录
                </h2>
                <p className="mt-1 text-[13px] font-semibold text-[#7A8491]">
                  {filteredHistoryItems.length}/{historyItems.length} 条，成片后可入库或去发布
                </p>
              </div>
              <button
                type="button"
                onClick={() => setHistoryPanelOpen(false)}
                className="grid size-10 shrink-0 place-items-center rounded-xl bg-[#F3F5F7] text-[#667080] transition hover:bg-[#E8ECF1] hover:text-[#111111]"
                aria-label="关闭历史记录"
              >
                <X className="size-4" />
              </button>
            </div>

            <div className="border-b border-[#EEF1F4] px-5 py-4">
              <label className="flex h-11 items-center gap-3 rounded-xl border border-[#DDE2E8] bg-[#F8F9FB] px-4 text-[#8A94A0]">
                <Search className="size-5" />
                <input
                  value={historyQuery}
                  onChange={(event) => setHistoryQuery(event.target.value)}
                  placeholder="搜索商品、状态或描述"
                  className="min-w-0 flex-1 bg-transparent text-sm font-semibold text-[#222222] outline-none placeholder:text-[#8A94A0]"
                  autoFocus
                />
              </label>
            </div>

            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
              {isLoadingHistory ? (
                <>
                  <div className="h-24 animate-pulse rounded-2xl bg-[#EEF1F4]" />
                  <div className="h-24 animate-pulse rounded-2xl bg-[#EEF1F4]" />
                  <div className="h-24 animate-pulse rounded-2xl bg-[#EEF1F4]" />
                </>
              ) : filteredHistoryItems.length > 0 ? (
                filteredHistoryItems.map((project) => {
                  const cover = projectCover(project);
                  const approved = isProjectApproved(project, approvedVideos);
                  const complete = isProjectComplete(project);
                  return (
                    <div
                      key={project.id}
                      className="grid gap-3 rounded-2xl border border-[#E4E8EE] bg-[#F8F9FB] p-3 transition hover:border-[#D2D8E1] hover:bg-white sm:grid-cols-[72px_1fr] sm:items-start"
                    >
                      <Link
                        href={projectStageHref(project)}
                        className="grid aspect-video w-full place-items-center overflow-hidden rounded-xl bg-white text-[#9098A3] sm:size-[72px] sm:aspect-square"
                        aria-label={`打开 ${projectTitle(project)}`}
                      >
                        {cover ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={cover} alt="" className="h-full w-full object-cover" />
                        ) : (
                          <FileVideo2 className="size-6" />
                        )}
                      </Link>

                      <div className="min-w-0">
                        <div className="mb-1.5 flex flex-wrap items-center gap-2">
                          <span className={`rounded-full px-2.5 py-1 text-[11px] font-black ${projectStatusClass(project.status)}`}>
                            {projectStatusText(project.status)}
                          </span>
                          {approved && (
                            <span className="rounded-full bg-[#111111] px-2.5 py-1 text-[11px] font-black text-white">
                              已入库
                            </span>
                          )}
                          {formatProjectDate(project) && (
                            <span className="text-[11px] font-bold text-[#8A94A0]">{formatProjectDate(project)}</span>
                          )}
                        </div>
                        <h3 className="truncate text-[15px] font-black text-[#111111]">{projectTitle(project)}</h3>
                        <p className="mt-1 line-clamp-2 text-[12px] font-semibold leading-5 text-[#7A8491]">
                          {project.productDescription?.trim() || project.name}
                        </p>
                        <div className="mt-3 flex flex-wrap gap-2">
                          {complete && (
                            <button
                              type="button"
                              onClick={() => (approved ? unapproveProject(project.id) : approveProject(project.id))}
                              className={`h-9 rounded-xl px-3 text-[13px] font-black transition ${
                                approved
                                  ? "bg-[#E8EAEE] text-[#596170] hover:bg-[#DDE2E8]"
                                  : "bg-[#111111] text-white hover:bg-[#2B2B2B]"
                              }`}
                            >
                              {approved ? "移出库存" : "认可入库"}
                            </button>
                          )}
                          <Link
                            href={projectStageHref(project)}
                            className="inline-flex h-9 items-center rounded-xl border border-[#D7DDE5] bg-white px-3 text-[13px] font-black text-[#2F3742] transition hover:border-[#B7C0CC] hover:bg-[#F3F5F7]"
                          >
                            {complete ? "去发布" : "继续"}
                          </Link>
                        </div>
                      </div>
                    </div>
                  );
                })
              ) : (
                <div className="flex min-h-40 flex-col items-center justify-center rounded-2xl bg-[#F5F6F8] px-5 py-8 text-center">
                  <FileVideo2 className="mb-3 size-7 text-[#9AA3AE]" />
                  <p className="text-sm font-black text-[#596170]">暂无生成记录</p>
                  <p className="mt-1 text-xs font-semibold text-[#8A94A0]">开始生成后，所有记录都会留在这里。</p>
                </div>
              )}
            </div>
          </section>
        </div>
      )}
      </div>
    </div>
  );
}
