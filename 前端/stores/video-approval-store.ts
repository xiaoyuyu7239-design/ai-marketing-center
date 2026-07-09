import { create } from "zustand";
import { persist } from "zustand/middleware";

export interface ApprovedVideoRecord {
  projectId: string;
  approvedAt: string;
}

export interface PublishedVideoRecord {
  projectId: string;
  publishedAt: string;
  platform?: string;
}

export type PublishPickStrategy = "balanced" | "data" | "fresh";

interface VideoApprovalState {
  approved: Record<string, ApprovedVideoRecord>;
  published: Record<string, PublishedVideoRecord>;
  dailyPickCount: number;
  publishPickStrategy: PublishPickStrategy;
  approveProject: (projectId: string) => void;
  unapproveProject: (projectId: string) => void;
  markPublishedProject: (projectId: string, platform?: string) => void;
  unmarkPublishedProject: (projectId: string) => void;
  setDailyPickCount: (count: number) => void;
  setPublishPickStrategy: (strategy: PublishPickStrategy) => void;
}

function clampDailyPickCount(count: number) {
  if (!Number.isFinite(count)) return 3;
  return Math.min(Math.max(Math.round(count), 1), 5);
}

export const useVideoApprovalStore = create<VideoApprovalState>()(
  persist(
    (set) => ({
      approved: {},
      published: {},
      dailyPickCount: 3,
      publishPickStrategy: "balanced",
      approveProject: (projectId) =>
        set((state) => ({
          approved: {
            ...state.approved,
            [projectId]: {
              projectId,
              approvedAt: state.approved[projectId]?.approvedAt ?? new Date().toISOString(),
            },
          },
        })),
      unapproveProject: (projectId) =>
        set((state) => {
          const next = { ...state.approved };
          delete next[projectId];
          return { approved: next };
        }),
      markPublishedProject: (projectId, platform) =>
        set((state) => ({
          published: {
            ...state.published,
            [projectId]: {
              projectId,
              publishedAt: state.published[projectId]?.publishedAt ?? new Date().toISOString(),
              platform,
            },
          },
        })),
      unmarkPublishedProject: (projectId) =>
        set((state) => {
          const next = { ...state.published };
          delete next[projectId];
          return { published: next };
        }),
      setDailyPickCount: (count) => set({ dailyPickCount: clampDailyPickCount(count) }),
      setPublishPickStrategy: (strategy) => set({ publishPickStrategy: strategy }),
    }),
    {
      name: "clipforge-approved-videos",
    }
  )
);
