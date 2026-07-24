"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import {
  LuArrowLeft,
  LuArrowRight,
  LuCircleAlert,
  LuClapperboard,
  LuLoaderCircle,
  LuPlay,
  LuRefreshCw,
} from "react-icons/lu";
import { Card, CardContent } from "@frontend/components/ui/card";
import { Button } from "@frontend/components/ui/button";
import { Badge } from "@frontend/components/ui/badge";
import { buildImageOptions, buildVideoOptions } from "@backend/shared/gen-params";
import type { Shot } from "@backend/db/schema";
import { buildAssetRows, type AssetItem } from "@backend/core/stock/assets-view";
import { useT } from "@frontend/i18n";
import { LanguageToggle } from "@frontend/components/language-toggle";
import { BrandWheatMark } from "@frontend/components/brand-wheat-logo";
import { SHOT_TYPE_INFO } from "@backend/shared/shot-constants";
import { StepProgressIndicator } from "@frontend/components/step-progress";
import { newGenerationOperationId } from "@frontend/lib/generation-operation";
import {
  hasFacelessRetryMarker,
  isCurrentProviderSafetyFailure,
  regenerateFacelessAsset,
  shouldFallbackAfterProviderSafetyRetry,
} from "@frontend/lib/motion-faceless-regeneration";

type MotionPolicy = "ai_video" | "static_pan" | "regenerate_faceless" | "use_existing_video";
type MotionEligibilityState = "eligible" | "fallback" | "regenerate_required" | "manual_review";
type MotionJobStatus =
  | "pending"
  | "submitting"
  | "submitted"
  | "polling"
  | "downloading"
  | "saving"
  | "succeeded"
  | "failed"
  | "submission_uncertain";

interface MotionJobError {
  code?: string;
  category?: string;
  message?: string;
  userMessage?: string;
  retryable?: boolean;
  retryAfterSeconds?: number;
  suggestedAction?: string;
  requestId?: string;
}

interface MotionVideoJob {
  id: string;
  shotId: number;
  sourceAssetId?: string | null;
  status: MotionJobStatus;
  stage?: string;
  progress?: number | null;
  outputUrl?: string | null;
  sourceImageHash?: string;
  error?: MotionJobError | null;
  createdAt?: string;
  updatedAt?: string;
}

interface MotionAssessment {
  assetId: string | null;
  imageRef: string;
  imageHash: string;
  policy: MotionPolicy;
  state: MotionEligibilityState;
  reason: string;
  binding?: {
    assetId?: string | null;
    imageRef?: string;
    imageHash?: string;
    width?: number | null;
    height?: number | null;
  } | null;
  faceAssessment?: {
    status?: string;
    confidence?: number | null;
    faceCount?: number | null;
    source?: string;
  } | null;
  // 兼容服务端的扁平 DTO，以免发布过程中新旧节点短暂不一致。
  faceStatus?: string;
  faceConfidence?: number | null;
  faceCount?: number | null;
}

interface MotionShotState {
  shotId: number;
  assessment: MotionAssessment | null;
  latestJob: MotionVideoJob | null;
  existingVideoUrl?: string | null;
  existingVideoClipId?: string | null;
}

interface MotionSnapshot {
  shots: MotionShotState[];
  summary?: Record<string, unknown>;
}

interface UiRequestError {
  code: string;
  category: string;
  message: string;
  retryAfterSeconds?: number;
}

const ACTIVE_JOB_STATUSES = new Set<MotionJobStatus>([
  "pending",
  "submitting",
  "submitted",
  "polling",
  "downloading",
  "saving",
]);

function isActiveJob(job: MotionVideoJob | null | undefined): boolean {
  return Boolean(job && ACTIVE_JOB_STATUSES.has(job.status));
}

function normalizeMotionShotState(value: unknown): MotionShotState | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (typeof row.shotId !== "number") return null;
  const nestedAssessment = row.assessment && typeof row.assessment === "object"
    ? row.assessment as MotionAssessment
    : null;
  const decision = row.decision && typeof row.decision === "object"
    ? row.decision as Pick<MotionAssessment, "policy" | "state" | "reason" | "binding">
    : null;
  // 新后端将素材检查字段平铺在 shot 上、判定放在 decision；同时兼容旧节点的 assessment 嵌套形式。
  const assessment = nestedAssessment ?? (decision ? {
    assetId: typeof row.assetId === "string" ? row.assetId : null,
    imageRef: typeof row.imageRef === "string" ? row.imageRef : "",
    imageHash: typeof row.imageHash === "string" ? row.imageHash : "",
    policy: decision.policy,
    state: decision.state,
    reason: decision.reason,
    binding: decision.binding,
    faceAssessment: row.faceAssessment && typeof row.faceAssessment === "object"
      ? row.faceAssessment as MotionAssessment["faceAssessment"]
      : null,
  } : null);
  return {
    shotId: row.shotId,
    assessment,
    latestJob: row.latestJob && typeof row.latestJob === "object"
      ? row.latestJob as MotionVideoJob
      : null,
    existingVideoUrl: typeof row.existingVideoUrl === "string" ? row.existingVideoUrl : null,
    existingVideoClipId: typeof row.existingVideoClipId === "string" ? row.existingVideoClipId : null,
  };
}

function normalizeMotionSnapshot(value: unknown): MotionSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const response = value as { shots?: unknown; summary?: unknown };
  if (!Array.isArray(response.shots)) return null;
  const shots = response.shots.map(normalizeMotionShotState).filter((shot): shot is MotionShotState => Boolean(shot));
  return {
    shots,
    summary: response.summary && typeof response.summary === "object"
      ? response.summary as Record<string, unknown>
      : undefined,
  };
}

function normalizeRequestError(response: Response, body: unknown): UiRequestError {
  const record = body && typeof body === "object" ? body as Record<string, unknown> : {};
  const rawError = record.error;
  const detail = rawError && typeof rawError === "object"
    ? rawError as Record<string, unknown>
    : record.details && typeof record.details === "object"
      ? record.details as Record<string, unknown>
      : record;
  const retryAfterHeader = Number(response.headers.get("Retry-After"));
  const retryAfterBody = Number(detail.retryAfterSeconds);
  return {
    code: typeof detail.code === "string" ? detail.code : `HTTP_${response.status}`,
    category: typeof detail.category === "string" ? detail.category : "request",
    message:
      typeof detail.userMessage === "string" ? detail.userMessage
        : typeof detail.message === "string" ? detail.message
          : typeof rawError === "string" ? rawError
            : `HTTP ${response.status}`,
    retryAfterSeconds: Number.isFinite(retryAfterBody)
      ? retryAfterBody
      : Number.isFinite(retryAfterHeader) ? retryAfterHeader : undefined,
  };
}

function motionPromptFor(asset: AssetItem): string {
  const cameraMove = asset.camera || "";
  const description = asset.description || "";
  const hasHuman = /女生|男生|模特|人物|真人|手|指|握|拿|捧|背影|走|转身|抬|靠|坐|站|脸|发丝|头发|涂|抹|试穿/.test(description);
  const scaleLock =
    "【最高优先级】商品在画面中的大小、位置、比例，从第一帧到最后一帧必须完全不变——绝对禁止把商品放大、缩小、拉伸或移动位置；商品是固定尺寸的真实物体。";
  if (hasHuman) {
    return `${description}。${cameraMove ? `${cameraMove}。` : ""}${scaleLock}人物只做一个自然、清晰、单向的动作，不要来回重复。人物五官、身材、服装与商品外观保持不变，画面稳定流畅不抖动，只用一种镜头运动。`;
  }
  return `这是一张静物商品照片，让它像“活的照片”一样极其轻微地动起来：只让光影在商品表面缓慢流动、背景虚化处有柔和光斑呼吸、可有极轻微的镜头平移视差；商品本身保持完全静止。禁止推近、拉远、缩放、变焦。${scaleLock}画面稳定流畅不抖动，商品颜色、质感、外观保持不变。`;
}

function mergeSubmissionResponse(
  previous: MotionSnapshot | null,
  value: unknown,
): MotionSnapshot | null {
  if (!value || typeof value !== "object") return previous;
  const response = value as { shots?: unknown; jobs?: unknown; summary?: unknown };
  if (Array.isArray(response.shots)) {
    const shots = response.shots.map(normalizeMotionShotState).filter((shot): shot is MotionShotState => Boolean(shot));
    return {
      shots,
      summary: response.summary && typeof response.summary === "object"
        ? response.summary as Record<string, unknown>
        : previous?.summary,
    };
  }
  if (!Array.isArray(response.jobs)) return previous;
  const jobs = response.jobs as MotionVideoJob[];
  const current = new Map((previous?.shots ?? []).map((shot) => [shot.shotId, shot]));
  const updatedShots = new Set<number>();
  for (const job of jobs) {
    const old = current.get(job.shotId);
    // jobs 已由服务端按真实插入顺序倒排；每个 shot 只接受第一个与当前 asset/hash 精确匹配的任务。
    if (!old || updatedShots.has(job.shotId)) continue;
    if (old.assessment?.assetId && job.sourceAssetId !== old.assessment.assetId) continue;
    if (old.assessment?.imageHash && job.sourceImageHash !== old.assessment.imageHash) continue;
    current.set(job.shotId, {
      shotId: job.shotId,
      assessment: old?.assessment ?? null,
      latestJob: job,
      existingVideoUrl: old?.existingVideoUrl,
      existingVideoClipId: old?.existingVideoClipId,
    });
    updatedShots.add(job.shotId);
  }
  return { shots: [...current.values()], summary: previous?.summary };
}

/**
 * 「动态」页只负责提交持久化任务和展示进度。任务离开页面后仍在服务端继续，
 * 页面刷新时通过 GET motion-jobs 恢复，不再由浏览器持有数分钟的供应商长请求。
 */
export default function MotionPage() {
  const t = useT("assets");
  const tc = useT("common");
  const tRef = useRef(t);
  tRef.current = t;
  const { id } = useParams<{ id: string }>();
  const workflowStepHrefs = [
    `/project/${id}/script`,
    `/project/${id}/assets`,
    `/project/${id}/motion`,
    `/project/${id}/video`,
    `/project/${id}/export`,
  ];

  const [assets, setAssets] = useState<AssetItem[]>([]);
  const [projectName, setProjectName] = useState("");
  const [imageAgentReady, setImageAgentReady] = useState(false);
  const [videoAgentReady, setVideoAgentReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [motionSnapshot, setMotionSnapshot] = useState<MotionSnapshot | null>(null);
  const [motionLoading, setMotionLoading] = useState(true);
  const [motionLoadError, setMotionLoadError] = useState<string | null>(null);
  const [submissionError, setSubmissionError] = useState<UiRequestError | null>(null);
  const [submittingShots, setSubmittingShots] = useState<Set<number>>(new Set());
  const submittingShotsRef = useRef<Set<number>>(new Set());
  const [regeneratingShots, setRegeneratingShots] = useState<Set<number>>(new Set());
  const regeneratingShotsRef = useRef<Set<number>>(new Set());
  // 仅当前页面内用户亲自提交的任务，才授权供应商安全拒绝后自动重生一次。
  // 刷新页面后只展示明确按钮，不会因访问页面突然产生付费请求。
  const autoSafetyRecoveryShotsRef = useRef<Set<number>>(new Set());
  const autoSafetyRecoveryRunningRef = useRef(false);
  const [batchPreparing, setBatchPreparing] = useState(false);
  const [retryBlockedUntil, setRetryBlockedUntil] = useState<number | null>(null);
  const [pollDelayMs, setPollDelayMs] = useState(3_000);
  const motionRequestVersion = useRef(0);

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
        const productImages: string[] = project && Array.isArray(project.productImages) ? project.productImages : [];
        if (project) setProjectName(project.name ?? project.productName ?? "");
        const selected = Array.isArray(scripts)
          ? scripts.find((script: { selected?: boolean }) => script.selected) ?? scripts[0]
          : null;
        if (!selected || !Array.isArray(selected.shots) || selected.shots.length === 0) {
          setAssets([]);
          setLoadError(tRef.current("errorNoScript"));
          return;
        }
        setAssets(buildAssetRows(selected.shots as Shot[], Array.isArray(savedAssets) ? savedAssets : [], productImages));
      } catch (error) {
        if (!cancelled) setLoadError(error instanceof Error ? error.message : tRef.current("errorLoadFailed"));
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
        const response = await fetch("/api/ai/status", { cache: "no-store" });
        if (!response.ok) return;
        const data = await response.json();
        if (!cancelled) {
          setImageAgentReady(Boolean(data.imageReady));
          setVideoAgentReady(Boolean(data.videoReady));
        }
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

  const refreshMotionJobs = useCallback(async (initial = false, jobsOnly = false) => {
    const requestVersion = ++motionRequestVersion.current;
    if (initial) setMotionLoading(true);
    try {
      const response = await fetch(
        `/api/project/${id}/motion-jobs${jobsOnly ? "?view=jobs" : ""}`,
        { cache: "no-store" },
      );
      const data: unknown = await response.json().catch(() => ({}));
      if (requestVersion !== motionRequestVersion.current) return null;
      if (!response.ok) throw normalizeRequestError(response, data);
      const retryAfter = Number(response.headers.get("Retry-After"));
      if (Number.isFinite(retryAfter) && retryAfter > 0) setPollDelayMs(Math.max(1_000, retryAfter * 1_000));
      if (jobsOnly) {
        const record = data && typeof data === "object" ? data as { jobs?: unknown } : {};
        if (!Array.isArray(record.jobs)) {
          throw { code: "INVALID_RESPONSE", category: "request", message: tRef.current("motionInvalidResponse") } satisfies UiRequestError;
        }
        setMotionSnapshot((previous) => mergeSubmissionResponse(previous, data));
        setMotionLoadError(null);
        return null;
      }
      const normalized = normalizeMotionSnapshot(data);
      if (!normalized) {
        throw { code: "INVALID_RESPONSE", category: "request", message: tRef.current("motionInvalidResponse") } satisfies UiRequestError;
      }
      setMotionSnapshot(normalized);
      setMotionLoadError(null);
      return normalized;
    } catch (error) {
      if (requestVersion !== motionRequestVersion.current) return;
      const message = error && typeof error === "object" && "message" in error
        ? String((error as { message: unknown }).message)
        : tRef.current("errorLoadFailed");
      setMotionLoadError(message);
      return null;
    } finally {
      if (requestVersion === motionRequestVersion.current && initial) setMotionLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void refreshMotionJobs(true);
    return () => {
      motionRequestVersion.current += 1;
    };
  }, [refreshMotionJobs]);

  const shotStates = useMemo(
    () => new Map((motionSnapshot?.shots ?? []).map((shot) => [shot.shotId, shot])),
    [motionSnapshot],
  );
  const activeJobShotIds = useMemo(
    () => (motionSnapshot?.shots ?? []).filter((shot) => isActiveJob(shot.latestJob)).map((shot) => shot.shotId),
    [motionSnapshot],
  );
  const backgroundShotCount = new Set([...activeJobShotIds, ...submittingShots]).size;
  const activeJobCount = activeJobShotIds.length;
  const hasBackgroundWork = backgroundShotCount > 0;

  useEffect(() => {
    if (!hasBackgroundWork) return;
    let cancelled = false;
    let timer: number | undefined;
    const poll = async () => {
      await refreshMotionJobs(false, true);
      if (!cancelled) timer = window.setTimeout(poll, pollDelayMs);
    };
    timer = window.setTimeout(poll, pollDelayMs);
    return () => {
      cancelled = true;
      if (timer != null) window.clearTimeout(timer);
    };
  }, [hasBackgroundWork, pollDelayMs, refreshMotionJobs]);

  useEffect(() => {
    if (!retryBlockedUntil) return;
    const remaining = retryBlockedUntil - Date.now();
    if (remaining <= 0) {
      setRetryBlockedUntil(null);
      return;
    }
    const timer = window.setTimeout(() => setRetryBlockedUntil(null), remaining);
    return () => window.clearTimeout(timer);
  }, [retryBlockedUntil]);

  const retryCooldownActive = retryBlockedUntil != null && retryBlockedUntil > Date.now();

  const nextShotIdFor = useCallback((shotId: number) => {
    const index = assets.findIndex((asset) => asset.shotId === shotId);
    return index >= 0 ? assets[index + 1]?.shotId : undefined;
  }, [assets]);

  const submitMotionJobs = useCallback(async (shotIds: number[], operationId: string) => {
    if (
      shotIds.length === 0
      || (retryBlockedUntil != null && retryBlockedUntil > Date.now())
      || shotIds.some((shotId) => submittingShotsRef.current.has(shotId))
    ) return;
    setSubmissionError(null);
    for (const shotId of shotIds) submittingShotsRef.current.add(shotId);
    setSubmittingShots(new Set(submittingShotsRef.current));
    try {
      const items = shotIds.map((shotId) => {
        const asset = assets.find((row) => row.shotId === shotId);
        const lastFrameShotId = nextShotIdFor(shotId);
        return {
          shotId,
          prompt: asset ? motionPromptFor(asset) : undefined,
          ...(lastFrameShotId != null ? { lastFrameShotId } : {}),
          options: buildVideoOptions(undefined),
        };
      });
      const response = await fetch(`/api/project/${id}/motion-jobs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ operationId, shotIds, items }),
      });
      const data: unknown = await response.json().catch(() => ({}));
      if (!response.ok) throw normalizeRequestError(response, data);
      for (const shotId of shotIds) autoSafetyRecoveryShotsRef.current.add(shotId);
      const retryAfter = Number(response.headers.get("Retry-After"));
      if (Number.isFinite(retryAfter) && retryAfter > 0) setPollDelayMs(Math.max(1_000, retryAfter * 1_000));
      setMotionSnapshot((previous) => mergeSubmissionResponse(previous, data));
      void refreshMotionJobs(false);
    } catch (error) {
      const normalized = error && typeof error === "object" && "code" in error
        ? error as UiRequestError
        : {
            code: "REQUEST_FAILED",
            category: "request",
            message: error instanceof Error ? error.message : tRef.current("errorImageToVideoFailed"),
          };
      setSubmissionError(normalized);
      if (normalized.retryAfterSeconds && normalized.retryAfterSeconds > 0) {
        setRetryBlockedUntil(Date.now() + normalized.retryAfterSeconds * 1_000);
      }
    } finally {
      for (const shotId of shotIds) submittingShotsRef.current.delete(shotId);
      setSubmittingShots(new Set(submittingShotsRef.current));
    }
  }, [assets, id, nextShotIdFor, refreshMotionJobs, retryBlockedUntil]);

  const canSubmitShot = useCallback((asset: AssetItem) => {
    const state = shotStates.get(asset.shotId);
    const assessment = state?.assessment;
    const job = state?.latestJob;
    if (!assessment || assessment.policy !== "ai_video" || assessment.state !== "eligible") return false;
    if (submittingShots.has(asset.shotId) || isActiveJob(job)) return false;
    const jobMatchesCurrentImage = !job?.sourceImageHash
      || !assessment.imageHash
      || job.sourceImageHash === assessment.imageHash;
    if ((job?.status === "succeeded" && jobMatchesCurrentImage) || job?.status === "submission_uncertain") return false;
    if (job?.status === "failed" && job.error?.retryable === false && jobMatchesCurrentImage) return false;
    return true;
  }, [shotStates, submittingShots]);

  const batchShotIds = useMemo(
    () => assets.filter(canSubmitShot).map((asset) => asset.shotId),
    [assets, canSubmitShot],
  );

  const facelessRegenerationAssets = useMemo(
    () => assets.filter((asset) => {
      const state = shotStates.get(asset.shotId);
      return (state?.assessment?.policy === "regenerate_faceless" || isCurrentProviderSafetyFailure(asset, state))
        && !hasFacelessRetryMarker(asset)
        && !regeneratingShots.has(asset.shotId);
    }),
    [assets, regeneratingShots, shotStates],
  );

  const regenerateOne = useCallback(async (asset: AssetItem): Promise<boolean> => {
    if (
      !imageAgentReady
      || hasFacelessRetryMarker(asset)
      || regeneratingShotsRef.current.has(asset.shotId)
    ) return false;
    regeneratingShotsRef.current.add(asset.shotId);
    setRegeneratingShots(new Set(regeneratingShotsRef.current));
    setSubmissionError(null);
    try {
      const saved = await regenerateFacelessAsset({
        projectId: id,
        asset,
        imageOptions: buildImageOptions(undefined),
      });
      setAssets((previous) => previous.map((row) => row.shotId === asset.shotId ? {
        ...row,
        status: "done",
        thumbnailUrl: saved.filePath,
        assetFileUrl: saved.filePath,
        assetId: saved.id,
        assetType: saved.type,
        assetPrompt: saved.prompt,
        error: undefined,
      } : row));
      return true;
    } catch (error) {
      setSubmissionError({
        code: "FACELESS_REGENERATION_FAILED",
        category: "safety_regeneration",
        message: error instanceof Error ? error.message : tRef.current("motionSafeRegenerationFailed"),
      });
      return false;
    } finally {
      regeneratingShotsRef.current.delete(asset.shotId);
      setRegeneratingShots(new Set(regeneratingShotsRef.current));
    }
  }, [id, imageAgentReady]);

  const refreshAfterFacelessRegeneration = useCallback(async (): Promise<MotionSnapshot> => {
    const response = await fetch(`/api/project/${id}/motion-jobs`, { cache: "no-store" });
    const data: unknown = await response.json().catch(() => ({}));
    if (!response.ok) throw normalizeRequestError(response, data);
    const normalized = normalizeMotionSnapshot(data);
    if (!normalized) throw new Error(tRef.current("motionInvalidResponse"));
    setMotionSnapshot(normalized);
    setMotionLoadError(null);
    return normalized;
  }, [id]);

  const regenerateAndSubmitOne = useCallback(async (asset: AssetItem) => {
    if (!videoAgentReady || !await regenerateOne(asset)) return;
    try {
      const snapshot = await refreshAfterFacelessRegeneration();
      const updated = snapshot?.shots.find((shot) => shot.shotId === asset.shotId);
      if (
        updated?.assessment?.policy === "ai_video"
        && updated.assessment.state === "eligible"
        && !isActiveJob(updated.latestJob)
      ) {
        await submitMotionJobs([asset.shotId], newGenerationOperationId("video-single"));
      }
    } catch (error) {
      setSubmissionError({
        code: "MOTION_REASSESS_FAILED",
        category: "request",
        message: error instanceof Error ? error.message : tRef.current("motionSafeRegenerationFailed"),
      });
    }
  }, [refreshAfterFacelessRegeneration, regenerateOne, submitMotionJobs, videoAgentReady]);

  useEffect(() => {
    if (!imageAgentReady || !videoAgentReady || autoSafetyRecoveryRunningRef.current) return;
    const queue = assets.filter((asset) =>
      autoSafetyRecoveryShotsRef.current.has(asset.shotId)
      && !hasFacelessRetryMarker(asset)
      && isCurrentProviderSafetyFailure(asset, shotStates.get(asset.shotId))
      && !regeneratingShotsRef.current.has(asset.shotId)
    );
    if (queue.length === 0) return;
    autoSafetyRecoveryRunningRef.current = true;
    void (async () => {
      const pending = [...queue];
      const worker = async () => {
        for (let asset = pending.shift(); asset; asset = pending.shift()) {
          // 请求前先消耗会话授权，即使请求失败也不会在 effect 里无限自动扣费。
          autoSafetyRecoveryShotsRef.current.delete(asset.shotId);
          await regenerateAndSubmitOne(asset);
        }
      };
      await Promise.all(Array.from({ length: Math.min(2, pending.length) }, () => worker()));
    })().finally(() => {
      autoSafetyRecoveryRunningRef.current = false;
    });
  }, [assets, imageAgentReady, motionSnapshot, regenerateAndSubmitOne, shotStates, videoAgentReady]);

  const animateAll = useCallback(async () => {
    if (!videoAgentReady || batchPreparing) return;
    const regenerationQueue = imageAgentReady ? [...facelessRegenerationAssets] : [];
    if (batchShotIds.length === 0 && regenerationQueue.length === 0) return;
    setBatchPreparing(true);
    try {
      // 已通过安全检查的镜头先入持久队列，不必等待无脸重生，缩短整批总时长。
      if (batchShotIds.length > 0) {
        await submitMotionJobs(batchShotIds, newGenerationOperationId("video-batch"));
      }
      const regenerated: number[] = [];
      const queue = [...regenerationQueue];
      const worker = async () => {
        for (let asset = queue.shift(); asset; asset = queue.shift()) {
          if (await regenerateOne(asset)) regenerated.push(asset.shotId);
        }
      };
      await Promise.all(Array.from({ length: Math.min(2, queue.length) }, () => worker()));
      if (regenerated.length === 0) return;
      const snapshot = await refreshAfterFacelessRegeneration();
      const regeneratedSet = new Set(regenerated);
      const newlyEligible = snapshot.shots.filter((shot) =>
        regeneratedSet.has(shot.shotId)
        && shot.assessment?.policy === "ai_video"
        && shot.assessment.state === "eligible"
        && !isActiveJob(shot.latestJob)
      ).map((shot) => shot.shotId);
      if (newlyEligible.length > 0) {
        await submitMotionJobs(
          newlyEligible,
          newGenerationOperationId(newlyEligible.length === 1 ? "video-single" : "video-batch"),
        );
      }
    } catch (error) {
      setSubmissionError({
        code: "SAFE_BATCH_PREPARATION_FAILED",
        category: "safety_regeneration",
        message: error instanceof Error ? error.message : tRef.current("motionSafeRegenerationFailed"),
      });
    } finally {
      setBatchPreparing(false);
    }
  }, [
    batchPreparing,
    batchShotIds,
    facelessRegenerationAssets,
    imageAgentReady,
    refreshAfterFacelessRegeneration,
    regenerateOne,
    submitMotionJobs,
    videoAgentReady,
  ]);

  const retryOne = useCallback((shotId: number) => {
    if (!videoAgentReady) return;
    void submitMotionJobs([shotId], newGenerationOperationId("video-single"));
  }, [submitMotionJobs, videoAgentReady]);

  const failureGroups = useMemo(() => {
    const groups = new Map<string, {
      category: string;
      code: string;
      shots: number[];
      message: string;
      uncertain: boolean;
    }>();
    for (const shot of motionSnapshot?.shots ?? []) {
      const job = shot.latestJob;
      if (!job || (job.status !== "failed" && job.status !== "submission_uncertain")) continue;
      const asset = assets.find((row) => row.shotId === shot.shotId);
      // 无脸版仍被更严格的供应商拒绝时，已安全收口为本地轻运镜，不再将它当作待重试失败。
      if (asset && shouldFallbackAfterProviderSafetyRetry(asset, shot)) continue;
      if (
        job.status === "failed"
        && job.sourceImageHash
        && shot.assessment?.imageHash
        && job.sourceImageHash !== shot.assessment.imageHash
      ) continue;
      const category = job.error?.category || (job.status === "submission_uncertain" ? "submission" : "provider");
      const code = job.error?.code || (job.status === "submission_uncertain" ? "SUBMISSION_UNCERTAIN" : "VIDEO_JOB_FAILED");
      const key = `${category}:${code}`;
      const existing = groups.get(key);
      const message = job.error?.userMessage || job.error?.message || t("errorImageToVideoFailed");
      if (existing) {
        existing.shots.push(shot.shotId);
      } else {
        groups.set(key, {
          category,
          code,
          shots: [shot.shotId],
          message,
          uncertain: job.status === "submission_uncertain",
        });
      }
    }
    return [...groups.values()].map((group) => ({
      ...group,
      shots: group.shots.sort((left, right) => left - right),
    }));
  }, [assets, motionSnapshot, t]);

  const dynamicCount = assets.filter((asset) => {
    const state = shotStates.get(asset.shotId);
    return asset.isVideo || Boolean(state?.existingVideoUrl) || state?.latestJob?.status === "succeeded" || state?.assessment?.policy === "use_existing_video";
  }).length;
  const staticPanCount = assets.filter((asset) => {
    const state = shotStates.get(asset.shotId);
    return state?.assessment?.policy === "static_pan"
      || shouldFallbackAfterProviderSafetyRetry(asset, state);
  }).length;
  const regenerateCount = assets.filter((asset) => {
    const state = shotStates.get(asset.shotId);
    return !hasFacelessRetryMarker(asset)
      && (state?.assessment?.policy === "regenerate_faceless" || isCurrentProviderSafetyFailure(asset, state));
  }).length;
  const autoRegenerateCount = imageAgentReady ? facelessRegenerationAssets.length : 0;
  const actionableCount = batchShotIds.length + autoRegenerateCount;
  const manualReviewCount = assets.filter((asset) => shotStates.get(asset.shotId)?.assessment?.state === "manual_review").length;
  const missingFrames = assets.filter((asset) => asset.status !== "done" || !asset.thumbnailUrl).length;
  const assessmentPendingCount = assets.filter((asset) =>
    asset.status === "done"
    && Boolean(asset.thumbnailUrl)
    && !shotStates.get(asset.shotId)?.assessment
  ).length;
  const allMotionResolved = assets.length > 0
    && !motionLoading
    && activeJobCount === 0
    && batchShotIds.length === 0
    && regenerateCount === 0
    && manualReviewCount === 0
    && assessmentPendingCount === 0
    && failureGroups.length === 0;

  const statusFor = useCallback((asset: AssetItem) => {
    const state = shotStates.get(asset.shotId);
    const job = state?.latestJob;
    const assessment = state?.assessment;
    if (asset.status !== "done" || !asset.thumbnailUrl) {
      return { key: "motionStatusNoFrame", tone: "text-muted-foreground" };
    }
    if (regeneratingShots.has(asset.shotId)) return { key: "motionStatusRegenerating", tone: "text-amber-600 dark:text-amber-400" };
    if (submittingShots.has(asset.shotId)) return { key: "motionStatusSubmitting", tone: "text-blue-600 dark:text-blue-400" };
    if (isCurrentProviderSafetyFailure(asset, state)) {
      return hasFacelessRetryMarker(asset)
        ? { key: "motionStatusStaticPan", tone: "text-violet-600 dark:text-violet-400" }
        : { key: "motionStatusRegenerate", tone: "text-amber-600 dark:text-amber-400" };
    }
    switch (job?.status) {
      case "pending": return { key: "motionStatusQueued", tone: "text-blue-600 dark:text-blue-400" };
      case "submitting": return { key: "motionStatusSubmitting", tone: "text-blue-600 dark:text-blue-400" };
      case "submitted":
      case "polling": return { key: "motionStatusProcessing", tone: "text-blue-600 dark:text-blue-400" };
      case "downloading": return { key: "motionStatusDownloading", tone: "text-blue-600 dark:text-blue-400" };
      case "saving": return { key: "motionStatusSaving", tone: "text-blue-600 dark:text-blue-400" };
      case "succeeded": return { key: "motionStatusSucceeded", tone: "text-emerald-600 dark:text-emerald-400" };
      case "failed": return { key: "motionStatusFailed", tone: "text-destructive" };
      case "submission_uncertain": return { key: "motionStatusUncertain", tone: "text-amber-600 dark:text-amber-400" };
    }
    if (!assessment) {
      return motionLoading
        ? { key: "motionStatusAssessing", tone: "text-muted-foreground" }
        : { key: "motionStatusAssessmentUnavailable", tone: "text-amber-600 dark:text-amber-400" };
    }
    if (assessment.policy === "use_existing_video") return { key: "motionStatusSucceeded", tone: "text-emerald-600 dark:text-emerald-400" };
    if (assessment.policy === "regenerate_faceless") return { key: "motionStatusRegenerate", tone: "text-amber-600 dark:text-amber-400" };
    if (assessment.state === "manual_review") return { key: "motionStatusManualReview", tone: "text-amber-600 dark:text-amber-400" };
    if (assessment.policy === "static_pan") return { key: "motionStatusStaticPan", tone: "text-violet-600 dark:text-violet-400" };
    if (assessment.policy === "ai_video") return { key: "motionStatusEligible", tone: "text-muted-foreground" };
    return { key: "motionStatStill", tone: "text-muted-foreground" };
  }, [motionLoading, regeneratingShots, shotStates, submittingShots]);

  return (
    <div className="workflow-light min-h-screen grid-bg">
      <header className="sticky top-0 z-50 border-b border-border/50 bg-background/80 backdrop-blur-xl">
        <div className="mx-auto flex h-14 max-w-7xl items-center justify-between px-6">
          <div className="flex items-center gap-4">
            <Link href="/project/agent" className="flex items-center gap-3">
              <BrandWheatMark className="h-9 w-7 text-foreground" />
            </Link>
            <span className="text-muted-foreground">/</span>
            <span className="max-w-[40vw] truncate text-sm text-muted-foreground sm:max-w-xs">
              {projectName || t("untitledProject")}
            </span>
          </div>
          <div className="flex items-center gap-1">
            <LanguageToggle className="mr-1" />
            <div className="hidden items-center gap-1 sm:flex">
              <StepProgressIndicator
                steps={[t("stepScript"), t("stepAssets"), t("stepMotion"), t("stepVideo"), t("stepExport")]}
                activeIndex={2}
                hrefs={workflowStepHrefs}
                backLabel={tc("backPrevStep")}
              />
            </div>
            <Link href={`/project/${id}/assets`}>
              <Button variant="ghost" size="sm" className="text-xs">
                <LuArrowLeft className="mr-1 h-3.5 w-3.5" />
                {t("backToAssetsStep")}
              </Button>
            </Link>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-6 py-6">
        {loading ? (
          <div className="flex items-center justify-center py-24 text-sm text-muted-foreground">
            <LuLoaderCircle className="mr-2 h-4 w-4 animate-spin" />
            {t("loadingShots")}
          </div>
        ) : loadError ? (
          <Card className="glass-card">
            <CardContent className="flex flex-col items-center gap-3 px-5 py-10 text-center">
              <p className="text-sm text-muted-foreground">{loadError}</p>
              <Link href={`/project/${id}/script`}>
                <Button variant="outline" size="sm">{t("backToScriptStep")}</Button>
              </Link>
            </CardContent>
          </Card>
        ) : (
          <>
            <Card className="glass-card mb-5 py-0">
              <CardContent className="px-5 py-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <h2 className="text-lg font-semibold">
                      {allMotionResolved ? t("motionHeroTitleDone") : t("motionHeroTitle")}
                    </h2>
                    <p className="mt-0.5 text-sm text-muted-foreground">
                      {hasBackgroundWork
                        ? t("motionHeroDescActive", { count: backgroundShotCount })
                        : motionLoading
                          ? t("motionHeroDescAssessing")
                          : actionableCount > 0
                            ? autoRegenerateCount > 0
                              ? t("motionHeroDescWithRegeneration", {
                                  count: actionableCount,
                                  regenerate: autoRegenerateCount,
                                })
                              : t("motionHeroDesc", { count: actionableCount })
                            : missingFrames > 0
                              ? t("motionHeroDescNoFrames", { count: missingFrames })
                              : assessmentPendingCount > 0
                                ? t("motionHeroDescAssessmentUnavailable", { count: assessmentPendingCount })
                                : regenerateCount + manualReviewCount > 0
                                  ? t("motionHeroDescAttention", { count: regenerateCount + manualReviewCount })
                                  : t("motionHeroDescDone")}
                    </p>
                    {!videoAgentReady && (batchShotIds.length > 0 || regenerateCount > 0) && (
                      <p className="mt-1.5 text-sm font-medium text-amber-600 dark:text-amber-400">
                        {t("errorNoVideoModel")}
                      </p>
                    )}
                    {videoAgentReady && regenerateCount > 0 && !imageAgentReady && (
                      <p className="mt-1.5 text-sm font-medium text-amber-600 dark:text-amber-400">
                        {t("errorNoImageModel")}
                      </p>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {actionableCount > 0 && videoAgentReady && (
                      <Button
                        className="brand-gradient text-sm text-white"
                        disabled={submittingShots.size > 0 || batchPreparing || motionLoading || retryCooldownActive}
                        onClick={() => void animateAll()}
                      >
                        {submittingShots.size > 0 || batchPreparing ? (
                          <>
                            <LuLoaderCircle className="mr-1.5 h-4 w-4 animate-spin" />
                            {batchPreparing ? t("motionStatusRegenerating") : t("motionStatusSubmitting")}
                          </>
                        ) : (
                          <>
                            <LuClapperboard className="mr-1 h-4 w-4" />
                            {t("animateAllBtn", { count: actionableCount })}
                          </>
                        )}
                      </Button>
                    )}
                    <Link href={`/project/${id}/video`}>
                      <Button
                        variant={allMotionResolved ? "default" : "outline"}
                        className={`text-sm ${allMotionResolved ? "brand-gradient text-white" : ""}`}
                      >
                        {allMotionResolved ? t("nextCompose") : t("skipToCompose")}
                        <LuArrowRight className="ml-1 h-4 w-4" />
                      </Button>
                    </Link>
                  </div>
                </div>
              </CardContent>
            </Card>

            {hasBackgroundWork && (
              <div className="mb-4 rounded-lg border border-blue-200 bg-blue-50/80 px-4 py-3 text-sm text-blue-800 dark:border-blue-900/60 dark:bg-blue-950/30 dark:text-blue-200">
                <div className="flex items-start gap-2">
                  <LuLoaderCircle className="mt-0.5 h-4 w-4 shrink-0 animate-spin" />
                  <div>
                    <p className="font-medium">{t("motionBackgroundTitle")}</p>
                    <p className="mt-0.5 text-xs opacity-80">{t("motionBackgroundDesc")}</p>
                  </div>
                </div>
              </div>
            )}

            {(batchPreparing || regeneratingShots.size > 0) && (
              <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50/80 px-4 py-3 text-sm text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-100">
                <div className="flex items-start gap-2">
                  <LuLoaderCircle className="mt-0.5 h-4 w-4 shrink-0 animate-spin" />
                  <div>
                    <p className="font-medium">{t("motionSafeRegenerationTitle")}</p>
                    <p className="mt-0.5 text-xs opacity-80">{t("motionSafeRegenerationDesc")}</p>
                  </div>
                </div>
              </div>
            )}

            {(motionLoadError || submissionError) && (
              <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50/80 px-4 py-3 text-sm text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-100">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-start gap-2">
                    <LuCircleAlert className="mt-0.5 h-4 w-4 shrink-0" />
                    <div>
                      <p className="font-medium">{submissionError ? t("motionSubmissionErrorTitle") : t("motionLoadErrorTitle")}</p>
                      <p className="mt-0.5 text-xs opacity-80">
                        {submissionError
                          ? `[${submissionError.category}/${submissionError.code}] ${submissionError.message}${submissionError.retryAfterSeconds ? ` · ${t("motionRetryAfter", { seconds: submissionError.retryAfterSeconds })}` : ""}`
                          : motionLoadError}
                      </p>
                    </div>
                  </div>
                  <Button variant="ghost" size="sm" className="h-7 shrink-0 text-xs" onClick={() => void refreshMotionJobs(false)}>
                    <LuRefreshCw className="mr-1 h-3 w-3" />
                    {t("motionRefresh")}
                  </Button>
                </div>
              </div>
            )}

            {failureGroups.length > 0 && (
              <div className="mb-4 rounded-lg border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm">
                <p className="font-medium text-destructive">{t("motionFailureSummaryTitle")}</p>
                <div className="mt-1.5 space-y-1 text-xs text-muted-foreground">
                  {failureGroups.map((group) => (
                    <p key={`${group.category}:${group.code}`}>
                      <span className="font-mono text-foreground">{group.category}/{group.code}</span>
                      {` · ${t("motionFailureShots", { shots: group.shots.join("、") })} · ${group.message}`}
                      {group.uncertain ? ` · ${t("motionNoRetryUncertain")}` : ""}
                    </p>
                  ))}
                </div>
              </div>
            )}

            <Card className="glass-card">
              <CardContent className="p-5">
                <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                  <h3 className="text-base font-semibold">{t("motionListTitle")}</h3>
                  <span className="text-xs text-muted-foreground">
                    {t("motionListMetaDetailed", {
                      dynamic: dynamicCount,
                      static: staticPanCount,
                      total: assets.length,
                    })}
                    {regenerateCount > 0 ? ` · ${t("motionStatRegenerate", { count: regenerateCount })}` : ""}
                  </span>
                </div>
                <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
                  {assets.map((asset) => {
                    const typeInfo = SHOT_TYPE_INFO[asset.type] ?? SHOT_TYPE_INFO.demo;
                    const state = shotStates.get(asset.shotId);
                    const assessment = state?.assessment;
                    const job = state?.latestJob;
                    const regenerating = regeneratingShots.has(asset.shotId);
                    const active = regenerating || submittingShots.has(asset.shotId) || isActiveJob(job);
                    const jobVideoUrl = job?.status === "succeeded" ? job.outputUrl : null;
                    const existingVideoUrl = state?.existingVideoUrl || (asset.isVideo ? asset.assetFileUrl || asset.thumbnailUrl : null);
                    const videoUrl = jobVideoUrl || existingVideoUrl;
                    const displayStatus = statusFor(asset);
                    const canSubmit = canSubmitShot(asset);
                    const isRetry = job?.status === "failed"
                      && (!job.sourceImageHash || job.sourceImageHash === assessment?.imageHash);
                    const providerSafetyFailure = isCurrentProviderSafetyFailure(asset, state);
                    const providerSafetyFallback = shouldFallbackAfterProviderSafetyRetry(asset, state);
                    const regenerate = assessment?.policy === "regenerate_faceless" || providerSafetyFailure;
                    const manualReview = assessment?.state === "manual_review";
                    return (
                      <div key={asset.shotId} className="overflow-hidden rounded-lg border border-border/50 bg-muted/20">
                        <div className="relative aspect-[9/12] bg-muted/30">
                          {videoUrl ? (
                            <video
                              src={videoUrl}
                              muted
                              playsInline
                              loop
                              autoPlay
                              className="h-full w-full object-cover"
                            />
                          ) : asset.thumbnailUrl ? (
                            <div
                              className="h-full w-full bg-cover bg-center"
                              style={{ backgroundImage: `url(${asset.thumbnailUrl})` }}
                            />
                          ) : (
                            <div className="flex h-full w-full items-center justify-center text-xs text-muted-foreground">
                              {t("assetResultWaiting")}
                            </div>
                          )}
                          {active && (
                            <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-background/60">
                              <LuLoaderCircle className="h-5 w-5 animate-spin text-primary" />
                              {!regenerating && typeof job?.progress === "number" && (
                                <span className="text-[10px] font-medium text-foreground">{Math.round(job.progress)}%</span>
                              )}
                            </div>
                          )}
                          <span className="absolute left-2 top-2 flex h-6 w-6 items-center justify-center rounded-full bg-foreground text-xs font-semibold text-background">
                            {asset.shotId}
                          </span>
                        </div>
                        <div className="flex flex-col gap-1.5 p-2.5">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <Badge className={`${typeInfo.color} border-0 text-[10px]`}>{t(typeInfo.labelKey)}</Badge>
                            <span className="text-[11px] text-muted-foreground">{asset.duration}s</span>
                            <span className={`text-[10px] ${displayStatus.tone}`}>{t(displayStatus.key)}</span>
                          </div>

                          {active && (
                            <Button variant="ghost" size="sm" className="h-7 text-xs" disabled>
                              <LuLoaderCircle className="mr-1 h-3 w-3 animate-spin" />
                              {t(displayStatus.key)}
                            </Button>
                          )}
                          {!active && canSubmit && (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-7 text-xs text-muted-foreground hover:text-primary"
                              disabled={!videoAgentReady || retryCooldownActive}
                              onClick={() => retryOne(asset.shotId)}
                              title={t("motionTip")}
                            >
                              {isRetry ? <LuRefreshCw className="mr-1 h-3 w-3" /> : <LuPlay className="mr-1 h-3 w-3" />}
                              {isRetry ? t("motionRetry") : t("btnConvertMotion")}
                            </Button>
                          )}
                          {!active && regenerate && !hasFacelessRetryMarker(asset) && (
                            <Button
                              variant="outline"
                              size="sm"
                              className="h-7 w-full text-xs"
                              disabled={!imageAgentReady || !videoAgentReady}
                              onClick={() => void regenerateAndSubmitOne(asset)}
                            >
                              <LuRefreshCw className="mr-1 h-3 w-3" />
                              {t("motionRegenerateAction")}
                            </Button>
                          )}
                          {!active && manualReview && !regenerate && (
                            <Link href={`/project/${id}/assets?shot=${asset.shotId}&action=review-motion`}>
                              <Button variant="outline" size="sm" className="h-7 w-full text-xs">
                                {t("motionManualReviewAction")}
                              </Button>
                            </Link>
                          )}

                          {(assessment?.policy === "static_pan" && assessment.state !== "manual_review" || providerSafetyFallback) && (
                            <span className="text-[10px] leading-snug text-muted-foreground">{t("motionStaticPanTip")}</span>
                          )}
                          {regenerate && !providerSafetyFallback && (
                            <span className="text-[10px] leading-snug text-amber-700 dark:text-amber-300">{t("motionRegenerateTip")}</span>
                          )}
                          {manualReview && !regenerate && (
                            <span className="text-[10px] leading-snug text-amber-700 dark:text-amber-300">{t("motionManualReviewTip")}</span>
                          )}
                          {job?.status === "submission_uncertain" && (
                            <span className="text-[10px] leading-snug text-amber-700 dark:text-amber-300">{t("motionNoRetryUncertain")}</span>
                          )}
                          {job?.status === "failed" && job.error && !providerSafetyFallback && (
                            <span className="text-[10px] leading-snug text-destructive">
                              [{job.error.category || "provider"}/{job.error.code || "VIDEO_JOB_FAILED"}] {job.error.userMessage || job.error.message || t("errorImageToVideoFailed")}
                            </span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </CardContent>
            </Card>
          </>
        )}
      </main>
    </div>
  );
}
