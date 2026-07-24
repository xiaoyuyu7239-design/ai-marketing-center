"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { useParams } from "next/navigation";
import { LuArrowLeft, LuZap, LuCheck, LuCircleX, LuImage, LuArrowRight, LuLoaderCircle, LuTriangleAlert } from "react-icons/lu";
import Link from "next/link";
import { Card, CardContent } from "@frontend/components/ui/card";
import { Button } from "@frontend/components/ui/button";
import { Badge } from "@frontend/components/ui/badge";
import { buildImageOptions } from "@backend/shared/gen-params";
import type { Shot } from "@backend/db/schema";
import { buildAssetRows, shouldOfferStockFill, needsImageModelWarning, type AssetItem } from "@backend/core/stock/assets-view";
import { useT } from "@frontend/i18n";
import { LanguageToggle } from "@frontend/components/language-toggle";
import { BrandWheatMark } from "@frontend/components/brand-wheat-logo";
import { SHOT_TYPE_INFO } from "@backend/shared/shot-constants";
import { StepProgressIndicator } from "@frontend/components/step-progress";
import { createBatchGenerationOperation, newGenerationOperationId } from "@frontend/lib/generation-operation";


export default function AssetsPage() {
  const t = useT("assets");
  const tc = useT("common");
  const tRef = useRef(t);
  tRef.current = t;
  const { id } = useParams<{ id: string }>();
  const workflowStepHrefs = [`/project/${id}/script`, `/project/${id}/assets`, `/project/${id}/motion`, `/project/${id}/video`, `/project/${id}/export`];

  const [assets, setAssets] = useState<AssetItem[]>([]);
  const [productImages, setProductImages] = useState<string[]>([]);
  // 商品保真：AI 生成展示商品的分镜时，用商品原图作参考重绘，避免 AI 篡改商品（带货命门）
  const [productSafe, setProductSafe] = useState(true);
  const [projectName, setProjectName] = useState("");
  // 项目类型：topic（无商品一句话成片）走免费素材库自动配画面
  const [contentType, setContentType] = useState<string>("");
  const [imageAgentReady, setImageAgentReady] = useState(false);
  const [videoAgentReady, setVideoAgentReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isBatchGenerating, setIsBatchGenerating] = useState(false);
  // 批量生成的失败摘要：失败卡片可能在折叠区外，必须在顶部横幅给出肉眼可见的原因（如配额用完）
  const [batchError, setBatchError] = useState<string | null>(null);
  // 「自动配画面（免费素材）」状态
  const [isFillingStock, setIsFillingStock] = useState(false);
  const [stockMsg, setStockMsg] = useState<string | null>(null);

  const doneCount = assets.filter((a) => a.status === "done").length;
  const remainingCount = Math.max(assets.length - doneCount, 0);
  const allDone = assets.length > 0 && doneCount === assets.length;
  // 后台图片 Agent 不可用时，给用户提供免费素材配画面入口；topic 项目始终保留该入口。
  const offerStockFill = !loading && shouldOfferStockFill(assets, contentType, imageAgentReady);
  // 仅当还有 AI 分镜未出图时才提示配模型（已全部就绪则不提示，避免与「已就绪」矛盾）
  const showModelWarning = !loading && needsImageModelWarning(assets, imageAgentReady);

  // 载入真实数据：项目信息 + 已选脚本分镜 + 已生成素材
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
        const savedAssets = assetsRes.ok ? await assetsRes.json() : [];
        if (cancelled) return;

        const imgs: string[] = project && Array.isArray(project.productImages) ? project.productImages : [];
        if (project) {
          setProjectName(project.name ?? project.productName ?? "");
          setProductImages(imgs);
          setContentType(typeof project.contentType === "string" ? project.contentType : "");
        }

        // 取已选中的脚本（无 selected 则取第一套）
        const selected = Array.isArray(scripts)
          ? scripts.find((s: { selected?: boolean }) => s.selected) ?? scripts[0]
          : null;

        if (!selected || !Array.isArray(selected.shots) || selected.shots.length === 0) {
          setAssets([]);
          setLoadError(tRef.current("errorNoScript"));
          return;
        }

        // 选中脚本分镜 + 已落库素材 → 视图行（与「配画面后刷新」共用同一纯函数）
        setAssets(buildAssetRows(selected.shots as Shot[], Array.isArray(savedAssets) ? savedAssets : [], imgs));
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
        if (cancelled) return;
        setImageAgentReady(Boolean(data.imageReady));
        setVideoAgentReady(Boolean(data.videoReady));
      } catch {
        if (!cancelled) {
          setImageAgentReady(false);
          setVideoAgentReady(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // 重新拉取项目/脚本/素材并重建视图行（配画面后刷新缩略图，复用同一纯函数）
  const reloadAssets = useCallback(async () => {
    const [projectRes, scriptsRes, assetsRes] = await Promise.all([
      fetch(`/api/project/${id}`),
      fetch(`/api/project/${id}/scripts`),
      fetch(`/api/project/${id}/assets`),
    ]);
    const project = projectRes.ok ? await projectRes.json() : null;
    const scripts = scriptsRes.ok ? await scriptsRes.json() : [];
    const savedAssets = assetsRes.ok ? await assetsRes.json() : [];
    const imgs: string[] = project && Array.isArray(project.productImages) ? project.productImages : [];
    const selected = Array.isArray(scripts)
      ? scripts.find((s: { selected?: boolean }) => s.selected) ?? scripts[0]
      : null;
    if (selected && Array.isArray(selected.shots)) {
      setAssets(buildAssetRows(selected.shots as Shot[], Array.isArray(savedAssets) ? savedAssets : [], imgs));
    }
  }, [id]);

  // 一键「自动配画面（免费素材）」：从免费素材库（keyless Openverse 图片）按检索词逐镜配画面。
  // 无需任何生图 Key —— 这是「一句话主题成片」零门槛闭环的关键一步。
  const fillStock = useCallback(async () => {
    if (isFillingStock) return;
    setIsFillingStock(true);
    setStockMsg(null);
    try {
      const res = await fetch(`/api/project/${id}/stock-fill`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // 免费源以 Openverse 图片为主（视频源需 Pexels/Pixabay Key，后续在设置接入）
        body: JSON.stringify({ source: "all", mediaType: "image" }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || t("stockFillFailed"));
      await reloadAssets();
      setStockMsg(t("stockFilledMsg", { filled: data.filled ?? 0, total: data.total ?? 0 }));
    } catch (e) {
      setStockMsg(e instanceof Error ? e.message : t("stockFillFailed"));
    } finally {
      setIsFillingStock(false);
    }
  }, [id, isFillingStock, reloadAssets, t]);

  // 真实生成单个素材（只出分镜图；转动态在下一步「动态」页进行）
  const generateOne = useCallback(
    async (shotId: number, batchOperationId?: string) => {
      const asset = assets.find((a) => a.shotId === shotId);
      if (!asset) return;

      // 用户传了多张商品图时，各分镜轮流取不同的图，避免整片只体现第一张——
      // 多角度/多卖点都用上，各段画面也就有了差异（只传 1 张则各段仍用同一张，行为不变）。
      const shotIndex = assets.findIndex((a) => a.shotId === shotId);
      const productImg =
        productImages[(shotIndex >= 0 ? shotIndex : 0) % Math.max(1, productImages.length)] ?? productImages[0];

      // 商品原图分镜：直接用商品图，无需调用 AI（落库供合成读取）
      if (asset.visualSource === "product_image") {
        setAssets((prev) =>
          prev.map((a) =>
            a.shotId === shotId ? { ...a, status: "done", thumbnailUrl: productImg } : a
          )
        );
        if (productImg) {
          fetch(`/api/project/${id}/assets`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ shotId, type: "product_image", sourceUrl: productImg }),
          }).catch(() => {});
        }
        return;
      }

      // AI 生成分镜：需要工作人员后台已发布可用图片 Agent 策略
      if (!imageAgentReady) {
        setAssets((prev) =>
          prev.map((a) =>
            a.shotId === shotId
              ? { ...a, status: "failed", error: t("errorNoImageModel") }
              : a
          )
        );
        return t("errorNoImageModel");
      }

      setAssets((prev) => prev.map((a) => (a.shotId === shotId ? { ...a, status: "generating", error: undefined } : a)));

      // 分镜图生成：所有 AI 分镜都以用户上传图为参考做 image-to-image（保持主体一致），
      // 按脚本镜头描述换角度/动作/构图/场景，生成"每镜不同但同一主体"的分镜图 —— 解决"画面单一"。
      // 只有完全没有可参考图时才退回 text-to-image。
      const useProductSafe = productSafe && !!productImg;
      const genMode = useProductSafe ? "image-to-image" : "text-to-image";
      const basePrompt = asset.prompt || asset.description;
      // 无脸构图硬约束：分镜图带清晰正脸会被视频平台人脸风控拦下、整镜只能留静图。
      // 这条不能指望 LLM 在脚本里自觉遵守（实测会漏），在生成入口统一追加；
      // 放在 prompt 最前（生图模型对开头权重最高）并中英双语强化，压过英文构图描述里的 face 类词。
      const FACELESS_RULE =
        "【最高优先级】画面绝不出现完整清晰的正脸：只用背影、侧影、颈部以下、手部/下半身局部特写，或让头发、动作、构图自然遮挡面部。Strictly no visible face: shoot from behind, side profile, or neck-down crop only. " +
        "画面遵循真实物理：每个物体有可信支撑（被手拿着或放在台面上），绝不悬空漂浮；商品保持真实小物尺寸，不在场景中巨大化。Every object must rest on a surface or be held by a hand — nothing floats; keep the product at its real-world scale. ";
      const genPrompt = useProductSafe
        ? `${FACELESS_RULE}以参考图中的商品/人物为准，严格保持其身份、外观、服装、颜色、logo 完全一致（是同一件商品、同一个人）；在此前提下按这个镜头重新构图：${basePrompt}。可改变角度、姿态、动作、景别与场景背景，但绝不改变商品本身。`
        : `${FACELESS_RULE}${basePrompt}`;

      try {
        const operationId = batchOperationId || newGenerationOperationId("image-single");
        const res = await fetch("/api/ai/image", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            projectId: id,
            mode: genMode,
            prompt: genPrompt,
            ...(useProductSafe && { imageUrl: productImg }),
            // 用户自定义图片参数（比例→尺寸/数量/步数/引导/种子/反向词）
            options: buildImageOptions(undefined),
            operationId,
            operationType: batchOperationId ? "image-batch" : "image-single",
            itemKey: `shot:${shotId}`,
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || t("errorGenerateFailed"));
        const url = data.imageUrls?.[0];
        if (!url) throw new Error(t("errorEmptyResult"));
        // 落库（远程图会被下载到本地）是成功的一部分。不能在下载失败时把
        // 短效外链标成 done，否则刷新后分镜会丢失，动态任务也无法绑定真实文件 hash。
        const saveRes = await fetch(`/api/project/${id}/assets`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            shotId, type: "ai_generate", sourceUrl: url,
            prompt: asset.prompt,
          }),
        });
        const saved = await saveRes.json().catch(() => ({}));
        if (!saveRes.ok || typeof saved.filePath !== "string" || !saved.filePath) {
          throw new Error(typeof saved.error === "string" ? saved.error : t("errorPersistAssetFailed"));
        }
        const savedUrl = saved.filePath;
        setAssets((prev) =>
          prev.map((a) => (a.shotId === shotId ? {
            ...a,
            status: "done",
            thumbnailUrl: savedUrl,
            assetFileUrl: savedUrl,
            assetId: typeof saved.id === "string" ? saved.id : undefined,
            assetType: typeof saved.type === "string" ? saved.type : "ai_generated",
            assetPrompt: typeof saved.prompt === "string" ? saved.prompt : asset.prompt,
          } : a))
        );
      } catch (e) {
        const message = e instanceof Error ? e.message : t("errorGenerateFailed");
        setAssets((prev) =>
          prev.map((a) =>
            a.shotId === shotId ? { ...a, status: "failed", error: message } : a
          )
        );
        return message;
      }
    },
    [assets, imageAgentReady, productImages, productSafe, id, t]
  );

  // 阶段一「一键生成分镜图」：只出图不转动态——先审分镜宫格、把不满意的图重生成好，
  // 再进入阶段二统一转动态。坏图直接转动态只会浪费时间和视频额度（垃圾进垃圾出）。
  const generateAll = useCallback(async () => {
    const pending = assets.filter((a) => a.status === "pending" || a.status === "failed");
    if (pending.length === 0) return;
    setIsBatchGenerating(true);
    setBatchError(null);
    const aiPending = pending.filter((asset) => asset.visualSource !== "product_image");
    const aiShotIds = new Set(aiPending.map((asset) => asset.shotId));
    const operationId = aiPending.length > 0 ? newGenerationOperationId("image-batch") : undefined;
    if (operationId) {
      try {
        await createBatchGenerationOperation({
          projectId: id,
          kind: "image",
          operationId,
          itemKeys: aiPending.map((asset) => `shot:${asset.shotId}`),
        });
      } catch (error) {
        setBatchError(error instanceof Error ? error.message : "创建批量生成任务失败");
        setIsBatchGenerating(false);
        return;
      }
    }
    const failures: Array<{ shotId: number; message: string }> = [];
    // 两条流水线并行；更高并发会撞生图服务限流，得不偿失
    const queue = pending.map((a) => a.shotId);
    const worker = async () => {
      for (let sid = queue.shift(); sid !== undefined; sid = queue.shift()) {
        const err = await generateOne(sid, aiShotIds.has(sid) ? operationId : undefined);
        if (err) failures.push({ shotId: sid, message: err });
      }
    };
    await Promise.all([worker(), worker()]);
    // 失败原因提到顶部横幅并点名镜号：失败卡片可能在折叠区外，只写在卡片上用户不知道是哪几镜
    if (failures.length > 0) {
      const shots = [...new Set(failures.map((f) => f.shotId))].sort((a, b) => a - b).join("、");
      setBatchError(t("batchFailedBanner", { shots, reason: failures[0].message }));
    }
    setIsBatchGenerating(false);
  }, [assets, generateOne, id, t]);


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
            <span className="text-sm text-muted-foreground truncate max-w-[40vw] sm:max-w-xs">{projectName || t("untitledProject")}</span>
          </div>

          {/* 步骤进度 */}
          <div className="flex items-center gap-1">
            <LanguageToggle className="mr-1" />
            {/* 步骤胶囊在窄屏放不下，移动端隐藏（仅进度展示、非导航） */}
            <div className="hidden sm:flex items-center gap-1">
            <StepProgressIndicator
              steps={[t("stepScript"), t("stepAssets"), t("stepMotion"), t("stepVideo"), t("stepExport")]}
              activeIndex={1}
              hrefs={workflowStepHrefs}
              backLabel={tc("backPrevStep")}
            />
            </div>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-6 py-8">
        {/* 操作栏：保留能力，默认不展示给小店主，避免一进来就被设置项打断。 */}
        <div className="hidden">
          <div>
            <h2 className="text-lg font-semibold">{t("title")}</h2>
            <p className="text-sm text-muted-foreground mt-0.5">
              {loading ? tc("loading") : t("assetsReady", { done: doneCount, total: assets.length })}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <details className="relative">
              <summary className="flex h-8 cursor-pointer list-none items-center rounded-md border border-border/60 px-3 text-xs font-medium text-muted-foreground transition hover:text-foreground">
                {t("advancedOptions")}
              </summary>
              <div className="absolute right-0 top-[calc(100%+8px)] z-20 w-52 rounded-lg border border-border bg-background p-2 shadow-lg">
                <div className="space-y-2">
                  <Link href={`/project/${id}/script`}>
                    <Button variant="outline" size="sm" className="w-full text-xs">
                      <LuArrowLeft className="w-3.5 h-3.5 mr-1" />
                      {t("backToScript")}
                    </Button>
                  </Link>
                  {offerStockFill && (
                    <Button
                      onClick={fillStock}
                      disabled={isFillingStock}
                      variant="outline"
                      size="sm"
                      className="w-full text-xs border-primary/50 text-primary hover:bg-primary/10"
                      title={t("stockFillHint")}
                    >
                      {isFillingStock ? (
                        <>
                          <LuLoaderCircle className="animate-spin w-3.5 h-3.5 mr-1" />
                          {t("stockFilling")}
                        </>
                      ) : (
                        <>
                          <LuImage className="w-3.5 h-3.5 mr-1" />
                          {t("stockFill")}
                        </>
                      )}
                    </Button>
                  )}
                  {productImages.length > 0 && (
                    <button
                      type="button"
                      onClick={() => setProductSafe((v) => !v)}
                      title={t("productSafeTip")}
                      className={`flex h-9 w-full items-center justify-between rounded-md border px-3 text-xs font-medium transition-all ${
                        productSafe
                          ? "border-primary bg-primary/10 text-primary"
                          : "border-border/60 bg-muted/20 text-muted-foreground"
                      }`}
                    >
                      <span>{t("productSafe")}</span>
                      <span className={`h-2 w-2 rounded-full ${productSafe ? "bg-primary" : "bg-muted-foreground/40"}`} />
                    </button>
                  )}
                </div>
              </div>
            </details>
            <Button
              onClick={generateAll}
              disabled={isBatchGenerating || allDone || assets.length === 0}
              className="brand-gradient text-white text-xs"
            >
              {isBatchGenerating ? (
                <>
                  <LuLoaderCircle className="animate-spin mr-1.5 h-3.5 w-3.5" />
                  {t("generatingAll")}
                </>
              ) : allDone ? (
                t("allDone")
              ) : (
                <>
                  <LuZap className="w-3.5 h-3.5 mr-1" />
                  {t("generateAll")}
                </>
              )}
            </Button>
            <Link href={allDone ? `/project/${id}/motion` : "#"} className={!allDone ? "pointer-events-none" : undefined}>
              <Button className="brand-gradient text-white text-sm" disabled={!allDone}>
                {t("nextMotion")}
                <LuArrowRight className="w-4 h-4 ml-1" />
              </Button>
            </Link>
          </div>
        </div>

        {/* 未配置生图模型提示（仅当仍有 AI 分镜待出图） */}
        {showModelWarning && (
          <div className="hidden">
            <LuTriangleAlert className="w-5 h-5 text-muted-foreground shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-medium text-foreground">{t("noModelTitle")}</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                {t("noModelDesc")}
              </p>
            </div>
          </div>
        )}

        {/* 加载态 / 空态 */}
        {loading ? (
          <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
            <LuLoaderCircle className="w-6 h-6 animate-spin mb-3" />
            <p className="text-sm">{t("loadingShots")}</p>
          </div>
        ) : loadError ? (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <LuImage className="w-10 h-10 text-muted-foreground/40 mb-3" />
            <p className="text-sm text-muted-foreground mb-4">{loadError}</p>
            <Link href={`/project/${id}/script`}>
              <Button variant="outline" size="sm">{t("backToScriptStep")}</Button>
            </Link>
          </div>
        ) : (
          <>
            {/* 进度条：默认隐藏，店主只需要知道能不能下一步。 */}
            <div className="hidden">
              <div className="h-2 bg-muted/30 rounded-full overflow-hidden">
                <div
                  className="h-full brand-gradient transition-all duration-700 rounded-full"
                  style={{ width: `${assets.length ? (doneCount / assets.length) * 100 : 0}%` }}
                />
              </div>
            </div>

            <Card className="glass-card mb-5 py-0">
              <CardContent className="px-5 py-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <h3 className="text-lg font-semibold">
                      {allDone ? t("assetsHeroReady") : t("assetsHeroWorking", { remaining: remainingCount })}
                    </h3>
                    <p className="mt-0.5 text-sm text-muted-foreground">
                      {allDone
                        ? t("assetsHeroDescDone", { total: assets.length })
                        : showModelWarning && !offerStockFill
                        ? t("assetsHeroDescNeedStaff")
                        : t("assetsHeroDescWorking", { remaining: remainingCount })}
                    </p>
                    {batchError && !isBatchGenerating && (
                      <p className="mt-1.5 text-sm font-medium text-destructive">{batchError}</p>
                    )}
                    {stockMsg && !isFillingStock && (
                      <p className="mt-1.5 text-sm text-muted-foreground">{stockMsg}</p>
                    )}
                  </div>
                  {allDone ? (
                    <Link href={`/project/${id}/motion`}>
                      <Button className="brand-gradient text-white text-sm">
                        {t("nextMotion")}
                        <LuArrowRight className="w-4 h-4 ml-1" />
                      </Button>
                    </Link>
                  ) : (
                    <Button
                      className="brand-gradient text-white text-sm"
                      disabled={isBatchGenerating || isFillingStock || assets.length === 0 || (showModelWarning && !offerStockFill)}
                      onClick={offerStockFill ? fillStock : generateAll}
                    >
                      {isBatchGenerating || isFillingStock ? (
                        <>
                          <LuLoaderCircle className="animate-spin mr-1.5 h-4 w-4" />
                          {t("preparingVisuals")}
                        </>
                      ) : showModelWarning && !offerStockFill ? (
                        t("needStaff")
                      ) : (
                        <>
                          <LuZap className="w-4 h-4 mr-1" />
                          {t("prepareVisuals")}
                        </>
                      )}
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>

            <Card className="glass-card mb-6">
              <CardContent className="p-5">
                <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                  <h3 className="text-base font-semibold">{t("assetResultTitle")}</h3>
                  <span className="text-xs text-muted-foreground">
                    {t("assetResultMeta", { done: doneCount, total: assets.length })}
                  </span>
                </div>
                <div className="mt-4 grid gap-2 sm:grid-cols-3">
                  <div className="rounded-lg border border-border/50 bg-muted/10 p-3">
                    <p className="text-xs text-muted-foreground">{t("assetResultReadyRate")}</p>
                    <p className="mt-1 text-sm font-semibold">{doneCount}/{assets.length}</p>
                  </div>
                  <div className="rounded-lg border border-border/50 bg-muted/10 p-3">
                    <p className="text-xs text-muted-foreground">{t("assetResultProductSafe")}</p>
                    <p className="mt-1 text-sm font-semibold">{productSafe ? t("assetResultEnabled") : t("assetResultDisabled")}</p>
                  </div>
                  <div className="rounded-lg border border-border/50 bg-muted/10 p-3">
                    <p className="text-xs text-muted-foreground">{t("assetResultMotion")}</p>
                    <p className="mt-1 text-sm font-semibold">{videoAgentReady ? t("assetResultEnabled") : t("assetResultFallback")}</p>
                  </div>
                </div>
                <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
                  {assets.map((asset) => (
                    <div key={asset.shotId} className="overflow-hidden rounded-lg border border-border/50 bg-muted/20">
                      <div className="relative aspect-[9/12] bg-muted/30">
                        {asset.status === "done" && asset.thumbnailUrl ? (
                          asset.isVideo && /\.(mp4|webm|mov|m4v)$/i.test(asset.thumbnailUrl) ? (
                            <video
                              src={asset.thumbnailUrl}
                              muted
                              playsInline
                              className="h-full w-full object-cover"
                            />
                          ) : (
                            <div
                              className="h-full w-full bg-cover bg-center"
                              style={{ backgroundImage: `url(${asset.thumbnailUrl})` }}
                            />
                          )
                        ) : asset.status === "generating" ? (
                          <div className="flex h-full items-center justify-center">
                            <LuLoaderCircle className="h-5 w-5 animate-spin text-muted-foreground" />
                          </div>
                        ) : (
                          <div className="flex h-full items-center justify-center px-2 text-center text-xs text-muted-foreground">
                            {t("assetResultWaiting")}
                          </div>
                        )}
                        <span className="absolute left-2 top-2 rounded-full bg-background/85 px-2 py-0.5 text-xs font-medium">
                          {asset.shotId}
                        </span>
                      </div>
                      <div className="space-y-2 p-3">
                        <div className="flex items-center justify-between gap-2">
                          <Badge className={`${SHOT_TYPE_INFO[asset.type].color} border-0 text-[10px]`}>
                            {t(SHOT_TYPE_INFO[asset.type].labelKey)}
                          </Badge>
                          <span className="text-[11px] text-muted-foreground">{asset.duration}s</span>
                        </div>
                        <p className="line-clamp-2 min-h-9 text-xs leading-relaxed text-foreground">
                          {asset.description}
                        </p>
                        <p className="text-[11px] text-muted-foreground">
                          {asset.status === "done"
                            ? t("simpleDone")
                            : asset.status === "generating"
                            ? t("simpleGenerating")
                            : asset.status === "failed"
                            ? t("simpleFailed")
                            : t("simplePending")}
                        </p>
                        {asset.visualSource === "ai_generate" && (
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-7 w-full text-xs"
                            disabled={asset.status === "generating" || isBatchGenerating}
                            onClick={() => generateOne(asset.shotId)}
                          >
                            {asset.status === "generating"
                              ? t("btnGenerating")
                              : asset.status === "done"
                              ? t("btnRegenerate")
                              : asset.status === "failed"
                              ? tc("retry")
                              : t("btnGenerate")}
                          </Button>
                        )}
                        {asset.error && (
                          <p className="text-[10px] leading-relaxed text-destructive">{asset.error}</p>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>

            {/* 素材列表 */}
            <details className="hidden">
              <summary className="cursor-pointer list-none rounded-lg border border-border/60 bg-muted/20 px-4 py-2 text-sm font-medium text-muted-foreground transition hover:text-foreground">
                {t("viewAssetDetails")}
              </summary>
            <div className="mt-3 space-y-4">
              {assets.map((asset) => {
                const typeInfo = SHOT_TYPE_INFO[asset.type];
                return (
                  <Card key={asset.shotId} className="glass-card overflow-hidden">
                    <CardContent className="p-0">
                      <div className="flex">
                        {/* 左侧序号 */}
                        <div className="flex flex-col items-center justify-center w-16 py-4 border-r border-border/50 shrink-0">
                          <span className="text-lg font-bold text-muted-foreground/50">
                            {String(asset.shotId).padStart(2, "0")}
                          </span>
                          <Badge className={`${typeInfo.color} border-0 text-[10px] mt-1`}>
                            {t(typeInfo.labelKey)}
                          </Badge>
                          <span className="text-[10px] text-muted-foreground mt-1">{asset.duration}s</span>
                        </div>

                        {/* 中间内容 */}
                        <div className="flex-1 p-4">
                          <p className="text-sm leading-relaxed mb-2">{asset.description}</p>
                          <p className="text-xs text-muted-foreground bg-muted/20 rounded px-2 py-1.5 mb-2">
                            {asset.status === "done"
                              ? t("simpleDone")
                              : asset.status === "generating"
                              ? t("simpleGenerating")
                              : asset.status === "failed"
                              ? t("simpleFailed")
                              : t("simplePending")}
                          </p>
                          <div className="flex items-center gap-2 text-xs text-muted-foreground">
                            <span>
                              {asset.assetType === "stock_footage"
                                ? t("sourceStock")
                                : asset.visualSource === "product_image"
                                ? t("sourceProductImage")
                                : asset.visualSource === "ai_generate"
                                ? t("sourceAiGenerate")
                                : t("sourceUserUpload")}
                            </span>
                          </div>
                          {asset.status === "failed" && asset.error && (
                            <p className="text-xs text-destructive mt-2">⚠ {asset.error}</p>
                          )}
                        </div>

                        {/* 右侧预览+操作 */}
                        <div className="flex flex-col items-center justify-center gap-2 p-4 shrink-0">
                          {/* 缩略图区域 */}
                          <div className="w-24 h-16 bg-muted/30 rounded-md flex items-center justify-center border border-border/30 overflow-hidden">
                            {asset.status === "done" && asset.thumbnailUrl ? (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img src={asset.thumbnailUrl} alt={t("assetPreviewAlt")} className="w-full h-full object-cover" />
                            ) : asset.status === "done" ? (
                              <div className="w-full h-full bg-gradient-to-br from-primary/20 to-primary/5 flex items-center justify-center">
                                <LuCheck className="w-5 h-5 text-primary" />
                              </div>
                            ) : asset.status === "generating" ? (
                              <LuLoaderCircle className="animate-spin h-5 w-5 text-primary" />
                            ) : asset.status === "failed" ? (
                              <LuCircleX className="w-5 h-5 text-destructive" />
                            ) : (
                              <LuImage className="w-4 h-4 text-muted-foreground/40" />
                            )}
                          </div>

                          {/* 操作按钮（AI 生成分镜可手动生成/重试） */}
                          {asset.visualSource === "ai_generate" && (
                            <Button
                              variant="outline"
                              size="sm"
                              className="text-xs w-24"
                              disabled={asset.status === "generating"}
                              onClick={() => generateOne(asset.shotId)}
                            >
                              {asset.status === "generating"
                                ? t("btnGenerating")
                                : asset.status === "done"
                                ? t("btnRegenerate")
                                : asset.status === "failed"
                                ? tc("retry")
                                : t("btnGenerate")}
                            </Button>
                          )}
                          {asset.isVideo && (
                            <span className="text-[10px] text-primary">{t("motionDone")}</span>
                          )}
                          {asset.error && (
                            <span className="text-[10px] text-destructive max-w-24 text-center">{asset.error}</span>
                          )}
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
            </details>

          </>
        )}
      </main>
    </div>
  );
}
