"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { useParams, useRouter } from "next/navigation";
import { LuArrowRight, LuLoaderCircle, LuCopy, LuCheck, LuDownload, LuSparkles, LuRefreshCw } from "react-icons/lu";
import Link from "next/link";
import { Card, CardContent } from "@frontend/components/ui/card";
import { Button } from "@frontend/components/ui/button";
import { buildImageOptions } from "@backend/shared/gen-params";
import type { ImagePackSpec } from "@backend/script-engine/prompts";
import type { ImageCleanRecord } from "@backend/shared/image-clean";
import { BrandWheatMark } from "@frontend/components/brand-wheat-logo";
import { useLocale } from "@frontend/i18n";
import { createBatchGenerationOperation, newGenerationOperationId } from "@frontend/lib/generation-operation";

/** 本地文件才走 ?download=1（/api/files 由 <a download> 属性触发下载）；远程签名 URL 不加 query 破坏签名 */
function downloadHref(url: string) {
  return url.startsWith("/api/files/") ? `${url}?download=1` : url;
}
function isLocalFile(url?: string) {
  return !!url && url.startsWith("/api/files/");
}

/** 图片套装页生成图的 shotId 起始值：与视频分镜(1-12)错开，两条线可共存于同一项目 */
const PACK_SHOT_BASE = 100;

interface PackImageRow {
  index: number;
  purpose: string;
  description: string;
  prompt: string;
  status: "pending" | "generating" | "done" | "failed";
  url?: string;
  error?: string;
}

/**
 * 「图片宣传套装」生产线页：清洗后的主图 + 一组场景宣传图 + 朋友圈文案。
 * 图组既是独立交付物（发朋友圈），也是视频线的高质量地基（底部一键接力做视频）。
 */
export default function ImagePackPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const locale = useLocale();
  const [projectName, setProjectName] = useState("");
  const [heroImage, setHeroImage] = useState<string>("");
  const [spec, setSpec] = useState<ImagePackSpec | null>(null);
  const [clean, setClean] = useState<ImageCleanRecord | null>(null);
  const [rows, setRows] = useState<PackImageRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isBatch, setIsBatch] = useState(false);
  const [isToggling, setIsToggling] = useState(false);
  const [isBridging, setIsBridging] = useState(false);
  const [pageError, setPageError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const rowsRef = useRef<PackImageRow[]>(rows);
  useEffect(() => {
    rowsRef.current = rows;
  }, [rows]);
  // in-flight 真相源：批量 worker 与单张按钮可能同时触发同一张，state 闭包会过期，用 ref 判重防双开（双倍烧额度）
  const inFlightRef = useRef<Set<number>>(new Set());
  // 主图 ref：批量进行中切换原图/清洗图后，未启动的队列项也能读到最新主图（否则用旧闭包的 hero）
  const heroRef = useRef<string>("");
  useEffect(() => {
    heroRef.current = heroImage;
  }, [heroImage]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setLoadError(null);
      try {
        const [projectRes, packRes, assetsRes] = await Promise.all([
          fetch(`/api/project/${id}`),
          fetch(`/api/project/${id}/image-pack`),
          fetch(`/api/project/${id}/assets`),
        ]);
        if (!projectRes.ok) throw new Error("项目加载失败，请先登录");
        const project = await projectRes.json();
        const pack = packRes.ok ? await packRes.json() : { spec: null, clean: null };
        const savedAssets: Array<{ shotId: number; filePath?: string | null; status?: string | null }> =
          assetsRes.ok ? await assetsRes.json() : [];
        if (cancelled) return;

        setProjectName(project.name ?? project.productName ?? "");
        const imgs: string[] = Array.isArray(project.productImages) ? project.productImages : [];
        setHeroImage(imgs[0] ?? "");
        setSpec(pack.spec ?? null);
        setClean(pack.clean ?? null);

        const specImages = (pack.spec?.images ?? []) as ImagePackSpec["images"];
        setRows(
          specImages.map((im, i) => {
            const saved = savedAssets.find((a) => a.shotId === PACK_SHOT_BASE + i + 1 && a.filePath && a.status === "done");
            return {
              index: i,
              purpose: im.purpose,
              description: im.description,
              prompt: im.prompt,
              status: saved ? ("done" as const) : ("pending" as const),
              url: saved?.filePath ?? undefined,
            };
          })
        );
      } catch (e) {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : "加载失败");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  // 生成单张场景图：以清洗主图为参考做图生图（主体保真 + 物理真实 + 无脸 + 不压字）
  const generateOne = useCallback(
    async (index: number, batchOperationId?: string) => {
      const row = rowsRef.current.find((r) => r.index === index);
      const hero = heroRef.current;
      if (!row || !hero) return "缺少主图或图片规格";
      if (inFlightRef.current.has(index)) return;
      inFlightRef.current.add(index);
      setRows((prev) => prev.map((r) => (r.index === index ? { ...r, status: "generating", error: undefined } : r)));
      const genPrompt =
        `以参考图中的商品为准，严格保持商品的形状、比例、颜色、材质、logo 与文字细节完全一致（是同一件商品）；` +
        `在此前提下按这个场景重新构图：${row.prompt}。` +
        `画面遵循真实物理：商品有可信支撑（放在台面上或被手拿着）、保持真实小物尺寸、绝不悬浮；` +
        `画面不出现完整清晰的正脸；不要出现任何文字、水印或图形贴片。`;
      try {
        const operationId = batchOperationId || newGenerationOperationId("image-single");
        const res = await fetch("/api/ai/image", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            projectId: id,
            mode: "image-to-image",
            prompt: genPrompt,
            imageUrl: hero,
            options: buildImageOptions(undefined),
            operationId,
            operationType: batchOperationId ? "image-batch" : "image-single",
            itemKey: `pack:${index}`,
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "生成失败");
        const url = data.imageUrls?.[0];
        if (!url) throw new Error("生成结果为空");
        let savedUrl = url;
        try {
          const saveRes = await fetch(`/api/project/${id}/assets`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ shotId: PACK_SHOT_BASE + index + 1, type: "ai_generate", sourceUrl: url, prompt: row.prompt }),
          });
          if (saveRes.ok) {
            const saved = await saveRes.json();
            if (saved.filePath) savedUrl = saved.filePath;
          }
        } catch {
          // 落库失败不阻断预览
        }
        setRows((prev) => prev.map((r) => (r.index === index ? { ...r, status: "done", url: savedUrl } : r)));
        return undefined;
      } catch (e) {
        const message = e instanceof Error ? e.message : "生成失败";
        setRows((prev) => prev.map((r) => (r.index === index ? { ...r, status: "failed", error: message } : r)));
        return message;
      } finally {
        inFlightRef.current.delete(index);
      }
    },
    [id]
  );

  // 一键生成全部（两路并行，生图接口限流友好）
  const generateAll = useCallback(async () => {
    const queue = rowsRef.current
      .filter((r) => (r.status === "pending" || r.status === "failed") && !inFlightRef.current.has(r.index))
      .map((r) => r.index);
    if (queue.length === 0) return;
    setIsBatch(true);
    setPageError(null);
    const operationId = newGenerationOperationId("image-batch");
    try {
      await createBatchGenerationOperation({
        projectId: id,
        kind: "image",
        operationId,
        itemKeys: queue.map((index) => `pack:${index}`),
      });
    } catch (error) {
      setPageError(error instanceof Error ? error.message : "创建批量生成任务失败");
      setIsBatch(false);
      return;
    }
    const failures: string[] = [];
    const worker = async () => {
      for (let idx = queue.shift(); idx !== undefined; idx = queue.shift()) {
        if (inFlightRef.current.has(idx)) continue;
        const err = await generateOne(idx, operationId);
        if (err) failures.push(`第 ${idx + 2} 张：${err}`);
      }
    };
    await Promise.all([worker(), worker()]);
    if (failures.length > 0) setPageError(failures[0]);
    setIsBatch(false);
  }, [generateOne, id]);

  // 清洗图/原图 切换（改写 project.productImages，两条线一起跟随）
  const toggleCleaned = useCallback(async () => {
    if (!clean || isToggling) return;
    setIsToggling(true);
    setPageError(null);
    try {
      const res = await fetch(`/api/project/${id}/clean-images`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ useCleaned: !clean.useCleaned }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "切换失败");
      setClean({ ...clean, useCleaned: !clean.useCleaned });
      setHeroImage((data.productImages ?? [])[0] ?? "");
    } catch (e) {
      setPageError(e instanceof Error ? e.message : "切换失败");
    } finally {
      setIsToggling(false);
    }
  }, [clean, isToggling, id]);

  const copyText = useCallback(async (key: string, text: string) => {
    if (!text) return;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        // 非 https（自部署内网常见）没有 clipboard API，降级到 execCommand
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      }
      setCopied(key);
      setTimeout(() => setCopied((c) => (c === key ? null : c)), 1500);
    } catch {
      setPageError("当前环境无法自动复制，请手动选中文案复制");
    }
  }, []);

  // 用这套清洗资产接力生成宣传视频（同一项目直接进视频线）
  const bridgeToVideo = useCallback(async () => {
    if (isBridging) return;
    setIsBridging(true);
    setPageError(null);
    try {
      const projectRes = await fetch(`/api/project/${id}`);
      const project = projectRes.ok ? await projectRes.json() : {};
      const res = await fetch("/api/llm/script", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: id,
          productName: project.productName || projectName,
          category: project.productCategory || "other",
          productDescription: project.productDescription || "",
          productImages: Array.isArray(project.productImages) ? project.productImages : [],
          styleType: "auto",
          quick: true,
          count: 1,
          locale,
          timeoutMs: 60000,
          maxTokens: 5000,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "视频脚本生成失败");
      router.push(`/project/${id}/script`);
    } catch (e) {
      setPageError(e instanceof Error ? e.message : "接力失败");
      setIsBridging(false);
    }
  }, [id, isBridging, projectName, locale, router]);

  const doneCount = rows.filter((r) => r.status === "done").length;
  const cleanedCount = clean?.pairs?.filter((p) => p.cleaned).length ?? 0;

  return (
    <div className="workflow-light min-h-screen grid-bg">
      <header className="sticky top-0 z-50 border-b border-border/50 bg-background/80 backdrop-blur-xl">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-6">
          <div className="flex items-center gap-4">
            <Link href="/project/agent" className="flex items-center gap-3">
              <BrandWheatMark className="h-9 w-7 text-foreground" />
            </Link>
            <span className="text-muted-foreground">/</span>
            <span className="text-sm text-muted-foreground truncate max-w-[40vw] sm:max-w-xs">
              {projectName || "图片宣传套装"}
            </span>
          </div>
          <span className="rounded-full bg-foreground px-3 py-1 text-xs font-semibold text-background">图片宣传套装</span>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-6">
        {loading ? (
          <div className="flex items-center justify-center py-24 text-sm text-muted-foreground">
            <LuLoaderCircle className="mr-2 h-4 w-4 animate-spin" />
            正在加载图片套装...
          </div>
        ) : loadError ? (
          <Card className="glass-card">
            <CardContent className="px-5 py-10 text-center text-sm text-muted-foreground">{loadError}</CardContent>
          </Card>
        ) : !spec ? (
          <Card className="glass-card">
            <CardContent className="px-5 py-10 text-center text-sm text-muted-foreground">
              还没有图片套装脚本——请回工作台重新发起「宣传图套装」生成。
            </CardContent>
          </Card>
        ) : (
          <>
            {/* 概念 + 进度 + 主操作 */}
            <Card className="glass-card mb-5 py-0">
              <CardContent className="px-5 py-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <h2 className="text-lg font-semibold">朋友圈图片套装</h2>
                    <p className="mt-0.5 text-sm text-muted-foreground">
                      {spec.concept ? `创意概念：${spec.concept}` : "一组场景宣传图 + 配套文案"}
                    </p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      场景图 {doneCount}/{rows.length} 张就绪 · 加上清洗主图共 {rows.length + 1} 张
                    </p>
                    {pageError && <p className="mt-1.5 text-sm font-medium text-destructive">{pageError}</p>}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {doneCount < rows.length && (
                      <Button className="brand-gradient text-white text-sm" disabled={isBatch} onClick={generateAll}>
                        {isBatch ? (
                          <>
                            <LuLoaderCircle className="animate-spin mr-1.5 h-4 w-4" />
                            生成中...
                          </>
                        ) : (
                          <>
                            <LuSparkles className="w-4 h-4 mr-1" />
                            一键生成场景图（{rows.length - doneCount}）
                          </>
                        )}
                      </Button>
                    )}
                    <Button variant="outline" className="text-sm" disabled={isBridging} onClick={bridgeToVideo}>
                      {isBridging ? (
                        <>
                          <LuLoaderCircle className="animate-spin mr-1.5 h-4 w-4" />
                          正在接力...
                        </>
                      ) : (
                        <>
                          用这套图继续做宣传视频
                          <LuArrowRight className="w-4 h-4 ml-1" />
                        </>
                      )}
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* 清洗对比：原图 vs 清洗图 */}
            {clean && clean.pairs.length > 0 && (
              <Card className="glass-card mb-5">
                <CardContent className="p-5">
                  <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <h3 className="text-base font-semibold">商品图清洗</h3>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        已自动清洗 {cleanedCount}/{clean.pairs.length} 张（去除杂乱背景，作为整套产出的地基）；当前使用：
                        {clean.useCleaned ? "清洗图" : "原图"}
                      </p>
                    </div>
                    <Button variant="outline" size="sm" className="text-xs" disabled={isToggling} onClick={toggleCleaned}>
                      {isToggling ? <LuLoaderCircle className="h-3.5 w-3.5 animate-spin" /> : clean.useCleaned ? "改用原图" : "改用清洗图"}
                    </Button>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-3">
                    {clean.pairs.map((p, i) => (
                      <div key={i} className="flex items-center gap-1.5">
                        <div className="overflow-hidden rounded-md border border-border/50">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={p.original} alt="原图" className={`h-24 w-18 object-cover ${clean.useCleaned && p.cleaned ? "opacity-50" : ""}`} />
                        </div>
                        <span className="text-xs text-muted-foreground">→</span>
                        <div className="overflow-hidden rounded-md border border-primary/50">
                          {p.cleaned ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={p.cleaned} alt="清洗图" className={`h-24 w-18 object-cover ${clean.useCleaned ? "" : "opacity-50"}`} />
                          ) : (
                            <div className="flex h-24 w-18 items-center justify-center text-[10px] text-muted-foreground">清洗失败<br />用原图</div>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}

            <div className="grid gap-5 lg:grid-cols-[1.6fr_1fr]">
              {/* 图组 */}
              <Card className="glass-card">
                <CardContent className="p-5">
                  <h3 className="text-base font-semibold">宣传图组</h3>
                  <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
                    {/* 第 1 张：清洗主图 */}
                    <div className="overflow-hidden rounded-lg border border-primary/40 bg-muted/20">
                      <div className="relative aspect-[3/4] bg-muted/30">
                        {heroImage ? (
                          <div className="h-full w-full bg-cover bg-center" style={{ backgroundImage: `url(${heroImage})` }} />
                        ) : (
                          <div className="flex h-full items-center justify-center text-xs text-muted-foreground">无主图</div>
                        )}
                        <span className="absolute left-2 top-2 rounded-full bg-foreground px-2 py-0.5 text-[10px] font-semibold text-background">
                          {clean?.useCleaned && clean.pairs.some((p) => p.cleaned) ? "主图 · 已清洗" : "主图 · 原图"}
                        </span>
                      </div>
                      <div className="flex items-center justify-between p-2.5">
                        <span className="text-xs text-muted-foreground">商品主图</span>
                        {isLocalFile(heroImage) && (
                          <a href={downloadHref(heroImage)} download>
                            <Button variant="ghost" size="sm" className="h-7 px-2 text-xs"><LuDownload className="h-3.5 w-3.5" /></Button>
                          </a>
                        )}
                      </div>
                    </div>
                    {/* 场景图 */}
                    {rows.map((row) => (
                      <div key={row.index} className="overflow-hidden rounded-lg border border-border/50 bg-muted/20">
                        <div className="relative aspect-[3/4] bg-muted/30">
                          {row.status === "done" && row.url ? (
                            <div className="h-full w-full bg-cover bg-center" style={{ backgroundImage: `url(${row.url})` }} />
                          ) : (
                            <div className="flex h-full flex-col items-center justify-center gap-2 px-3 text-center">
                              {row.status === "generating" ? (
                                <LuLoaderCircle className="h-5 w-5 animate-spin text-primary" />
                              ) : (
                                <span className="text-[11px] leading-relaxed text-muted-foreground">{row.description || row.purpose}</span>
                              )}
                            </div>
                          )}
                          <span className="absolute left-2 top-2 rounded-full bg-background/85 px-2 py-0.5 text-[10px] font-medium text-foreground">
                            {row.purpose}
                          </span>
                        </div>
                        <div className="flex items-center justify-between gap-1 p-2.5">
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 px-2 text-xs text-muted-foreground hover:text-primary"
                            disabled={row.status === "generating"}
                            onClick={() => generateOne(row.index)}
                          >
                            {row.status === "done" ? (
                              <><LuRefreshCw className="mr-1 h-3 w-3" />重生成</>
                            ) : row.status === "generating" ? (
                              "生成中..."
                            ) : row.status === "failed" ? (
                              "重试"
                            ) : (
                              "生成"
                            )}
                          </Button>
                          {row.status === "done" && isLocalFile(row.url) && (
                            <a href={downloadHref(row.url!)} download>
                              <Button variant="ghost" size="sm" className="h-7 px-2 text-xs"><LuDownload className="h-3.5 w-3.5" /></Button>
                            </a>
                          )}
                        </div>
                        {row.error && <p className="px-2.5 pb-2 text-[10px] text-destructive">{row.error}</p>}
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>

              {/* 文案 */}
              <Card className="glass-card h-fit">
                <CardContent className="p-5">
                  <h3 className="text-base font-semibold">朋友圈文案</h3>
                  <div className="mt-3 rounded-lg border border-border/50 bg-muted/10 p-3">
                    <p className="whitespace-pre-wrap text-sm leading-relaxed">{spec.caption || "（未生成文案）"}</p>
                    <Button variant="outline" size="sm" className="mt-2 text-xs" onClick={() => copyText("caption", spec.caption)}>
                      {copied === "caption" ? <><LuCheck className="mr-1 h-3 w-3" />已复制</> : <><LuCopy className="mr-1 h-3 w-3" />复制正文</>}
                    </Button>
                  </div>
                  {spec.altCaptions.length > 0 && (
                    <div className="mt-3 space-y-2">
                      <p className="text-xs font-medium text-muted-foreground">备选短文案</p>
                      {spec.altCaptions.map((alt, i) => (
                        <div key={i} className="flex items-start justify-between gap-2 rounded-lg border border-border/40 bg-muted/5 p-2.5">
                          <p className="text-xs leading-relaxed">{alt}</p>
                          <button
                            type="button"
                            className="shrink-0 text-muted-foreground transition hover:text-primary"
                            onClick={() => copyText(`alt-${i}`, alt)}
                            aria-label="复制备选文案"
                          >
                            {copied === `alt-${i}` ? <LuCheck className="h-3.5 w-3.5" /> : <LuCopy className="h-3.5 w-3.5" />}
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                  <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground">
                    图不压字，保持原生朋友圈质感；发圈时把文案粘贴到正文即可。
                  </p>
                </CardContent>
              </Card>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
