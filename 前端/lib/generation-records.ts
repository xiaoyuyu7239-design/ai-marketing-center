import type { ApprovedVideoRecord, PublishedVideoRecord, PublishPickStrategy } from "@frontend/stores/video-approval-store";

export interface GenerationProject {
  id: string;
  name: string;
  status?: string | null;
  productName?: string | null;
  productCategory?: string | null;
  productDescription?: string | null;
  productImages?: string[] | null;
  createdAt?: string | number | Date | null;
  updatedAt?: string | number | Date | null;
}

export type ApprovalRecords = Record<string, ApprovedVideoRecord | undefined>;
export type PublishedRecords = Record<string, PublishedVideoRecord | undefined>;
export type PublishPickSource = "llm" | "rule";

export interface RankedPublishCandidate {
  project: GenerationProject;
  reason: string;
  score: number;
  source: PublishPickSource;
}

export const LOW_GENERATION_INVENTORY_THRESHOLD = 5;

export const publishPickStrategyOptions: { value: PublishPickStrategy; label: string; shortLabel: string }[] = [
  { value: "balanced", label: "智能推荐", shortLabel: "智能" },
  { value: "data", label: "数据优先", shortLabel: "数据" },
  { value: "fresh", label: "新品轮动", shortLabel: "轮动" },
];

const statusText: Record<string, string> = {
  draft: "草稿",
  scripting: "脚本中",
  assets: "素材中",
  video: "待合成",
  composing: "合成中",
  done: "已成片",
};

export function isGenerationProject(item: unknown): item is GenerationProject {
  if (!item || typeof item !== "object") return false;
  const candidate = item as Partial<GenerationProject>;
  return typeof candidate.id === "string" && typeof candidate.name === "string";
}

export function coerceGenerationProjects(data: unknown) {
  return (Array.isArray(data) ? data : []).filter(isGenerationProject);
}

export function coerceRankedPublishCandidates(data: unknown): RankedPublishCandidate[] {
  return (Array.isArray(data) ? data : []).flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const candidate = item as Partial<RankedPublishCandidate>;
    if (!isGenerationProject(candidate.project)) return [];
    return [
      {
        project: candidate.project,
        reason: typeof candidate.reason === "string" ? candidate.reason : "AI择优",
        score: typeof candidate.score === "number" ? candidate.score : 0,
        source: candidate.source === "llm" ? "llm" : "rule",
      },
    ];
  });
}

export function isProjectComplete(project: GenerationProject) {
  return project.status === "done";
}

export function projectTitle(project: GenerationProject) {
  return project.productName?.trim() || project.name.replace(/\s*推广$/, "") || "未命名短片";
}

export function projectCover(project: GenerationProject) {
  const cover = project.productImages?.[0];
  return typeof cover === "string" && cover.length > 0 ? cover : null;
}

export function projectStatusText(status: string | null | undefined) {
  return statusText[status ?? ""] ?? "生成记录";
}

export function projectStatusClass(status: string | null | undefined) {
  if (status === "done") return "bg-emerald-50 text-emerald-700";
  if (status === "composing" || status === "video") return "bg-amber-50 text-amber-700";
  if (status === "assets" || status === "scripting") return "bg-blue-50 text-blue-700";
  return "bg-[#EEF1F4] text-[#5E6875]";
}

export function projectStageHref(project: GenerationProject) {
  if (project.status === "done") return `/project/${project.id}/export`;
  if (project.status === "assets") return `/project/${project.id}/assets`;
  if (project.status === "video" || project.status === "composing") return `/project/${project.id}/video`;
  return `/project/${project.id}/script`;
}

function dateValue(input: string | number | Date | null | undefined) {
  if (!input) return 0;
  if (input instanceof Date) return input.getTime();
  if (typeof input === "number") {
    return input < 10_000_000_000 ? input * 1000 : input;
  }
  const parsed = Date.parse(input);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function projectUpdatedMs(project: GenerationProject) {
  return dateValue(project.updatedAt) || dateValue(project.createdAt);
}

export function formatProjectDate(project: GenerationProject) {
  const value = projectUpdatedMs(project);
  if (!value) return "";
  return new Date(value).toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" });
}

export function sortProjectsByUpdatedDesc(projects: GenerationProject[]) {
  return [...projects].sort((a, b) => projectUpdatedMs(b) - projectUpdatedMs(a));
}

export function isProjectApproved(project: GenerationProject, approved: ApprovalRecords) {
  return isProjectComplete(project) && Boolean(approved[project.id]);
}

export function isProjectPublished(project: GenerationProject, published: PublishedRecords) {
  return Boolean(published[project.id]);
}

export function getApprovedProjects(projects: GenerationProject[], approved: ApprovalRecords) {
  return sortProjectsByUpdatedDesc(projects.filter((project) => isProjectApproved(project, approved)));
}

export function getPublishableProjects(projects: GenerationProject[], approved: ApprovalRecords, published: PublishedRecords = {}) {
  return getApprovedProjects(projects, approved).filter((project) => !isProjectPublished(project, published));
}

export function isLowGenerationInventory(count: number, threshold = LOW_GENERATION_INVENTORY_THRESHOLD) {
  if (!Number.isFinite(count)) return false;
  return Math.max(0, Math.round(count)) < threshold;
}

export function compactCount(count: number) {
  if (!Number.isFinite(count)) return "0";
  const safeCount = Math.max(0, Math.round(count));
  return safeCount > 99 ? "99+" : String(safeCount);
}

export function filterProjects(projects: GenerationProject[], query: string) {
  const keyword = query.trim().toLowerCase();
  if (!keyword) return projects;
  return projects.filter((project) => {
    const haystack = [
      projectTitle(project),
      project.name,
      project.productCategory ?? "",
      project.productDescription ?? "",
      projectStatusText(project.status),
    ]
      .join(" ")
      .toLowerCase();
    return haystack.includes(keyword);
  });
}

function dateKey(date: Date) {
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

function stableHash(input: string) {
  let hash = 0;
  for (let index = 0; index < input.length; index += 1) {
    hash = (hash * 31 + input.charCodeAt(index)) >>> 0;
  }
  return hash;
}

function clampPublishPickCount(count: number, max = 5) {
  if (!Number.isFinite(count)) return 3;
  return Math.min(Math.max(Math.round(count), 1), max);
}

function strategyReason(project: GenerationProject, strategy: PublishPickStrategy) {
  if (strategy === "data") return "优先参考回流数据";
  if (strategy === "fresh") return "今日轮动，避免重复";
  if (project.productDescription?.trim()) return "卖点完整，适合今天发";
  return "综合近期和素材完整度";
}

function recentPublishedCategoryPenalty(project: GenerationProject, projects: GenerationProject[], published: PublishedRecords, today: Date) {
  const category = project.productCategory?.trim();
  if (!category) return 0;
  const categoryById = new Map(projects.map((item) => [item.id, item.productCategory?.trim() ?? ""]));
  return Object.values(published).reduce((penalty, record) => {
    if (!record?.publishedAt || categoryById.get(record.projectId) !== category) return penalty;
    const publishedMs = Date.parse(record.publishedAt);
    if (!Number.isFinite(publishedMs)) return penalty;
    const ageDays = Math.max(0, (today.getTime() - publishedMs) / 86_400_000);
    if (ageDays > 7) return penalty;
    return penalty + Math.max(0, 42 - ageDays * 6);
  }, 0);
}

export function publishScore(
  project: GenerationProject,
  approvedAt: string | undefined,
  today: Date,
  strategy: PublishPickStrategy = "balanced"
) {
  const ageMs = today.getTime() - (dateValue(approvedAt) || projectUpdatedMs(project));
  const ageDays = Math.max(0, ageMs / 86_400_000);
  const recency = Math.max(0, 180 - ageDays * 18);
  const completeness = (projectCover(project) ? 28 : 0) + (project.productDescription?.trim() ? 18 : 0);
  const dailyVariety = stableHash(`${dateKey(today)}:${project.id}`) % 100;
  if (strategy === "data") return recency * 0.7 + completeness * 1.3 + dailyVariety * 0.65;
  if (strategy === "fresh") return recency * 1.2 + completeness * 0.7 + dailyVariety * 1.25;
  return recency + completeness + dailyVariety;
}

export function rankTodayPublishCandidates(
  projects: GenerationProject[],
  approved: ApprovalRecords,
  count: number,
  strategy: PublishPickStrategy = "balanced",
  today = new Date(),
  published: PublishedRecords = {}
): RankedPublishCandidate[] {
  const limit = clampPublishPickCount(count);
  return getPublishableProjects(projects, approved, published)
    .map((project) => ({
      project,
      reason: strategyReason(project, strategy),
      score: publishScore(project, approved[project.id]?.approvedAt, today, strategy) - recentPublishedCategoryPenalty(project, projects, published, today),
      source: "rule" as const,
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

export function selectTodayPublishCandidates(
  projects: GenerationProject[],
  approved: ApprovalRecords,
  count: number,
  strategy: PublishPickStrategy = "balanced",
  today = new Date(),
  published: PublishedRecords = {}
) {
  return rankTodayPublishCandidates(projects, approved, count, strategy, today, published).map((item) => item.project);
}
