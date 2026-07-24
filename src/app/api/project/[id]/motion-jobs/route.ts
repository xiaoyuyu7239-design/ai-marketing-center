import { NextRequest, NextResponse } from "next/server";

import { requireMerchant, requireOwnedProject } from "@backend/core/auth/require-merchant";
import {
  GenerationOperationConflictError,
  InvalidGenerationOperationError,
  QuotaExceededError,
  safeGenerationErrorMessage,
} from "@backend/core/auth/usage";
import {
  consumeExpensiveRouteRateLimit,
  EXPENSIVE_RATE_LIMIT_PRESETS,
  rateLimitResponse,
} from "@backend/core/security/rate-limit";
import {
  MotionVideoJobIdempotencyConflictError,
  MotionVideoJobInputError,
  MotionVideoJobQueueLimitError,
  enqueueMotionVideoJobs,
  evaluateProjectMotionShots,
  listMotionVideoJobs,
  normalizeMotionOperationKey,
  prepareMotionVideoJobs,
  toMotionVideoJobDto,
  type MotionShotEligibilityView,
  type MotionShotRequest,
} from "@backend/core/video-jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  Pragma: "no-cache",
  Expires: "0",
};

function json(payload: unknown, init?: ResponseInit) {
  return NextResponse.json(payload, {
    ...init,
    headers: { ...NO_STORE_HEADERS, ...init?.headers },
  });
}

function withLatestJobs(
  shots: MotionShotEligibilityView[],
  jobs: ReturnType<typeof listMotionVideoJobs>,
) {
  return shots.map((shot) => {
    // 分镜换图后，旧 asset 的进行中/成功任务不能冒充新图状态。
    // jobs 已按 createdAt/id 倒序，find 即当前素材版本的最新任务。
    const latest = jobs.find((job) => {
      if (job.shotId !== shot.shotId || job.sourceAssetId !== shot.assetId) return false;
      return toMotionVideoJobDto(job).sourceImageHash === shot.imageHash;
    });
    return { ...shot, latestJob: latest ? toMotionVideoJobDto(latest) : null };
  });
}

function summary(
  shots: ReturnType<typeof withLatestJobs>,
  jobs: ReturnType<typeof listMotionVideoJobs>,
) {
  const latestJobIds = new Set(shots.flatMap((shot) => shot.latestJob ? [shot.latestJob.id] : []));
  const latestJobs = jobs.filter((job) => latestJobIds.has(job.id));
  return {
    total: shots.length,
    aiVideo: shots.filter((shot) => shot.decision.policy === "ai_video").length,
    staticPan: shots.filter((shot) => shot.decision.policy === "static_pan").length,
    regenerateFaceless: shots.filter((shot) => shot.decision.policy === "regenerate_faceless").length,
    existingVideo: shots.filter((shot) => shot.decision.policy === "use_existing_video").length,
    active: latestJobs.filter((job) => ["pending", "submitting", "submitted", "polling", "downloading", "saving"].includes(job.status)).length,
    succeeded: latestJobs.filter((job) => job.status === "succeeded").length,
    failed: latestJobs.filter((job) => job.status === "failed" || job.status === "submission_uncertain").length,
  };
}

async function projectPayload(merchantId: string, projectId: string) {
  const [assessments, jobs] = await Promise.all([
    evaluateProjectMotionShots(merchantId, projectId),
    Promise.resolve(listMotionVideoJobs(merchantId, projectId)),
  ]);
  const shots = withLatestJobs(assessments, jobs);
  return {
    shots,
    jobs: jobs.map(toMotionVideoJobDto),
    summary: summary(shots, jobs),
  };
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireMerchant(req);
  if ("error" in auth) return auth.error;
  const { id } = await params;
  const owned = await requireOwnedProject(auth.merchant.id, id);
  if ("error" in owned) return owned.error;
  try {
    // 背景轮询只查持久任务，避免每 3 秒对全部分镜重复 SHA-256/ffprobe/人脸检测。
    // 完整资格仍在首次进页、手动刷新、重生后和付费提交前服务端重算。
    if (req.nextUrl.searchParams.get("view") === "jobs") {
      const jobs = listMotionVideoJobs(auth.merchant.id, id).map(toMotionVideoJobDto);
      return json({ jobs }, { headers: { "Retry-After": "3" } });
    }
    return json(await projectPayload(auth.merchant.id, id));
  } catch (error) {
    if (error instanceof MotionVideoJobInputError) {
      return json({ error: error.message, code: error.code }, { status: 422 });
    }
    console.error("读取动态任务失败:", safeGenerationErrorMessage(error));
    return json({ error: "读取动态任务失败", code: "MOTION_JOBS_READ_FAILED" }, { status: 500 });
  }
}

function requestItems(body: Record<string, unknown>): MotionShotRequest[] {
  const rawItems = Array.isArray(body.items) ? body.items : null;
  const shotIds = Array.isArray(body.shotIds) ? body.shotIds : null;
  if (rawItems) {
    const parsed = rawItems.map((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new MotionVideoJobInputError("items 格式不正确");
      }
      const item = value as Record<string, unknown>;
      if (!Number.isSafeInteger(item.shotId) || (item.shotId as number) < 0) {
        throw new MotionVideoJobInputError("items.shotId 不合法");
      }
      if (item.prompt != null && typeof item.prompt !== "string") {
        throw new MotionVideoJobInputError("items.prompt 不合法");
      }
      if (item.lastFrameShotId != null
        && (!Number.isSafeInteger(item.lastFrameShotId) || (item.lastFrameShotId as number) < 0)) {
        throw new MotionVideoJobInputError("items.lastFrameShotId 不合法");
      }
      if (item.options != null && (!item.options || typeof item.options !== "object" || Array.isArray(item.options))) {
        throw new MotionVideoJobInputError("items.options 不合法");
      }
      return {
        shotId: item.shotId as number,
        ...(typeof item.prompt === "string" ? { prompt: item.prompt } : {}),
        ...(typeof item.lastFrameShotId === "number" ? { lastFrameShotId: item.lastFrameShotId } : {}),
        ...(item.options ? { options: item.options as Record<string, unknown> } : {}),
      };
    });
    if (shotIds) {
      const declared = shotIds.filter((value): value is number => Number.isSafeInteger(value) && value >= 0);
      if (declared.length !== shotIds.length
        || declared.length !== parsed.length
        || declared.some((shotId) => !parsed.some((item) => item.shotId === shotId))) {
        throw new MotionVideoJobInputError("shotIds 与 items 不一致");
      }
    }
    return parsed;
  }
  if (!shotIds || shotIds.some((value) => !Number.isSafeInteger(value) || (value as number) < 0)) {
    throw new MotionVideoJobInputError("必须提供有效的 shotIds 或 items");
  }
  return shotIds.map((shotId) => ({ shotId: shotId as number }));
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireMerchant(req);
  if ("error" in auth) return auth.error;
  const { id } = await params;
  const owned = await requireOwnedProject(auth.merchant.id, id);
  if ("error" in owned) return owned.error;
  const limit = consumeExpensiveRouteRateLimit(
    req,
    auth.merchant.id,
    "project:motion-jobs",
    EXPENSIVE_RATE_LIMIT_PRESETS.video,
  );
  if (!limit.allowed) return rateLimitResponse(limit, "动态任务提交过于频繁，请稍后重试");

  try {
    const body = await req.json().catch(() => {
      throw new MotionVideoJobInputError("请求体不是有效 JSON");
    }) as Record<string, unknown>;
    const operationId = normalizeMotionOperationKey(
      typeof body.operationId === "string"
        ? body.operationId
        : req.headers.get("Idempotency-Key") || "",
    );
    const requestedShots = requestItems(body);
    const prepared = await prepareMotionVideoJobs({
      merchantId: auth.merchant.id,
      projectId: id,
      operationKey: operationId,
      requestedShots,
    });
    const queued = prepared.inputs.length ? enqueueMotionVideoJobs(prepared.inputs) : [];
    const allJobs = listMotionVideoJobs(auth.merchant.id, id);
    const shots = withLatestJobs(prepared.shots, allJobs);
    const pollUrl = `/api/project/${encodeURIComponent(id)}/motion-jobs`;
    return json({
      accepted: true,
      operationId,
      jobs: queued.map(({ job, duplicate }) => ({ ...toMotionVideoJobDto(job), duplicate })),
      shots,
      pollUrl,
      duplicate: queued.length > 0 && queued.every((item) => item.duplicate),
    }, {
      status: 202,
      headers: { Location: pollUrl, "Retry-After": "3" },
    });
  } catch (error) {
    if (error instanceof QuotaExceededError) {
      return json({ error: error.message, code: "QUOTA_EXCEEDED" }, { status: 402 });
    }
    if (error instanceof MotionVideoJobIdempotencyConflictError || error instanceof GenerationOperationConflictError) {
      return json({ error: error.message, code: "MOTION_JOB_IDEMPOTENCY_CONFLICT" }, { status: 409 });
    }
    if (error instanceof MotionVideoJobQueueLimitError) {
      return json({ error: error.message, code: error.code }, {
        status: 429,
        headers: { "Retry-After": "10" },
      });
    }
    if (error instanceof MotionVideoJobInputError || error instanceof InvalidGenerationOperationError) {
      return json({
        error: error.message,
        code: error instanceof MotionVideoJobInputError ? error.code : "MOTION_JOB_INPUT_INVALID",
      }, { status: 400 });
    }
    if (error instanceof Error && error.name === "AgentConfigError") {
      return json({ error: "视频模型策略暂不可用", code: "VIDEO_CONFIG_UNAVAILABLE" }, { status: 422 });
    }
    console.error("动态任务入队失败:", safeGenerationErrorMessage(error));
    return json({ error: "动态任务入队失败，请稍后重试", code: "MOTION_JOB_ENQUEUE_FAILED" }, { status: 500 });
  }
}
