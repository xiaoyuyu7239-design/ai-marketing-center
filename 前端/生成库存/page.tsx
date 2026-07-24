"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  CalendarCheck,
  CheckCircle2,
  FileVideo2,
  PackageCheck,
  Search,
  Sparkles,
  Trash2,
} from "lucide-react";
import { Button } from "@frontend/components/ui/button";
import { Badge } from "@frontend/components/ui/badge";
import { LanguageToggle } from "@frontend/components/language-toggle";
import { BrandWheatMark } from "@frontend/components/brand-wheat-logo";
import { useVideoApprovalStore } from "@frontend/stores/video-approval-store";
import {
  LOW_GENERATION_INVENTORY_THRESHOLD,
  coerceGenerationProjects,
  coerceRankedPublishCandidates,
  filterProjects,
  formatProjectDate,
  getApprovedProjects,
  isLowGenerationInventory,
  isProjectComplete,
  projectCover,
  projectStatusText,
  projectTitle,
  publishPickStrategyOptions,
  rankTodayPublishCandidates,
  sortProjectsByUpdatedDesc,
  type GenerationProject,
  type RankedPublishCandidate,
} from "@frontend/lib/generation-records";
import { goldenTimeHint } from "@backend/core/publish/golden-time";
import { WeeklyReport } from "@frontend/components/weekly-report";

export default function ProductsPage() {
  const approvedVideos = useVideoApprovalStore((state) => state.approved);
  const publishedVideos = useVideoApprovalStore((state) => state.published);
  const rejectedVideos = useVideoApprovalStore((state) => state.rejected);
  const unapproveProject = useVideoApprovalStore((state) => state.unapproveProject);
  const hydrateApprovalStore = useVideoApprovalStore((state) => state.hydrateFromServer);
  const approvalHydrated = useVideoApprovalStore((state) => state.hydrated);
  const authRequired = useVideoApprovalStore((state) => state.authRequired);
  const dailyPickCount = useVideoApprovalStore((state) => state.dailyPickCount);
  const setDailyPickCount = useVideoApprovalStore((state) => state.setDailyPickCount);
  const publishPickStrategy = useVideoApprovalStore((state) => state.publishPickStrategy);
  const setPublishPickStrategy = useVideoApprovalStore((state) => state.setPublishPickStrategy);

  // 认可入库/发布状态存服务端，进页面先水合
  useEffect(() => {
    void hydrateApprovalStore();
  }, [hydrateApprovalStore]);

  const [projects, setProjects] = useState<GenerationProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [compositionUrls, setCompositionUrls] = useState<Record<string, string | null>>({});
  const [todayRankedItems, setTodayRankedItems] = useState<RankedPublishCandidate[]>([]);
  const [isRankingToday, setIsRankingToday] = useState(false);
  const [todayRankSource, setTodayRankSource] = useState<"llm" | "rule">("rule");
  const [goldenHint, setGoldenHint] = useState<string | null>(null);
  // 本地门店商家：黄金时段用"到店决策时刻"窗口（如餐饮=饭点前）
  const [isLocalStoreMerchant, setIsLocalStoreMerchant] = useState(false);

  useEffect(() => {
    let ignore = false;
    fetch("/api/auth/me", { cache: "no-store" })
      .then(async (res) => {
        if (ignore || !res.ok) return;
        const data = await res.json().catch(() => ({}));
        const storeType = data.merchant?.storeType;
        if (!ignore) setIsLocalStoreMerchant(storeType === "local" || storeType === "both");
      })
      .catch(() => undefined);
    return () => {
      ignore = true;
    };
  }, []);

  useEffect(() => {
    let ignore = false;

    async function loadProjects() {
      setLoading(true);
      try {
        const res = await fetch("/api/project", { cache: "no-store" });
        const data = await res.json().catch(() => []);
        if (!ignore && res.ok) setProjects(sortProjectsByUpdatedDesc(coerceGenerationProjects(data)));
      } catch {
        if (!ignore) setProjects([]);
      } finally {
        if (!ignore) setLoading(false);
      }
    }

    loadProjects();
    return () => {
      ignore = true;
    };
  }, []);

  const approvedProjects = useMemo(
    () => filterProjects(getApprovedProjects(projects, approvedVideos), query),
    [approvedVideos, projects, query]
  );
  const approvedInventoryTotal = useMemo(() => getApprovedProjects(projects, approvedVideos).length, [approvedVideos, projects]);
  const fallbackTodayItems = useMemo(
    () => rankTodayPublishCandidates(projects, approvedVideos, dailyPickCount, publishPickStrategy, new Date(), publishedVideos),
    [approvedVideos, dailyPickCount, projects, publishedVideos, publishPickStrategy]
  );
  const todayItems = todayRankedItems.length > 0 ? todayRankedItems : fallbackTodayItems;

  // 黄金发布时间提示：按今日第一条候选的品类算；放 effect 里避免 SSR/客户端时钟不一致的水合警告
  useEffect(() => {
    if (todayItems.length === 0) {
      setGoldenHint(null);
      return;
    }
    // 先用本地行业模板立即出提示，服务端版（数据攒够后按自家回流校准）到了再升级覆盖；未登录/请求失败就停在本地版
    setGoldenHint(goldenTimeHint(todayItems[0]?.project.productCategory, new Date(), { localStore: isLocalStoreMerchant }).hint);
    let ignore = false;
    fetch("/api/reminders/settings", { cache: "no-store" })
      .then(async (res) => {
        if (ignore || !res.ok) return;
        const data = await res.json().catch(() => ({}));
        if (!ignore && typeof data.hint === "string" && data.hint) setGoldenHint(data.hint);
      })
      .catch(() => undefined);
    return () => {
      ignore = true;
    };
  }, [todayItems, isLocalStoreMerchant]);
  const completedCount = useMemo(() => projects.filter(isProjectComplete).length, [projects]);
  // 服务端数据未水合完成前不判断库存不足，避免页面加载瞬间闪一次错误告警
  const hasLowInventory = approvalHydrated && !loading && isLowGenerationInventory(approvedInventoryTotal);
  // 被运营驳回的内容（连原因），配上项目标题展示给商家，解释"这条为什么不见了"
  const rejectedList = useMemo(() => {
    return Object.values(rejectedVideos)
      .map((r) => ({ ...r, project: projects.find((p) => p.id === r.projectId) }))
      .filter((r) => r.project);
  }, [rejectedVideos, projects]);

  useEffect(() => {
    let ignore = false;

    if (loading || fallbackTodayItems.length === 0) {
      setTodayRankedItems([]);
      setTodayRankSource("rule");
      setIsRankingToday(false);
      return;
    }

    setTodayRankedItems(fallbackTodayItems);
    setTodayRankSource("rule");
    setIsRankingToday(true);

    async function rankTodayItems() {
      try {
        // 项目与入库/发布状态服务端已有权威数据，只需传数量与策略
        const res = await fetch("/api/llm/publish-ranker", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            count: dailyPickCount,
            strategy: publishPickStrategy,
          }),
        });
        const data: unknown = await res.json().catch(() => ({}));
        if (!res.ok || ignore) return;
        const response = data as { candidates?: unknown; source?: unknown };
        const ranked = coerceRankedPublishCandidates(response.candidates);
        setTodayRankedItems(ranked.length > 0 ? ranked : fallbackTodayItems);
        setTodayRankSource(response.source === "llm" ? "llm" : "rule");
      } catch {
        if (!ignore) {
          setTodayRankedItems(fallbackTodayItems);
          setTodayRankSource("rule");
        }
      } finally {
        if (!ignore) setIsRankingToday(false);
      }
    }

    rankTodayItems();
    return () => {
      ignore = true;
    };
  }, [approvedVideos, dailyPickCount, fallbackTodayItems, loading, projects, publishedVideos, publishPickStrategy]);

  useEffect(() => {
    let ignore = false;
    const missing = approvedProjects.filter((project) => !(project.id in compositionUrls));
    if (missing.length === 0) return;

    async function loadCompositions() {
      const next: Record<string, string | null> = {};
      await Promise.all(
        missing.map(async (project) => {
          try {
            const res = await fetch(`/api/project/${project.id}/compose`, { cache: "no-store" });
            const data = await res.json().catch(() => ({}));
            next[project.id] = typeof data?.composition?.url === "string" ? data.composition.url : null;
          } catch {
            next[project.id] = null;
          }
        })
      );
      if (!ignore) setCompositionUrls((current) => ({ ...current, ...next }));
    }

    loadCompositions();
    return () => {
      ignore = true;
    };
  }, [approvedProjects, compositionUrls]);

  return (
    <div className="workflow-light min-h-screen bg-[#F6F7F9] text-[#111111]">
      <header className="sticky top-0 z-50 border-b border-[#E2E5EA] bg-white/95 backdrop-blur-xl">
        <div className="mx-auto flex h-14 max-w-7xl items-center justify-between px-6">
          <Link href="/project/agent" className="flex items-center gap-3">
            <BrandWheatMark className="h-9 w-7 text-[#111827]" />
            <span className="text-lg font-black tracking-tight">生成库存</span>
          </Link>
          <div className="flex items-center gap-2">
            <LanguageToggle />
            <Link href="/project/agent#history">
              <Button variant="ghost" size="sm" className="text-[#6B7280] hover:bg-[#EEF1F4] hover:text-[#111111]">
                <ArrowLeft className="size-4" />
                <span className="ml-1.5">历史记录</span>
              </Button>
            </Link>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-6 py-10">
        {authRequired && (
          <section className="mb-6 rounded-2xl border border-[#E2C58E] bg-[#FFF9EE] p-5 shadow-sm">
            <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
              <div>
                <p className="text-sm font-black text-[#6B4E11]">还没有登录</p>
                <p className="mt-1 text-sm font-semibold text-[#8A6A24]">登录后才能看到你的生成库存和今日待发布，下面的数据当前是空的。</p>
              </div>
              <Link href="/project/agent">
                <Button className="bg-[#111111] text-white hover:bg-[#2B2B2B]">去创作工作台登录</Button>
              </Link>
            </div>
          </section>
        )}
        <section className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-[#DDE2E8] bg-white px-3 py-1 text-xs font-black text-[#596170]">
              <PackageCheck className="size-3.5" />
              用户认可的视频
            </div>
            <h1 className="text-3xl font-black tracking-tight text-[#111111]">生成库存</h1>
            <p className="mt-2 max-w-2xl text-sm font-semibold leading-6 text-[#6B7280]">
              这里只保留已经认可入库的成片，后续发布、复投和每日择优都从这里开始。
            </p>
          </div>
          <label className="flex h-11 w-full items-center gap-3 rounded-xl border border-[#DDE2E8] bg-white px-4 text-[#8A94A0] shadow-sm lg:w-[360px]">
            <Search className="size-5" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索库存视频"
              className="min-w-0 flex-1 bg-transparent text-sm font-semibold text-[#222222] outline-none placeholder:text-[#8A94A0]"
            />
          </label>
        </section>

        <section className="mt-8 grid gap-4 md:grid-cols-3">
          <div className="rounded-2xl border border-[#E2E5EA] bg-white p-5 shadow-sm">
            <p className="text-xs font-black text-[#8A94A0]">已认可</p>
            <p className="mt-2 text-3xl font-black">{approvedInventoryTotal}</p>
          </div>
          <div className="rounded-2xl border border-[#E2E5EA] bg-white p-5 shadow-sm">
            <p className="text-xs font-black text-[#8A94A0]">今日待发布</p>
            <p className="mt-2 text-3xl font-black">{todayItems.length}</p>
          </div>
          <div className="rounded-2xl border border-[#E2E5EA] bg-white p-5 shadow-sm">
            <p className="text-xs font-black text-[#8A94A0]">全部成片</p>
            <p className="mt-2 text-3xl font-black">{completedCount}</p>
          </div>
        </section>

        {/* 账号周报：近 7 天数据 + 复盘经验汇总成大白话（数据飞轮的账号级视角） */}
        <WeeklyReport />

        {rejectedList.length > 0 && (
          <section className="mt-6 rounded-2xl border border-[#F0C9C9] bg-[#FDF3F3] p-5 shadow-sm">
            <div className="flex items-center gap-2 text-sm font-black text-[#8A2A2A]">
              <PackageCheck className="size-4" />
              <span>{rejectedList.length} 条内容被平台驳回</span>
            </div>
            <ul className="mt-3 space-y-2">
              {rejectedList.map((r) => (
                <li key={r.projectId} className="text-sm font-semibold text-[#9A4A4A]">
                  「{projectTitle(r.project!)}」{r.reviewNote ? `：${r.reviewNote}` : "（未填写原因，可联系客服了解）"}
                </li>
              ))}
            </ul>
          </section>
        )}

        {hasLowInventory && (
          <section className="mt-6 rounded-2xl border border-[#E2E5EA] bg-white p-5 shadow-sm">
            <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
              <div>
                <div className="flex items-center gap-2 text-sm font-black text-[#111111]">
                  <PackageCheck className="size-4" />
                  <span>生成库存低于 {LOW_GENERATION_INVENTORY_THRESHOLD} 条</span>
                </div>
                <p className="mt-1 text-sm font-semibold leading-6 text-[#6B7280]">
                  当前库存 {approvedInventoryTotal} 条，建议从工作台继续生成项目视频，成片后认可入库。
                </p>
              </div>
              <Link href="/project/agent">
                <Button className="bg-[#111111] text-white hover:bg-[#2B2B2B]">
                  <Sparkles className="size-4" />
                  生成新视频
                </Button>
              </Link>
            </div>
          </section>
        )}

        <section className="mt-6 rounded-2xl border border-[#E2E5EA] bg-white p-5 shadow-sm">
          <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <div className="flex flex-wrap items-center gap-2">
              <CalendarCheck className="size-5 text-[#111111]" />
              <h2 className="text-lg font-black">待发布</h2>
              <Badge variant="secondary" className="bg-[#EEF1F4] text-[#5E6875]">
                今日
              </Badge>
              {goldenHint && (
                <span className="text-xs font-bold text-[#68717E]">{goldenHint}</span>
              )}
            </div>
            <div className="flex flex-wrap items-center justify-end gap-2">
              <div className="flex items-center gap-2">
                <span className="text-xs font-black text-[#8A94A0]">数量</span>
                {[1, 2, 3, 4, 5].map((count) => (
                  <button
                    key={count}
                    type="button"
                    onClick={() => setDailyPickCount(count)}
                    className={`grid size-8 place-items-center rounded-lg text-xs font-black transition ${
                      dailyPickCount === count
                        ? "bg-[#111111] text-white"
                        : "bg-[#F0F2F5] text-[#737B86] hover:bg-[#E0E4E9]"
                    }`}
                  >
                    {count}
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs font-black text-[#8A94A0]">推荐</span>
                {publishPickStrategyOptions.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => setPublishPickStrategy(option.value)}
                    className={`h-8 rounded-lg px-3 text-xs font-black transition ${
                      publishPickStrategy === option.value
                        ? "bg-[#111111] text-white"
                        : "bg-[#F0F2F5] text-[#737B86] hover:bg-[#E0E4E9]"
                    }`}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
              <Badge variant="secondary" className="bg-[#EEF1F4] text-[#5E6875]">
                {isRankingToday ? "择优中" : todayRankSource === "llm" ? "LLM择优" : "规则兜底"}
              </Badge>
            </div>
          </div>

          <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-5">
            {todayItems.length > 0 ? (
              todayItems.map((candidate) => {
                const project = candidate.project;
                const cover = projectCover(project);
                return (
                  <Link
                    key={project.id}
                    href={`/project/${project.id}/export?publishReady=1`}
                    className="flex items-center gap-3 rounded-xl border border-[#E4E8EE] bg-[#F8F9FB] p-3 transition hover:border-[#BFC7D0] hover:bg-white"
                  >
                    <span className="grid size-12 shrink-0 place-items-center overflow-hidden rounded-lg bg-white text-[#9098A3]">
                      {cover ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={cover} alt="" className="h-full w-full object-cover" />
                      ) : (
                        <FileVideo2 className="size-5" />
                      )}
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-black">{projectTitle(project)}</span>
                      <span className="mt-0.5 block truncate text-xs font-bold text-[#8A94A0]">
                        {candidate.source === "llm" ? "LLM择优" : "规则兜底"} · {candidate.reason}
                      </span>
                    </span>
                  </Link>
                );
              })
            ) : (
              <div className="rounded-xl bg-[#F5F6F8] px-4 py-5 text-sm font-black text-[#737B86] md:col-span-2 xl:col-span-5">
                还没有可选的库存视频
              </div>
            )}
          </div>
        </section>

        <section className="mt-8">
          <div className="mb-5 flex items-center justify-between">
            <h2 className="text-lg font-black">全部库存视频</h2>
            <span className="text-sm font-bold text-[#68717E]">{approvedProjects.length} 条</span>
          </div>

          {loading ? (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {[1, 2, 3, 4].map((item) => (
                <div key={item} className="h-80 animate-pulse rounded-2xl bg-white" />
              ))}
            </div>
          ) : approvedProjects.length > 0 ? (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {approvedProjects.map((project) => {
                const cover = projectCover(project);
                const videoUrl = compositionUrls[project.id];
                return (
                  <article key={project.id} className="overflow-hidden rounded-2xl border border-[#E2E5EA] bg-white shadow-sm">
                    <Link href={`/project/${project.id}/export`} className="block">
                      <div className="relative aspect-[9/16] bg-[#EEF1F4]">
                        {videoUrl ? (
                          <video
                            src={videoUrl}
                            autoPlay
                            muted
                            loop
                            playsInline
                            preload="metadata"
                            className="h-full w-full object-cover"
                          />
                        ) : cover ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={cover} alt="" className="h-full w-full object-cover" />
                        ) : (
                          <div className="absolute inset-0 grid place-items-center text-[#9AA3AE]">
                            <FileVideo2 className="size-9" />
                          </div>
                        )}
                        <div className="absolute left-3 top-3 rounded-full bg-white/88 px-2.5 py-1 text-[11px] font-black text-[#2F3742]">
                          {projectStatusText(project.status)}
                        </div>
                        <div className="absolute right-3 top-3 grid size-8 place-items-center rounded-full bg-[#111111] text-white">
                          <CheckCircle2 className="size-4" />
                        </div>
                      </div>
                    </Link>
                    <div className="p-4">
                      <div className="mb-1 flex items-center justify-between gap-3">
                        <h3 className="truncate text-sm font-black">{projectTitle(project)}</h3>
                        {formatProjectDate(project) && (
                          <span className="shrink-0 text-xs font-bold text-[#8A94A0]">{formatProjectDate(project)}</span>
                        )}
                      </div>
                      <p className="line-clamp-2 min-h-10 text-xs font-semibold leading-5 text-[#7A8491]">
                        {project.productDescription?.trim() || project.name}
                      </p>
                      <div className="mt-4 flex gap-2">
                        <Link href={`/project/${project.id}/export`} className="flex-1">
                          <Button className="h-9 w-full bg-[#111111] text-white hover:bg-[#2B2B2B]">
                            <Sparkles className="size-4" />
                            发布
                          </Button>
                        </Link>
                        <Button
                          variant="outline"
                          className="h-9 border-[#DDE2E8] text-[#596170]"
                          onClick={() => unapproveProject(project.id)}
                          aria-label={`移出 ${projectTitle(project)}`}
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          ) : (
            <div className="flex min-h-72 flex-col items-center justify-center rounded-2xl border border-dashed border-[#D7DDE5] bg-white px-6 text-center">
              <FileVideo2 className="mb-4 size-10 text-[#9AA3AE]" />
              <h3 className="text-lg font-black text-[#111111]">还没有认可入库的视频</h3>
              <p className="mt-2 max-w-md text-sm font-semibold leading-6 text-[#7A8491]">
                已生成的内容会在历史记录里，认可后才会进入这里。
              </p>
              <Link href="/project/agent#history" className="mt-5">
                <Button className="bg-[#111111] text-white hover:bg-[#2B2B2B]">去历史记录</Button>
              </Link>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
