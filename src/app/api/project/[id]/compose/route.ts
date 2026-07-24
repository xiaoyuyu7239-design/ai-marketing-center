import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import { requireMerchant, requireOwnedProject } from "@backend/core/auth/require-merchant";
import {
  buildComposeJobPayload,
  ComposeJobInputError,
} from "@backend/core/jobs/compose-payload";
import {
  cancelPendingComposeJob,
  enqueueComposeJob,
  getJobByCompositionId,
  IdempotencyConflictError,
  InvalidIdempotencyKeyError,
  JobCancellationConflictError,
  JobQueueLimitError,
  normalizeIdempotencyKey,
  sanitizeJobError,
  type EnqueueComposeJobResult,
} from "@backend/core/jobs/repository";
import { hashGenerationRequest, QuotaExceededError } from "@backend/core/auth/usage";
import { consumeExpensiveRouteRateLimit, EXPENSIVE_RATE_LIMIT_PRESETS, rateLimitResponse } from "@backend/core/security/rate-limit";
import { getDb } from "@backend/db";
import { compositions } from "@backend/db/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE_HEADERS = {
  "Cache-Control": "no-store, max-age=0",
  Pragma: "no-cache",
  Expires: "0",
};

function acceptedResponse(projectId: string, result: EnqueueComposeJobResult): NextResponse {
  const location = `/api/project/${encodeURIComponent(projectId)}/compose?compositionId=${encodeURIComponent(result.composition.id)}`;
  return NextResponse.json(
    {
      jobId: result.job.id,
      compositionId: result.composition.id,
      status: result.composition.status,
      duplicate: result.duplicate,
    },
    {
      status: 202,
      headers: {
        ...NO_STORE_HEADERS,
        Location: location,
        "Retry-After": "3",
      },
    },
  );
}

/** 读取最新 composition；轮询时必须带 compositionId，失败原因来自持久 jobs 表。 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireMerchant(req);
  if ("error" in auth) return auth.error;

  try {
    const { id } = await params;
    const owned = await requireOwnedProject(auth.merchant.id, id);
    if ("error" in owned) return owned.error;

    const compositionId = req.nextUrl.searchParams.get("compositionId")?.trim();
    const db = getDb();
    const composition = compositionId
      ? db
          .select()
          .from(compositions)
          .where(and(eq(compositions.projectId, id), eq(compositions.id, compositionId)))
          .limit(1)
          .all()[0]
      : db
          .select()
          .from(compositions)
          .where(and(eq(compositions.projectId, id), eq(compositions.status, "done")))
          .orderBy(desc(compositions.createdAt))
          .limit(1)
          .all()[0] ?? db
          .select()
          .from(compositions)
          .where(eq(compositions.projectId, id))
          .orderBy(desc(compositions.createdAt))
          .limit(1)
          .all()[0];

    if (!composition) {
      return NextResponse.json(
        compositionId ? { error: "合成任务不存在" } : { composition: null },
        { status: compositionId ? 404 : 200, headers: NO_STORE_HEADERS },
      );
    }

    const job = getJobByCompositionId(composition.id);
    const fileName = composition.outputPath?.split(/[\\/]/).pop() || "";
    const completed = composition.status === "done" && Boolean(fileName);
    return NextResponse.json(
      {
        composition: {
          id: composition.id,
          projectId: composition.projectId,
          jobId: job?.id ?? null,
          jobStatus: job?.status ?? null,
          resolution: composition.resolution,
          aspectRatio: composition.aspectRatio,
          duration: composition.duration,
          ttsEnabled: composition.ttsEnabled,
          aigcDisclosure: composition.aigcDisclosure,
          credits: composition.credits,
          status: composition.status,
          createdAt: composition.createdAt,
          fileName: completed ? fileName : "",
          url: completed ? `/api/output/${encodeURIComponent(id)}/${encodeURIComponent(fileName)}` : null,
          errorMessage:
            composition.status === "failed"
              ? job?.errorMessage || "视频合成失败，请重新发起或联系绘卖团队"
              : null,
        },
      },
      { headers: NO_STORE_HEADERS },
    );
  } catch (error) {
    console.error(`获取合成记录失败: ${sanitizeJobError(error)}`);
    return NextResponse.json({ error: "获取合成记录失败" }, { status: 500, headers: NO_STORE_HEADERS });
  }
}

/** 只取消尚未开始执行的持久合成任务；running 任务明确返回 409。 */
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireMerchant(req);
  if ("error" in auth) return auth.error;

  try {
    const { id } = await params;
    const owned = await requireOwnedProject(auth.merchant.id, id);
    if ("error" in owned) return owned.error;
    const compositionId = req.nextUrl.searchParams.get("compositionId")?.trim();
    if (!compositionId) {
      return NextResponse.json(
        { error: "缺少 compositionId" },
        { status: 400, headers: NO_STORE_HEADERS },
      );
    }

    const result = cancelPendingComposeJob(auth.merchant.id, id, compositionId);
    if (!result) {
      return NextResponse.json(
        { error: "合成任务不存在" },
        { status: 404, headers: NO_STORE_HEADERS },
      );
    }
    return NextResponse.json(
      {
        jobId: result.job.id,
        compositionId: result.composition.id,
        jobStatus: result.job.status,
        cancelled: result.cancelled,
      },
      { headers: NO_STORE_HEADERS },
    );
  } catch (error) {
    if (error instanceof JobCancellationConflictError) {
      return NextResponse.json(
        { error: error.message },
        { status: 409, headers: NO_STORE_HEADERS },
      );
    }
    console.error(`取消合成任务失败: ${sanitizeJobError(error)}`);
    return NextResponse.json(
      { error: "取消合成任务失败" },
      { status: 500, headers: NO_STORE_HEADERS },
    );
  }
}

/** 校验并冻结业务输入，事务内创建 composition + job 后立即 202；不在请求生命周期执行 TTS/FFmpeg。 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireMerchant(req);
  if ("error" in auth) return auth.error;
  const merchantId = auth.merchant.id;
  const limit = consumeExpensiveRouteRateLimit(req, merchantId, "project:compose", EXPENSIVE_RATE_LIMIT_PRESETS.compose);
  if (!limit.allowed) return rateLimitResponse(limit, "合成任务提交过于频繁，请稍后再试");

  try {
    const { id } = await params;
    const owned = await requireOwnedProject(merchantId, id);
    if ("error" in owned) return owned.error;

    const idempotencyKey = normalizeIdempotencyKey(req.headers.get("Idempotency-Key"));
    const body = await req.json().catch(() => {
      throw new ComposeJobInputError("请求体不是有效 JSON");
    });
    const snapshot = await buildComposeJobPayload(merchantId, id, body);
    const requestHash = hashGenerationRequest(snapshot.payload);
    const result = enqueueComposeJob({
      merchantId,
      projectId: id,
      idempotencyKey,
      payload: snapshot.payload as unknown as Record<string, unknown>,
      requestHash,
      paidTtsRequested: snapshot.payload.options.agentTts === true,
      resolution: snapshot.resolution,
      aspectRatio: snapshot.aspectRatio,
      ttsEnabled: snapshot.ttsEnabled,
      bgmPath: snapshot.bgmPath,
    });
    return acceptedResponse(id, result);
  } catch (error) {
    if (error instanceof InvalidIdempotencyKeyError || error instanceof ComposeJobInputError) {
      return NextResponse.json(
        { error: error.message },
        {
          status: error instanceof ComposeJobInputError ? error.status : 400,
          headers: NO_STORE_HEADERS,
        },
      );
    }
    if (error instanceof IdempotencyConflictError) {
      return NextResponse.json({ error: error.message }, { status: 409, headers: NO_STORE_HEADERS });
    }
    if (error instanceof QuotaExceededError) {
      return NextResponse.json({ error: error.message }, { status: 402, headers: NO_STORE_HEADERS });
    }
    if (error instanceof JobQueueLimitError) {
      return NextResponse.json(
        { error: error.message },
        { status: 429, headers: { ...NO_STORE_HEADERS, "Retry-After": "10" } },
      );
    }
    console.error(`合成任务入队失败: ${sanitizeJobError(error)}`);
    return NextResponse.json(
      { error: "合成任务入队失败，请稍后重试" },
      { status: 500, headers: NO_STORE_HEADERS },
    );
  }
}
