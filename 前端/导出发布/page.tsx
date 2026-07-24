"use client";

import { useCallback, useState, useEffect } from "react";
import { useParams, useSearchParams } from "next/navigation";
import {
  LuCheck,
  LuCircleCheck,
  LuFilm,
  LuDownload,
  LuLink2,
  LuFileText,
  LuPlus,
  LuHouse,
  LuSmartphone,
  LuShuffle,
  LuLoaderCircle,
  LuSparkles,
  LuImage,
  LuImages,
  LuQrCode,
  LuScanLine,
  LuLanguages,
  LuMapPin,
} from "react-icons/lu";
import Link from "next/link";
import { Card, CardContent } from "@frontend/components/ui/card";
import { Button } from "@frontend/components/ui/button";
import { Badge } from "@frontend/components/ui/badge";
import { useT, useLocale } from "@frontend/i18n";
import { LanguageToggle } from "@frontend/components/language-toggle";
import { PerformanceFeedback } from "@frontend/components/performance-feedback";
import { PrePublishDiagnosis } from "@frontend/components/prepublish-diagnosis";
import { VideoRetro } from "@frontend/components/video-retro";
import { BrandWheatMark } from "@frontend/components/brand-wheat-logo";
import { useVideoApprovalStore } from "@frontend/stores/video-approval-store";
import { STYLE_LABEL_KEYS } from "@backend/shared/shot-constants";
import { StepProgressIndicator } from "@frontend/components/step-progress";
import { pollComposition } from "@backend/shared/poll-composition";
import { acquireComposeOperation, clearComposeOperation } from "@frontend/lib/compose-operation";
import { buildShopLink } from "@backend/core/publish/shop-link";
import { buildPublishPack } from "@backend/core/publish/publish-pack";
import { buildLocalTagPack, type LocalStoreInfo, type LocalTagPack } from "@backend/core/publish/local-tags";
import { requiredAttributionText } from "@backend/core/publish/media-credits";
import type { MediaCredit } from "@backend/core/publish/media-credit-types";

// 平台导出配置：卡片按钮触发 /api/project/[id]/export-platform 真实重编码出对应比例成片。name 用 i18n key（nameKey）在渲染时取译文
const platformConfigs = [
  { id: "douyin", nameKey: "platformDouyin", ratio: "9:16", resolution: "1080p", subtitle: "居中+描边", color: "from-zinc-950 to-zinc-700" },
  { id: "kuaishou", nameKey: "platformKuaishou", ratio: "9:16", resolution: "1080p", subtitle: "贴边框", color: "from-zinc-950 to-zinc-700" },
  { id: "xiaohongshu", nameKey: "platformXiaohongshu", ratio: "3:4", resolution: "1440p", subtitle: "手写字体", color: "from-zinc-950 to-zinc-700" },
  { id: "tiktok", nameKey: "platformTiktok", ratio: "9:16", resolution: "1080p", subtitle: "居中+描边", color: "from-zinc-950 to-zinc-700" },
];

// A/B 变体预设：用现有参数（字幕风格 + 配乐情绪）各重渲一条，便于投放对比哪个转化高（全程免 Key）
const AB_PRESETS: { key: string; labelKey: string; compose: Record<string, unknown> }[] = [
  { key: "karaoke", labelKey: "abVariantKaraoke", compose: { karaoke: true, bgmMood: "upbeat" } },
  { key: "rapid", labelKey: "abVariantRapid", compose: { bgmMood: "energetic" } },
];

interface Composition {
  url: string | null;
  fileName: string;
  resolution: string | null;
  aspectRatio: string | null;
  status: string;
  createdAt: string | null;
  aigcDisclosure?: boolean;
  credits?: MediaCredit[] | null;
}

interface ScriptInfo {
  styleType: string;
  totalDuration: number;
  shotCount: number;
}

interface ProductMeta {
  productName: string;
  category: string;
  description: string;
  shopUrl?: string;
  affiliateCode?: string;
}

interface PublishState {
  loading: boolean;
  titles: string[];
  hashtags: string[];
  caption: string;
  error?: string;
  template?: boolean;
  /** 同城发布信息（本地门店商家）：POI 清单 + 锚点说明 + 标签用法提示 */
  local?: LocalTagPack;
}

type MoreOutputKey = "cover" | "gif" | "carousel" | "qr" | "endCard" | "dub";

interface MoreOutputState {
  loading?: boolean;
  error?: string;
  cover?: string;
  gif?: string;
  cards?: string[];
  qr?: string;
  video?: string;
  shopLink?: string;
  note?: string;
}

export default function ExportPage() {
  const t = useT("exportPage");
  const tc = useT("common");
  const locale = useLocale();
  const { id } = useParams<{ id: string }>();
  const searchParams = useSearchParams();
  const publishReadyMode = searchParams.get("publishReady") === "1";
  const approvedVideos = useVideoApprovalStore((state) => state.approved);
  const publishedVideos = useVideoApprovalStore((state) => state.published);
  const approveProject = useVideoApprovalStore((state) => state.approveProject);
  const unapproveProject = useVideoApprovalStore((state) => state.unapproveProject);
  const markPublishedProject = useVideoApprovalStore((state) => state.markPublishedProject);
  const unmarkPublishedProject = useVideoApprovalStore((state) => state.unmarkPublishedProject);
  const authRequired = useVideoApprovalStore((state) => state.authRequired);
  const lastSyncError = useVideoApprovalStore((state) => state.lastSyncError);
  const clearSyncError = useVideoApprovalStore((state) => state.clearSyncError);
  const hydrateApprovalStore = useVideoApprovalStore((state) => state.hydrateFromServer);

  // 认可入库/发布状态在服务端，进页面先水合，否则"已入库/已发布"标记会显示成初始空状态
  useEffect(() => {
    void hydrateApprovalStore();
  }, [hydrateApprovalStore]);

  // 本地门店画像：storeType=local/both 时，发布文案走同城形态（标签梯度 + POI 清单）；免 Key 兜底包也要用
  const [localStoreInfo, setLocalStoreInfo] = useState<LocalStoreInfo | null>(null);
  useEffect(() => {
    let ignore = false;
    fetch("/api/auth/me", { cache: "no-store" })
      .then(async (res) => {
        if (ignore || !res.ok) return;
        const data = await res.json().catch(() => ({}));
        const m = data.merchant ?? {};
        if (m.storeType === "local" || m.storeType === "both") {
          setLocalStoreInfo({
            city: m.region ?? null,
            landmark: m.landmark ?? null,
            shopName: m.shopName ?? null,
            storeAddress: m.storeAddress ?? null,
            customTags: m.customTags ?? null,
          });
        }
      })
      .catch(() => undefined);
    return () => {
      ignore = true;
    };
  }, []);
  const workflowStepHrefs = [`/project/${id}/script`, `/project/${id}/assets`, `/project/${id}/motion`, `/project/${id}/video`, `/project/${id}/export`];
  const [toast, setToast] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [projectName, setProjectName] = useState("");
  const [composition, setComposition] = useState<Composition | null>(null);
  const [scriptInfo, setScriptInfo] = useState<ScriptInfo | null>(null);
  const [fileSize, setFileSize] = useState<string>("");
  // 发布文案
  const [productMeta, setProductMeta] = useState<ProductMeta | null>(null);
  const [publish, setPublish] = useState<PublishState>({ loading: false, titles: [], hashtags: [], caption: "" });
  // A/B 变体生成（重渲不同字幕风格+配乐各一条，供投放对比）
  const [abVariants, setAbVariants] = useState<{ key: string; labelKey: string; status: "running" | "done" | "error"; url?: string }[]>([]);
  const [abRunning, setAbRunning] = useState(false);
  const [coverTitle, setCoverTitle] = useState("");
  const [shopUrlDraft, setShopUrlDraft] = useState("");
  const [dubLang, setDubLang] = useState("en");
  const [moreOutputs, setMoreOutputs] = useState<Partial<Record<MoreOutputKey, MoreOutputState>>>({});

  const projectShopUrl = productMeta?.shopUrl?.trim() ?? "";
  const effectiveShopUrl = shopUrlDraft.trim() || projectShopUrl;
  const publishShopLink = buildShopLink(effectiveShopUrl, {
    platform: "organic",
    affiliateCode: productMeta?.affiliateCode,
    campaign: id,
  });
  const isApprovedInventory = Boolean(approvedVideos[id]);
  const isPublished = Boolean(publishedVideos[id]);
  const mediaCredits = Array.isArray(composition?.credits) ? composition.credits : [];
  const requiredCreditsText = requiredAttributionText(mediaCredits);

  const showToast = (message: string) => {
    setToast(message);
    setTimeout(() => setToast(null), 3000);
  };

  // 同步被服务端拒（如驳回守卫 403）时，把真实错误文案顶掉刚才的乐观"成功"提示，别让用户误以为成功了
  useEffect(() => {
    if (lastSyncError) {
      showToast(lastSyncError);
      clearSyncError();
    }
  }, [lastSyncError, clearSyncError]);

  const toggleApprovedInventory = () => {
    if (isApprovedInventory) {
      unapproveProject(id);
      showToast("已移出生成库存");
      return;
    }
    approveProject(id);
    showToast("已认可并加入生成库存");
  };

  const copyText = async (text: string) => {
    try { await navigator.clipboard.writeText(text); showToast(t("copied")); } catch { showToast(t("copyFailed")); }
  };

  const localPublishPack = useCallback(() =>
    buildPublishPack({
      productName: productMeta?.productName || projectName,
      category: productMeta?.category,
      sellingPoints: productMeta?.description,
      locale: locale === "en" ? "en" : "zh",
      localStore: localStoreInfo ?? undefined,
    }), [locale, localStoreInfo, productMeta?.category, productMeta?.description, productMeta?.productName, projectName]);

  const hasPublishPack = publish.titles.length > 0 || publish.hashtags.length > 0 || Boolean(publish.caption);
  const fallbackPublishPack = publishReadyMode && !hasPublishPack ? localPublishPack() : null;
  const displayPublish: PublishState = fallbackPublishPack
    ? {
        loading: false,
        titles: fallbackPublishPack.titles,
        hashtags: fallbackPublishPack.hashtags,
        caption: fallbackPublishPack.caption,
        template: true,
      }
    : publish;
  const hasDisplayPublishPack = displayPublish.titles.length > 0 || displayPublish.hashtags.length > 0 || Boolean(displayPublish.caption);
  // 同城发布清单：AI 文案响应自带的优先，兜底/模板包由本地纯函数现算（同构模块，前后端一致）
  const displayLocal: LocalTagPack | null = hasDisplayPublishPack && localStoreInfo
    ? displayPublish.local ?? buildLocalTagPack(localStoreInfo, { category: productMeta?.category })
    : null;

  const ensureLocalPublishPack = () => {
    if (hasPublishPack) return publish;
    const pack = localPublishPack();
    const next: PublishState = { loading: false, titles: pack.titles, hashtags: pack.hashtags, caption: pack.caption, template: true };
    setPublish(next);
    return next;
  };

  const copyPublishPack = async () => {
    const readyPack = hasDisplayPublishPack ? displayPublish : ensureLocalPublishPack();
    const lines = [
      readyPack.titles[0],
      readyPack.hashtags.length ? readyPack.hashtags.join(" ") : "",
      readyPack.caption,
      publishShopLink ? `商品链接：${publishShopLink}` : "",
      requiredCreditsText ? `${t("creditsRequiredHeading")}\n${requiredCreditsText}` : "",
    ].filter(Boolean);
    if (lines.length === 0) return;
    await copyText(lines.join("\n"));
  };

  const markAsPublished = () => {
    if (isPublished) return;
    // 不臆造发布平台——老板在哪个 App 发的我们并不知道，platform 留空好过写死一个错的
    // 发布时间只由 publish_records 记录；真实播放/互动数据等老板回填后再进 publish_metrics。
    // 不能在这里塞一条全 0 metrics，否则会被误判为“已回填”并污染发布时段校准。
    markPublishedProject(id);
    showToast("已标记发布，已从待发布移除；点错可再点一次撤销");
  };

  // 顺序重渲每个 A/B 变体（不同字幕风格+配乐），完成一条出一条下载链接；全程免 Key
  const generateAbVariants = async () => {
    if (abRunning) return;
    setAbRunning(true);
    setAbVariants(AB_PRESETS.map((p) => ({ key: p.key, labelKey: p.labelKey, status: "running" as const })));
    for (const p of AB_PRESETS) {
      try {
        const composePayload = {
          resolution: composition?.resolution === "720p" ? "720p" : "1080p",
          aspectRatio: composition?.aspectRatio || "9:16",
          freeTts: { enabled: true },
          freeBgm: true,
          ...p.compose,
        };
        const composeOperation = acquireComposeOperation(id, `export-ab-${p.key}`, composePayload);
        const res = await fetch(`/api/project/${id}/compose`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": composeOperation.idempotencyKey,
          },
          body: JSON.stringify(composePayload),
        });
        if (!res.ok) {
          clearComposeOperation(composeOperation);
          throw new Error("compose failed");
        }
        const { compositionId } = await res.json();
        if (typeof compositionId !== "string" || !compositionId) throw new Error("compose id missing");
        const url = await pollComposition(id, compositionId, {
          onStatus: (status) => {
            if (status === "done" || status === "failed") clearComposeOperation(composeOperation);
          },
        });
        clearComposeOperation(composeOperation);
        setAbVariants((prev) => prev.map((x) => (x.key === p.key ? { ...x, status: "done", url } : x)));
      } catch {
        setAbVariants((prev) => prev.map((x) => (x.key === p.key ? { ...x, status: "error" } : x)));
      }
    }
    setAbRunning(false);
  };

  const patchMoreOutput = (key: MoreOutputKey, patch: MoreOutputState) => {
    setMoreOutputs((prev) => ({ ...prev, [key]: { ...prev[key], ...patch } }));
  };

  const postMoreOutput = async (path: string, body: Record<string, unknown> = {}) => {
    const res = await fetch(`/api/project/${id}/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(typeof data.error === "string" ? data.error : t("moreFailed"));
    return data as Record<string, unknown>;
  };

  const runMoreOutput = async (key: MoreOutputKey, task: () => Promise<MoreOutputState>) => {
    patchMoreOutput(key, { loading: true, error: undefined, note: undefined });
    try {
      const result = await task();
      patchMoreOutput(key, { ...result, loading: false, error: undefined });
    } catch (error) {
      patchMoreOutput(key, { loading: false, error: error instanceof Error ? error.message : t("moreFailed") });
    }
  };

  const requireShopUrl = () => {
    if (!effectiveShopUrl) throw new Error(t("moreNeedShopUrl"));
    return effectiveShopUrl;
  };

  const generateCoverOutput = () =>
    runMoreOutput("cover", async () => {
      const title = coverTitle.trim() || productMeta?.productName || projectName;
      if (!title.trim()) throw new Error(t("moreCoverNeedTitle"));
      const data = await postMoreOutput("cover", { title });
      return { cover: typeof data.cover === "string" ? data.cover : undefined };
    });

  const generateGifOutput = () =>
    runMoreOutput("gif", async () => {
      const data = await postMoreOutput("preview-gif");
      return { gif: typeof data.gif === "string" ? data.gif : undefined };
    });

  const generateCarouselOutput = () =>
    runMoreOutput("carousel", async () => {
      const data = await postMoreOutput("carousel", { theme: "fresh" });
      return { cards: Array.isArray(data.cards) ? data.cards.filter((item): item is string => typeof item === "string") : [] };
    });

  const generateQrOutput = () =>
    runMoreOutput("qr", async () => {
      const data = await postMoreOutput("shop-qr", { url: requireShopUrl() });
      return {
        qr: typeof data.qr === "string" ? data.qr : undefined,
        shopLink: typeof data.shopLink === "string" ? data.shopLink : undefined,
      };
    });

  const generateEndCardOutput = () =>
    runMoreOutput("endCard", async () => {
      const data = await postMoreOutput("end-card", { url: requireShopUrl() });
      return {
        video: typeof data.video === "string" ? data.video : undefined,
        shopLink: typeof data.shopLink === "string" ? data.shopLink : undefined,
      };
    });

  const generateDubScript = () =>
    runMoreOutput("dub", async () => {
      const data = await postMoreOutput("dub", {
        targetLang: dubLang,
      });
      const voice = typeof data.recommendedVoice === "string" ? data.recommendedVoice : "";
      return { note: t("moreDubDone", { lang: dubLang.toUpperCase(), voice }) };
    });

  const generatePublish = async () => {
    setPublish((p) => ({ ...p, loading: true, error: undefined, template: false }));
    try {
      const res = await fetch("/api/llm/publish", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          productName: productMeta?.productName || projectName,
          category: productMeta?.category,
          productDescription: productMeta?.description,
          locale: locale === "en" ? "en" : "zh", // 跟随界面语言：英文用户的 LLM 也出英文文案
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || t("publishFailed"));
      setPublish({ loading: false, titles: data.titles ?? [], hashtags: data.hashtags ?? [], caption: data.caption ?? "", local: data.local ?? undefined });
    } catch (e) {
      const pack = localPublishPack();
      setPublish({ loading: false, titles: pack.titles, hashtags: pack.hashtags, caption: pack.caption, template: true });
      showToast(e instanceof Error ? `AI文案失败，已用模板发布包` : t("publishFailed"));
    }
  };

  useEffect(() => {
    setPublish({ loading: false, titles: [], hashtags: [], caption: "" });
  }, [id]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const [compRes, projRes, scriptsRes] = await Promise.all([
          fetch(`/api/project/${id}/compose`),
          fetch(`/api/project/${id}`),
          fetch(`/api/project/${id}/scripts`),
        ]);
        if (projRes.ok) {
          const proj = await projRes.json();
          if (!cancelled) {
            setProjectName(proj.name ?? proj.productName ?? "");
            setProductMeta({
              productName: proj.productName ?? proj.name ?? "",
              category: proj.productCategory ?? "",
              description: proj.productDescription ?? "",
              shopUrl: proj.shopUrl ?? "",
              affiliateCode: proj.affiliateCode ?? "",
            });
          }
        }
        if (compRes.ok) {
          const data = await compRes.json();
          if (!cancelled && data.composition) setComposition(data.composition);
        }
        if (scriptsRes.ok) {
          const arr = await scriptsRes.json();
          const sel = Array.isArray(arr) ? (arr.find((s: { selected?: boolean }) => s.selected) ?? arr[0]) : null;
          if (!cancelled && sel) {
            setScriptInfo({
              styleType: sel.styleType,
              totalDuration: sel.totalDuration ?? 0,
              shotCount: Array.isArray(sel.shots) ? sel.shots.length : 0,
            });
          }
        }
      } catch {
        // 忽略，走空态
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  useEffect(() => {
    if (!publishReadyMode || loading || !composition?.url || hasPublishPack) return;
    const pack = localPublishPack();
    setPublish({ loading: false, titles: pack.titles, hashtags: pack.hashtags, caption: pack.caption, template: true });
  }, [composition?.url, hasPublishPack, loading, localPublishPack, publishReadyMode]);

  // 拿到真实成片后，HEAD 探测文件大小
  useEffect(() => {
    if (!composition?.url) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(composition.url!, { method: "HEAD" });
        const len = res.headers.get("content-length");
        if (len && !cancelled) {
          const mb = Number(len) / 1024 / 1024;
          setFileSize(mb >= 1 ? `${mb.toFixed(1)} MB` : `${(Number(len) / 1024).toFixed(0)} KB`);
        }
      } catch {
        // 忽略
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [composition?.url]);

  // 多平台导出状态：platformId → { status, url }
  const [platformExports, setPlatformExports] = useState<Record<string, { status: "idle" | "exporting" | "done" | "error"; url?: string }>>({});
  const exportPlatform = async (platformId: string) => {
    setPlatformExports((prev) => ({ ...prev, [platformId]: { status: "exporting" } }));
    try {
      const res = await fetch(`/api/project/${id}/export-platform`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ platform: platformId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || t("exportFailed"));
      setPlatformExports((prev) => ({ ...prev, [platformId]: { status: "done", url: data.url } }));
    } catch (e) {
      setPlatformExports((prev) => ({ ...prev, [platformId]: { status: "error" } }));
      showToast(e instanceof Error ? e.message : t("exportFailed"));
    }
  };

  const handleCopyLink = async () => {
    if (!composition?.url) return;
    const full = `${window.location.origin}${composition.url}`;
    try {
      await navigator.clipboard.writeText(full);
      showToast(t("linkCopied"));
    } catch {
      showToast(t("copyLinkFailed"));
    }
  };

  const dateStr = composition?.createdAt
    ? new Date(composition.createdAt).toLocaleDateString("zh-CN")
    : "";

  const headerBar = (
    <header className="sticky top-0 z-50 border-b border-border/50 bg-background/80 backdrop-blur-xl">
      <div className="mx-auto flex h-14 max-w-7xl items-center justify-between px-6">
        <div className="flex items-center gap-4">
          <Link href="/project/agent" className="flex items-center gap-3">
            <BrandWheatMark className="h-9 w-7 text-foreground" />
          </Link>
          <span className="text-muted-foreground">/</span>
          <span className="text-sm text-muted-foreground truncate max-w-[40vw] sm:max-w-xs">{projectName || t("projectFallback")}</span>
        </div>
        <div className="flex items-center gap-3">
          <LanguageToggle />
          {/* 步骤胶囊在窄屏放不下，移动端隐藏（仅进度展示、非导航） */}
          <div className="hidden sm:flex items-center gap-1">
            <StepProgressIndicator
              steps={[t("stepScript"), t("stepAssets"), t("stepMotion"), t("stepVideo"), t("stepExport")]}
              activeIndex={4}
              hrefs={workflowStepHrefs}
              backLabel={tc("backPrevStep")}
            />
          </div>
        </div>
      </div>
    </header>
  );

  if (loading) {
    return (
      <div className="workflow-light min-h-screen grid-bg">
        {headerBar}
        <div className="flex flex-col items-center justify-center py-32 text-muted-foreground">
          <LuLoaderCircle className="w-8 h-8 animate-spin mb-3" />
          <p className="text-sm">{t("loadingComposition")}</p>
        </div>
      </div>
    );
  }

  // 空态：还没有合成视频（未登录/会话过期时如实提示去登录，而不是误导"去合成"）
  if (!composition || !composition.url) {
    if (authRequired) {
      return (
        <div className="workflow-light min-h-screen grid-bg">
          {headerBar}
          <div className="mx-auto max-w-md flex flex-col items-center justify-center py-28 px-6 text-center">
            <h2 className="text-lg font-semibold mb-2">请先登录</h2>
            <p className="text-sm text-muted-foreground mb-6">登录后才能查看这个项目的成片与发布材料。</p>
            <Link href="/project/agent">
              <Button className="brand-gradient text-white">去创作工作台登录</Button>
            </Link>
          </div>
        </div>
      );
    }
    return (
      <div className="workflow-light min-h-screen grid-bg">
        {headerBar}
        <div className="mx-auto max-w-md flex flex-col items-center justify-center py-28 px-6 text-center">
          <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-muted/40 mb-5">
            <LuFilm className="w-8 h-8 text-muted-foreground" />
          </div>
          <h2 className="text-lg font-semibold mb-2">{t("emptyTitle")}</h2>
          <p className="text-sm text-muted-foreground mb-6">
            {t("emptyDesc", { name: projectName || t("emptyProjectFallback") })}
          </p>
          <div className="flex items-center gap-3">
            <Link href={`/project/${id}/video`}>
              <Button className="brand-gradient text-white">{t("goCompose")}</Button>
            </Link>
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
      {/* Toast 提示 */}
      {toast && (
        <div className="fixed top-20 left-1/2 -translate-x-1/2 z-[100] animate-in fade-in slide-in-from-top-2">
          <div className="flex items-center gap-2 px-4 py-2.5 rounded-lg bg-foreground text-background text-sm shadow-xl">
            <LuCheck className="w-4 h-4" />
            {toast}
          </div>
        </div>
      )}

      {headerBar}

      <main className="mx-auto max-w-3xl px-6 py-10">
        {/* 完成提示 */}
        <div className="text-center mb-8">
          <div className="inline-flex h-16 w-16 items-center justify-center rounded-full bg-muted mb-4">
            <LuCircleCheck className="w-8 h-8 text-foreground" />
          </div>
          <h1 className="text-2xl font-bold tracking-tight mb-1">
            {t("doneTitleRest")}<span className="brand-gradient-text">{t("doneTitleAccent")}</span>
          </h1>
          <p className="text-sm text-muted-foreground">
            {publishReadyMode ? t("publishReadySubtitle") : t("doneSubtitle")}
          </p>
        </div>

        {/* 视频预览（真实成片） */}
        <Card className="glass-card neon-glow mb-6 overflow-hidden">
          <CardContent className="p-0">
            <div className="mx-auto max-w-xs">
              <div className="relative aspect-[9/16] bg-black flex items-center justify-center">
                <video
                  src={composition.url}
                  controls
                  playsInline
                  className="w-full h-full object-contain"
                />
              </div>
            </div>

            {/* 视频信息条 */}
            <div className="flex px-5 py-3 border-t border-border/30 items-center justify-between">
              <div className="flex items-center gap-3 text-xs text-muted-foreground">
                <span>{composition.resolution ?? "1080p"}</span>
                <span className="w-1 h-1 rounded-full bg-muted-foreground/30" />
                <span>{composition.aspectRatio ?? "9:16"}</span>
                {fileSize && (
                  <>
                    <span className="w-1 h-1 rounded-full bg-muted-foreground/30" />
                    <span>{fileSize}</span>
                  </>
                )}
                <span className="w-1 h-1 rounded-full bg-muted-foreground/30" />
                <span>MP4</span>
              </div>
              {dateStr && <span className="text-xs text-muted-foreground">{dateStr}</span>}
            </div>
          </CardContent>
        </Card>

        {/* 操作按钮 */}
        <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-center gap-3 mb-8">
          <Button
            variant={isApprovedInventory ? "outline" : "default"}
            onClick={toggleApprovedInventory}
            className={`h-11 px-6 text-sm font-semibold ${
              isApprovedInventory
                ? "border-[#DDE2E8] bg-white text-[#374151] hover:bg-[#F3F4F6]"
                : "bg-[#111111] text-white hover:bg-[#2B2B2B]"
            }`}
          >
            <LuCircleCheck className="w-[18px] h-[18px] mr-2" />
            {isApprovedInventory ? "已入生成库存" : "认可入库"}
          </Button>
          <a href={`${composition.url}?download=1`} download={composition.fileName}>
            <Button className="brand-gradient text-white h-11 px-8 text-sm font-semibold w-full">
              <LuDownload className="w-[18px] h-[18px] mr-2" />
              {t("downloadVideo")}
            </Button>
          </a>
          <Button
            variant={isPublished ? "outline" : "default"}
            onClick={() => {
              if (isPublished) {
                // 误点可撤销：撤销后重新回到今日待发布候选
                unmarkPublishedProject(id);
                showToast("已撤销发布标记，重新回到待发布");
                return;
              }
              void markAsPublished();
            }}
            className={`h-11 px-6 text-sm font-semibold ${
              isPublished
                ? "border-[#DDE2E8] bg-white text-[#6B7280] hover:bg-[#F3F4F6]"
                : "bg-[#111111] text-white hover:bg-[#2B2B2B]"
            }`}
          >
            <LuCheck className="w-[18px] h-[18px] mr-2" />
            {isPublished ? "已发布（点击撤销）" : "标记已发布"}
          </Button>
          {publishReadyMode ? (
            <Button
              variant="outline"
              onClick={copyPublishPack}
              className="h-11 px-6 text-sm font-semibold"
            >
              <LuFileText className="w-4 h-4 mr-2" />
              {t("publishReadyCopy")}
            </Button>
          ) : (
            <Button
              variant="outline"
              onClick={generatePublish}
              disabled={publish.loading}
              className="h-11 px-6 text-sm"
            >
              <LuFileText className="w-4 h-4 mr-2" />
              {publish.loading ? t("publishGenerating") : publish.titles.length ? t("publishRegenerate") : t("publishGenerateSimple")}
            </Button>
          )}
          <Button
            variant="outline"
            onClick={handleCopyLink}
            className="hidden h-11 px-6 text-sm"
          >
            <LuLink2 className="w-4 h-4 mr-2" />
            {t("copyShareLink")}
          </Button>
        </div>

        <Card className="glass-card mb-6">
          <CardContent className="p-5">
            <h3 className="text-sm font-semibold mb-3">{t("publishStepsTitle")}</h3>
            <div className="grid gap-3 sm:grid-cols-3">
              {[
                t("publishStepDownload"),
                publishReadyMode ? t("publishReadyStepCopy") : t("publishStepCopy"),
                publishReadyMode ? t("publishReadyStepPost") : t("publishStepPost"),
              ].map((step, index) => (
                <div key={step} className="rounded-lg border border-border/50 bg-muted/10 p-3">
                  <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-foreground text-xs font-semibold text-background">
                    {index + 1}
                  </span>
                  <p className="mt-2 text-sm text-foreground">{step}</p>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card className="glass-card mb-6">
          <CardContent className="p-5">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold">{t("creditsTitle")}</h3>
                <p className="mt-1 text-xs text-muted-foreground">{t("creditsDesc")}</p>
              </div>
              {requiredCreditsText ? (
                <Button size="sm" variant="outline" className="shrink-0 text-xs" onClick={() => copyText(requiredCreditsText)}>
                  {t("creditsCopy")}
                </Button>
              ) : null}
            </div>
            <p className="mt-3 rounded-lg bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
              {t("creditsUserOwned")}
            </p>
            {mediaCredits.length > 0 ? (
              <div className="mt-3 space-y-2">
                {mediaCredits.map((credit) => (
                  <div key={`${credit.mediaType}:${credit.sourceUrl}`} className="rounded-lg border border-border/50 p-3 text-xs">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold text-foreground">{credit.author}</span>
                      <span className="text-muted-foreground">{credit.license}</span>
                      {credit.requiresAttribution ? <Badge variant="secondary">{t("creditsRequired")}</Badge> : null}
                    </div>
                    <p className="mt-1 break-words text-muted-foreground">{credit.attributionText}</p>
                    <div className="mt-1 flex gap-3">
                      <a href={credit.sourceUrl} target="_blank" rel="noreferrer" className="text-primary underline underline-offset-2">{t("creditsSource")}</a>
                      {credit.licenseUrl ? <a href={credit.licenseUrl} target="_blank" rel="noreferrer" className="text-primary underline underline-offset-2">{t("creditsLicense")}</a> : null}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="mt-3 text-xs text-muted-foreground">{t("creditsNone")}</p>
            )}
          </CardContent>
        </Card>

        {/* 发布文案（AI 生成标题/话题/种草文案） */}
        <Card className="glass-card mb-6">
          <CardContent className="p-5">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <LuFileText className="w-4 h-4 text-primary" />
                <h3 className="text-sm font-semibold">{t("publishTitle")}</h3>
              </div>
              <div className="flex items-center gap-2">
                {hasDisplayPublishPack && (
                  <Button size="sm" variant="outline" className="text-xs" onClick={copyPublishPack}>
                    复制整套
                  </Button>
                )}
                <Button size="sm" variant="outline" className="text-xs" disabled={publish.loading} onClick={generatePublish}>
                  {displayPublish.loading ? t("publishGenerating") : publishReadyMode ? t("publishAiOptimize") : displayPublish.titles.length ? t("publishRegenerate") : t("publishGenerate")}
                </Button>
              </div>
            </div>
            {displayPublish.error && <p className="text-xs text-destructive mb-2">{displayPublish.error}</p>}
            {displayPublish.loading && (
              <p className="text-xs text-muted-foreground">{t("publishGenerating")}</p>
            )}
            {!hasDisplayPublishPack && !displayPublish.loading && !displayPublish.error && (
              <p className="text-xs text-muted-foreground">{publishReadyMode ? t("publishReadyHint") : t("publishHint")}</p>
            )}
            {hasDisplayPublishPack && (
              <div className="space-y-3">
                {displayPublish.template && (
                  <p className="text-[11px] text-muted-foreground">{publishReadyMode ? t("publishReadyTemplateNote") : t("publishTemplateNote")}</p>
                )}
                {displayPublish.titles.length > 0 && (
                  <div>
                    <p className="text-xs text-muted-foreground mb-1.5">{t("publishTitlesLabel")}</p>
                    <div className="space-y-1.5">
                      {displayPublish.titles.map((t, i) => (
                        <button key={i} onClick={() => copyText(t)} className="w-full text-left text-sm px-3 py-2 rounded-lg border border-border/50 bg-muted/10 hover:border-primary/50 transition-colors">
                          {t}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                {displayPublish.hashtags.length > 0 && (
                  <div>
                    <div className="flex items-center justify-between mb-1.5">
                      <p className="text-xs text-muted-foreground">{t("publishHashtagsLabel")}</p>
                      <button onClick={() => copyText(displayPublish.hashtags.join(" "))} className="text-xs text-primary">{t("publishCopyAll")}</button>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {displayPublish.hashtags.map((h, i) => (
                        <Badge key={i} variant="secondary" className="text-xs">{h}</Badge>
                      ))}
                    </div>
                    {displayLocal && <p className="mt-1.5 text-[11px] text-muted-foreground">{displayLocal.tagHint}</p>}
                  </div>
                )}
                {displayLocal && (
                  <div className="rounded-lg border border-primary/30 bg-primary/5 p-3">
                    <div className="flex items-center gap-1.5">
                      <LuMapPin className="size-3.5 text-primary" />
                      <p className="text-xs font-semibold">同城发布清单</p>
                    </div>
                    <p className="mt-1 text-[11px] text-muted-foreground">{displayLocal.anchorNote}</p>
                    <ul className="mt-2 space-y-1.5">
                      {displayLocal.poiChecklist.map((item, i) => (
                        <li key={i} className="flex items-start gap-2 text-xs text-foreground/90">
                          <span className="mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-primary/15 text-[10px] font-semibold text-primary">
                            {i + 1}
                          </span>
                          <span>{item}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {displayPublish.caption && (
                  <div>
                    <p className="text-xs text-muted-foreground mb-1.5">{t("publishCaptionLabel")}</p>
                    <button onClick={() => copyText(displayPublish.caption)} className="w-full text-left text-sm px-3 py-2 rounded-lg border border-border/50 bg-muted/10 hover:border-primary/50 transition-colors">
                      {displayPublish.caption}
                    </button>
                  </div>
                )}
                {publishShopLink && (
                  <div>
                    <p className="text-xs text-muted-foreground mb-1.5">{t("publishShopLinkLabel")}</p>
                    <button onClick={() => copyText(publishShopLink)} className="w-full text-left text-sm px-3 py-2 rounded-lg border border-border/50 bg-muted/10 hover:border-primary/50 transition-colors">
                      <span className="line-clamp-2 break-all">{publishShopLink}</span>
                    </button>
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        {/* 发布前诊断：多维内容诊断分 + 相对预测（方向判断，不猜播放量），发布前给老板一次修改机会 */}
        <div className="mb-6">
          <PrePublishDiagnosis projectId={id} />
        </div>

        {/* 高级工具折叠区：多平台比例导出 / 效果回流录入 / A/B 变体等。
            此前被 className="hidden" 整体藏掉，导致效果回流永远无入口、"数据优先"推荐永远无数据可依 */}
        <details className="mb-6">
          <summary className="cursor-pointer rounded-lg border border-border/60 bg-muted/20 px-4 py-2 text-sm font-medium text-muted-foreground transition hover:text-foreground">
            {t("advancedTools")}
          </summary>
          <div className="mt-4">
        {/* 多平台导出（真实重编码） */}
        <Card className="glass-card mb-6">
          <CardContent className="p-5">
            <div className="flex items-center gap-2 mb-4">
              <LuSmartphone className="w-4 h-4 text-primary" />
              <h3 className="text-sm font-semibold">{t("multiExportTitle")}</h3>
            </div>
            <p className="text-xs text-muted-foreground mb-4">{t("multiExportDesc")}</p>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {platformConfigs.map(platform => {
                const ex = platformExports[platform.id] ?? { status: "idle" as const };
                const platformName = t(platform.nameKey);
                return (
                  <div key={platform.id} className="p-3 rounded-lg border border-border/50 bg-muted/10">
                    <div className="flex items-center gap-2 mb-2">
                      <div className={`w-6 h-6 rounded bg-gradient-to-br ${platform.color} flex items-center justify-center`}>
                        <span className="text-[10px] text-white font-bold">{platformName[0]}</span>
                      </div>
                      <span className="text-sm font-medium">{platformName}</span>
                    </div>
                    <div className="text-xs text-muted-foreground space-y-0.5">
                      <p>{t("ratioLabel", { ratio: platform.ratio })}</p>
                      <p>{t("resolutionLabel", { resolution: platform.resolution })}</p>
                    </div>
                    {ex.status === "done" && ex.url ? (
                      <a href={`${ex.url}?download=1`} download>
                        <Button variant="outline" size="sm" className="w-full mt-2 text-xs text-foreground">
                          <LuDownload className="w-3 h-3 mr-1" />
                          {t("downloadPlatform", { platform: platformName })}
                        </Button>
                      </a>
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        className="w-full mt-2 text-xs"
                        disabled={ex.status === "exporting"}
                        onClick={() => exportPlatform(platform.id)}
                      >
                        {ex.status === "exporting" ? t("exporting") : ex.status === "error" ? t("retryExport") : t("exportPlatform", { platform: platformName })}
                      </Button>
                    )}
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>

        {/* 效果回流：发布后回填数据 → 学出哪种风格更能卖；带已发布时间做回填提醒 */}
        <div className="mb-6">
          <PerformanceFeedback projectId={id} publishedAt={publishedVideos[id]?.publishedAt ?? null} />
        </div>

        {/* 单条复盘：数据回填后一键复盘，"下条试试"自动写进店铺记忆反哺下次生成 */}
        <div className="mb-6">
          <VideoRetro projectId={id} />
        </div>

        {/* A/B 变体：换字幕风格+配乐各重渲一条，投放对比哪个转化高 */}
        <Card className="glass-card mb-6">
          <CardContent className="p-5">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <LuShuffle className="w-4 h-4 text-primary" />
                <h3 className="text-sm font-semibold">{t("abTitle")}</h3>
              </div>
              <Button size="sm" variant="outline" className="text-xs" disabled={abRunning || !composition?.url} onClick={generateAbVariants}>
                {abRunning ? t("abRunning") : t("abGenerate")}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground mb-3">{t("abDesc")}</p>
            {abVariants.length > 0 && (
              <div className="space-y-2">
                {abVariants.map((v) => (
                  <div key={v.key} className="flex items-center justify-between rounded-md border border-border/40 bg-muted/10 px-3 py-2">
                    <span className="text-xs">{t(v.labelKey)}</span>
                    {v.status === "running" && <LuLoaderCircle className="w-3.5 h-3.5 animate-spin text-muted-foreground" />}
                    {v.status === "done" && v.url && (
                      <a href={`${v.url}?download=1`} download>
                        <Button size="sm" variant="outline" className="text-xs h-7">{t("abDownload")}</Button>
                      </a>
                    )}
                    {v.status === "error" && <span className="text-xs text-destructive">{t("abFailed")}</span>}
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* 更多产出：封面、预览 GIF、图文卡片、商品二维码、片尾卡与译制脚本 */}
        <Card className="glass-card mb-6">
          <CardContent className="p-5">
            <div className="flex items-center gap-2 mb-2">
              <LuSparkles className="w-4 h-4 text-primary" />
              <h3 className="text-sm font-semibold">{t("moreTitle")}</h3>
            </div>
            <p className="text-xs text-muted-foreground mb-4">{t("moreDesc")}</p>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="rounded-lg border border-border/50 bg-muted/10 p-3">
                <div className="flex items-center gap-2 mb-2">
                  <LuImage className="w-4 h-4 text-primary" />
                  <span className="text-sm font-medium">{t("moreCover")}</span>
                </div>
                <input
                  value={coverTitle}
                  onChange={(event) => setCoverTitle(event.target.value)}
                  placeholder={t("moreCoverTitlePlaceholder")}
                  className="mb-2 h-9 w-full rounded-md border border-border/50 bg-background/60 px-3 text-xs outline-none focus:border-primary/60"
                />
                <Button size="sm" variant="outline" className="w-full text-xs" disabled={moreOutputs.cover?.loading} onClick={generateCoverOutput}>
                  {moreOutputs.cover?.loading ? t("moreGenerating") : t("moreGenerate")}
                </Button>
                {moreOutputs.cover?.error && <p className="mt-2 text-xs text-destructive">{moreOutputs.cover.error}</p>}
                {moreOutputs.cover?.cover && (
                  <a href={moreOutputs.cover.cover} download className="mt-3 block overflow-hidden rounded-md border border-border/40 bg-background">
                    <img src={moreOutputs.cover.cover} alt={t("moreCover")} className="h-28 w-full object-cover" />
                  </a>
                )}
              </div>

              <div className="rounded-lg border border-border/50 bg-muted/10 p-3">
                <div className="flex items-center gap-2 mb-2">
                  <LuFilm className="w-4 h-4 text-primary" />
                  <span className="text-sm font-medium">{t("moreGif")}</span>
                </div>
                <Button size="sm" variant="outline" className="w-full text-xs" disabled={moreOutputs.gif?.loading} onClick={generateGifOutput}>
                  {moreOutputs.gif?.loading ? t("moreGenerating") : t("moreGenerate")}
                </Button>
                {moreOutputs.gif?.error && <p className="mt-2 text-xs text-destructive">{moreOutputs.gif.error}</p>}
                {moreOutputs.gif?.gif && (
                  <a href={moreOutputs.gif.gif} download className="mt-3 block overflow-hidden rounded-md border border-border/40 bg-background">
                    <img src={moreOutputs.gif.gif} alt={t("moreGif")} className="h-28 w-full object-cover" />
                  </a>
                )}
              </div>

              <div className="rounded-lg border border-border/50 bg-muted/10 p-3">
                <div className="flex items-center gap-2 mb-2">
                  <LuImages className="w-4 h-4 text-primary" />
                  <span className="text-sm font-medium">{t("moreCarousel")}</span>
                </div>
                <Button size="sm" variant="outline" className="w-full text-xs" disabled={moreOutputs.carousel?.loading} onClick={generateCarouselOutput}>
                  {moreOutputs.carousel?.loading ? t("moreGenerating") : t("moreGenerate")}
                </Button>
                {moreOutputs.carousel?.error && <p className="mt-2 text-xs text-destructive">{moreOutputs.carousel.error}</p>}
                {!!moreOutputs.carousel?.cards?.length && (
                  <div className="mt-3 grid grid-cols-3 gap-2">
                    {moreOutputs.carousel.cards.slice(0, 6).map((card, index) => (
                      <a key={card} href={card} download className="overflow-hidden rounded-md border border-border/40 bg-background">
                        <img src={card} alt={`${t("moreCarousel")} ${index + 1}`} className="aspect-[3/4] w-full object-cover" />
                      </a>
                    ))}
                  </div>
                )}
              </div>

              <div className="rounded-lg border border-border/50 bg-muted/10 p-3">
                <div className="flex items-center gap-2 mb-2">
                  <LuQrCode className="w-4 h-4 text-primary" />
                  <span className="text-sm font-medium">{t("moreQr")}</span>
                </div>
                <input
                  value={shopUrlDraft}
                  onChange={(event) => setShopUrlDraft(event.target.value)}
                  placeholder={projectShopUrl || t("moreShopUrlPlaceholder")}
                  className="mb-2 h-9 w-full rounded-md border border-border/50 bg-background/60 px-3 text-xs outline-none focus:border-primary/60"
                />
                <Button size="sm" variant="outline" className="w-full text-xs" disabled={moreOutputs.qr?.loading} onClick={generateQrOutput}>
                  {moreOutputs.qr?.loading ? t("moreGenerating") : t("moreGenerate")}
                </Button>
                {moreOutputs.qr?.error && <p className="mt-2 text-xs text-destructive">{moreOutputs.qr.error}</p>}
                {moreOutputs.qr?.qr && (
                  <div className="mt-3 flex items-center gap-3">
                    <a href={moreOutputs.qr.qr} download className="overflow-hidden rounded-md border border-border/40 bg-background p-2">
                      <img src={moreOutputs.qr.qr} alt={t("moreQr")} className="h-20 w-20 object-contain" />
                    </a>
                    {moreOutputs.qr.shopLink && (
                      <Button size="sm" variant="outline" className="text-xs" onClick={() => copyText(moreOutputs.qr?.shopLink ?? "")}>
                        {t("copyShareLink")}
                      </Button>
                    )}
                  </div>
                )}
              </div>

              <div className="rounded-lg border border-border/50 bg-muted/10 p-3">
                <div className="flex items-center gap-2 mb-2">
                  <LuScanLine className="w-4 h-4 text-primary" />
                  <span className="text-sm font-medium">{t("moreEndCard")}</span>
                </div>
                <Button size="sm" variant="outline" className="w-full text-xs" disabled={moreOutputs.endCard?.loading} onClick={generateEndCardOutput}>
                  {moreOutputs.endCard?.loading ? t("moreGenerating") : t("moreGenerate")}
                </Button>
                {moreOutputs.endCard?.error && <p className="mt-2 text-xs text-destructive">{moreOutputs.endCard.error}</p>}
                {moreOutputs.endCard?.video && (
                  <a href={`${moreOutputs.endCard.video}?download=1`} download>
                    <Button size="sm" variant="outline" className="mt-3 w-full text-xs">
                      <LuDownload className="w-3 h-3 mr-1" />
                      {t("moreEndCardDownload")}
                    </Button>
                  </a>
                )}
              </div>

              <div className="rounded-lg border border-border/50 bg-muted/10 p-3">
                <div className="flex items-center gap-2 mb-2">
                  <LuLanguages className="w-4 h-4 text-primary" />
                  <span className="text-sm font-medium">{t("moreDub")}</span>
                </div>
                <div className="mb-2 grid grid-cols-[1fr_auto] gap-2">
                  <select
                    value={dubLang}
                    onChange={(event) => setDubLang(event.target.value)}
                    className="h-9 rounded-md border border-border/50 bg-background/60 px-3 text-xs outline-none focus:border-primary/60"
                  >
                    <option value="en">English</option>
                    <option value="ja">日本語</option>
                    <option value="ko">한국어</option>
                    <option value="es">Español</option>
                  </select>
                  <Button size="sm" variant="outline" className="text-xs" disabled={moreOutputs.dub?.loading} onClick={generateDubScript}>
                    {moreOutputs.dub?.loading ? t("moreGenerating") : t("moreGenerate")}
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">{t("moreDubHint")}</p>
                {moreOutputs.dub?.error && <p className="mt-2 text-xs text-destructive">{moreOutputs.dub.error}</p>}
                {moreOutputs.dub?.note && <p className="mt-2 text-xs text-primary">{moreOutputs.dub.note}</p>}
              </div>
            </div>
          </CardContent>
        </Card>

        {/* 视频详情（真实脚本数据） */}
        <Card className="glass-card">
          <CardContent className="p-5">
            <h3 className="text-sm font-semibold mb-4">{t("detailTitle")}</h3>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-3">
                <div>
                  <p className="text-xs text-muted-foreground mb-0.5">{t("detailStyle")}</p>
                  <p className="text-sm">{scriptInfo ? (STYLE_LABEL_KEYS[scriptInfo.styleType] ? t(STYLE_LABEL_KEYS[scriptInfo.styleType]) : scriptInfo.styleType) : t("emptyValue")}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground mb-0.5">{t("detailShots")}</p>
                  <p className="text-sm">{scriptInfo ? t("shotCount", { n: scriptInfo.shotCount }) : t("emptyValue")}</p>
                </div>
              </div>
              <div className="space-y-3">
                <div>
                  <p className="text-xs text-muted-foreground mb-0.5">{t("detailDuration")}</p>
                  <p className="text-sm">{scriptInfo?.totalDuration ? t("durationSeconds", { n: scriptInfo.totalDuration }) : t("emptyValue")}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground mb-0.5">{t("detailResolution")}</p>
                  <p className="text-sm">{composition.resolution ?? "1080p"} · {composition.aspectRatio ?? "9:16"}</p>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
          </div>
        </details>

        {/* 底部导航 */}
        <div className="hidden">
          <Link href="/project/new">
            <Button className="brand-gradient text-white">
              <LuPlus className="w-4 h-4 mr-1.5" />
              {t("makeAnother")}
            </Button>
          </Link>
          <Link href="/project/agent">
            <Button variant="outline">
              <LuHouse className="w-4 h-4 mr-1.5" />
              {t("backToProjects")}
            </Button>
          </Link>
        </div>
      </main>
    </div>
  );
}
