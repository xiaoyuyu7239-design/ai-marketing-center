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

/** 被运营驳回的内容（连同原因），商家端据此提示"为什么这条不见了" */
export interface RejectedVideoRecord {
  projectId: string;
  reviewNote: string | null;
}

export type PublishPickStrategy = "balanced" | "data" | "fresh";

interface VideoApprovalState {
  approved: Record<string, ApprovedVideoRecord>;
  published: Record<string, PublishedVideoRecord>;
  /** 被运营驳回的内容（含原因），商家端展示"这条为什么被下架" */
  rejected: Record<string, RejectedVideoRecord>;
  /** 服务端待发布库是否已拉取成功（未登录/拉取失败时为 false） */
  hydrated: boolean;
  /** 最近一次服务端交互是否因未登录被拒（页面据此提示"请先登录"，而不是静默显示空库存） */
  authRequired: boolean;
  /** 最近一次同步的错误提示（如驳回守卫 403 文案），页面读后应清空 */
  lastSyncError: string | null;
  dailyPickCount: number;
  publishPickStrategy: PublishPickStrategy;
  hydrateFromServer: () => Promise<void>;
  clearSyncError: () => void;
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

/** 旧版（纯 localStorage 时代）记录的迁移备份键：迁移成功前旧数据一直留在这里，防止升级用户库存清零 */
const MIGRATION_BACKUP_KEY = "clipforge-approved-videos:migration-backup";

interface LegacySnapshot {
  approved: Record<string, ApprovedVideoRecord>;
  published: Record<string, PublishedVideoRecord>;
}

function readMigrationBackup(): LegacySnapshot | null {
  try {
    const raw = window.localStorage?.getItem(MIGRATION_BACKUP_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as LegacySnapshot;
    if (!parsed || typeof parsed !== "object") return null;
    return { approved: parsed.approved ?? {}, published: parsed.published ?? {} };
  } catch {
    return null;
  }
}

function writeMigrationBackup(snapshot: LegacySnapshot | null) {
  try {
    if (!snapshot) window.localStorage?.removeItem(MIGRATION_BACKUP_KEY);
    else window.localStorage?.setItem(MIGRATION_BACKUP_KEY, JSON.stringify(snapshot));
  } catch {
    // 存储不可用时放弃备份（此时也不存在"旧 localStorage 数据"一说）
  }
}

interface RecordAction {
  projectId: string;
  action: "approve" | "unapprove" | "publish" | "unpublish";
  platform?: string;
  approvedAt?: string;
  publishedAt?: string;
}

/** 服务端同步；返回是否成功（HTTP 非 2xx 也算失败，401 置 authRequired，其它错误文案存 lastSyncError 供页面提示） */
async function postRecord(input: RecordAction): Promise<boolean> {
  try {
    const res = await fetch("/api/publish-records", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    if (res.status === 401) {
      useVideoApprovalStore.setState({ authRequired: true });
      return false;
    }
    if (!res.ok) {
      // 把服务端错误文案（如驳回守卫 403"该内容已被平台审核驳回…"）透传给页面，而不是静默回滚
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (typeof data.error === "string" && data.error) {
        useVideoApprovalStore.setState({ lastSyncError: data.error });
      }
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

// 同一项目的操作按顺序串行提交：快速 approve→unapprove 两个请求走不同连接可能乱序到达，
// 服务端会停在与用户最终操作相反的状态。队列保证同项目请求先后有序。
const projectQueues = new Map<string, Promise<void>>();
// 本地乐观修改的代数计数：hydrate 的 GET 在途期间若有新的本地操作，放弃这次快照，避免旧数据盖掉新操作
let mutationEpoch = 0;

function enqueueSync(input: RecordAction) {
  mutationEpoch += 1;
  const prev = projectQueues.get(input.projectId) ?? Promise.resolve();
  const next = prev.then(async () => {
    const ok = await postRecord(input);
    if (!ok) {
      console.warn(`待发布库同步失败（${input.action} ${input.projectId}），将以服务端状态为准`);
      // 同步失败时拉一次服务端真相纠偏本地乐观状态，避免"toast 说成功、刷新后全丢"的错觉
      void useVideoApprovalStore.getState().hydrateFromServer();
    }
  });
  projectQueues.set(input.projectId, next);
}

// 认可入库/已发布状态存服务端（换设备不丢、运营后台可读）；
// localStorage 只保留 dailyPickCount / publishPickStrategy 两个纯 UI 偏好。
export const useVideoApprovalStore = create<VideoApprovalState>()(
  persist(
    (set, get) => ({
      approved: {},
      published: {},
      rejected: {},
      hydrated: false,
      authRequired: false,
      lastSyncError: null,
      dailyPickCount: 3,
      publishPickStrategy: "balanced",
      clearSyncError: () => set({ lastSyncError: null }),
      hydrateFromServer: async () => {
        // 旧版 localStorage 数据在首次 set() 时就会被 persist 的 partialize 覆写掉，
        // 所以进入任何写路径前，先把内存里 rehydrate 出来的旧记录备份到独立键。
        const inMemory = get();
        const legacyInMemory = Object.keys(inMemory.approved).length > 0 && !inMemory.hydrated;
        if (legacyInMemory && !readMigrationBackup()) {
          writeMigrationBackup({ approved: inMemory.approved, published: inMemory.published });
        }

        const epochAtFetch = mutationEpoch;
        let records: { projectId: string; approvedAt: string | null; publishedAt: string | null; platform: string | null; reviewStatus?: string; reviewNote?: string | null }[];
        try {
          const res = await fetch("/api/publish-records", { cache: "no-store" });
          if (res.status === 401) {
            set({ authRequired: true });
            return;
          }
          if (!res.ok) return;
          const data = (await res.json().catch(() => ({}))) as { records?: typeof records };
          records = data.records ?? [];
        } catch (error) {
          console.warn("拉取待发布库失败:", error);
          return;
        }

        // 一次性迁移：服务端空库且备份键里有旧本地记录 → 逐条推上服务端，确认服务端真的收到后才清备份。
        // （项目已被删除的旧记录会 404，属于无处可挂的死数据，不因它们保留备份）
        const backup = readMigrationBackup();
        if (records.length === 0 && backup && Object.keys(backup.approved).length > 0) {
          for (const record of Object.values(backup.approved)) {
            await postRecord({ projectId: record.projectId, action: "approve", approvedAt: record.approvedAt });
          }
          for (const record of Object.values(backup.published)) {
            await postRecord({ projectId: record.projectId, action: "publish", platform: record.platform, publishedAt: record.publishedAt });
          }
          // 重新取服务端真相；服务端拿到了数据才算迁移完成
          try {
            const res = await fetch("/api/publish-records", { cache: "no-store" });
            const data = (await res.json().catch(() => ({}))) as { records?: typeof records };
            records = res.ok ? data.records ?? [] : [];
          } catch {
            records = [];
          }
          if (records.length > 0) writeMigrationBackup(null);
          else return; // 服务端还是空（离线/全部失败）：保留备份下次重试，且不能用空快照盖掉内存里的旧记录
        } else if (records.length > 0 && backup) {
          // 服务端已有数据说明迁移早已完成，备份可以清了
          writeMigrationBackup(null);
        }

        // GET 在途期间用户又点了新操作：放弃本次快照，等队列同步完由失败回调或下次 hydrate 对齐
        if (epochAtFetch !== mutationEpoch) return;

        const approved: Record<string, ApprovedVideoRecord> = {};
        const published: Record<string, PublishedVideoRecord> = {};
        const rejected: Record<string, RejectedVideoRecord> = {};
        for (const record of records) {
          // rejected 的记录既不进 approved 也不进 published（口径统一），单独进 rejected 供商家看到"为什么被下架"
          if (record.reviewStatus === "rejected") {
            rejected[record.projectId] = { projectId: record.projectId, reviewNote: record.reviewNote ?? null };
            continue;
          }
          if (record.approvedAt) {
            approved[record.projectId] = { projectId: record.projectId, approvedAt: record.approvedAt };
          }
          if (record.publishedAt) {
            published[record.projectId] = {
              projectId: record.projectId,
              publishedAt: record.publishedAt,
              platform: record.platform ?? undefined,
            };
          }
        }
        set({ approved, published, rejected, hydrated: true, authRequired: false });

        // 每天发几条以服务端为准（设置页/别的设备可能改过），水合成功后拉一次对齐；失败静默沿用本地持久化的值
        try {
          const res = await fetch("/api/reminders/settings", { cache: "no-store" });
          if (res.ok) {
            const data = (await res.json().catch(() => ({}))) as { dailyTarget?: number };
            if (typeof data.dailyTarget === "number") {
              set({ dailyPickCount: clampDailyPickCount(data.dailyTarget) });
            }
          }
        } catch {
          // 拿不到服务端条数时继续用本地值，不打扰用户
        }
      },
      approveProject: (projectId) => {
        set((state) => ({
          approved: {
            ...state.approved,
            [projectId]: {
              projectId,
              approvedAt: state.approved[projectId]?.approvedAt ?? new Date().toISOString(),
            },
          },
        }));
        enqueueSync({ projectId, action: "approve" });
      },
      unapproveProject: (projectId) => {
        set((state) => {
          const approved = { ...state.approved };
          const published = { ...state.published };
          delete approved[projectId];
          delete published[projectId]; // 服务端 unapprove 会整条删除，本地保持一致
          return { approved, published };
        });
        enqueueSync({ projectId, action: "unapprove" });
      },
      markPublishedProject: (projectId, platform) => {
        set((state) => ({
          published: {
            ...state.published,
            [projectId]: {
              projectId,
              publishedAt: state.published[projectId]?.publishedAt ?? new Date().toISOString(),
              platform,
            },
          },
        }));
        enqueueSync({ projectId, action: "publish", platform });
      },
      unmarkPublishedProject: (projectId) => {
        set((state) => {
          const next = { ...state.published };
          delete next[projectId];
          return { published: next };
        });
        enqueueSync({ projectId, action: "unpublish" });
      },
      setDailyPickCount: (count) => {
        const clamped = clampDailyPickCount(count);
        set({ dailyPickCount: clamped });
        // 服务端 merchants.dailyPublishTarget 与本地挑选条数是同一口径（微信到点提醒按它算"今天还差几条"），
        // 改哪边都要跟上；fire-and-forget 失败静默不阻塞 UI，下次 hydrate 会再用服务端值对齐
        void fetch("/api/reminders/settings", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ dailyTarget: clamped }),
        }).catch(() => undefined);
      },
      setPublishPickStrategy: (strategy) => set({ publishPickStrategy: strategy }),
    }),
    {
      name: "clipforge-approved-videos",
      // 只持久化 UI 偏好；approved/published 以服务端为准，避免旧本地缓存与服务端打架
      partialize: (state) => ({
        dailyPickCount: state.dailyPickCount,
        publishPickStrategy: state.publishPickStrategy,
      }),
    }
  )
);
