import { NextRequest, NextResponse } from "next/server";
import { createProvider } from "@backend/providers";
import { ProviderError } from "@backend/providers/base";
import { toRemoteUsableImage } from "@backend/shared/remote-image";
import { classifyAgentError, type AgentRuntimeConfig } from "@server/admin/agents";
import type { VideoOptions, VideoResult } from "@backend/providers/types";
import { requireMerchant, requireOwnedProject } from "@backend/core/auth/require-merchant";
import { mediaRefBelongsToMerchant, parseMediaRef } from "@backend/core/auth/media-access";
import {
  GenerationItemFailedError,
  GenerationItemInProgressError,
  GenerationItemLeaseLostError,
  GenerationOperationConflictError,
  failGenerationOperationItemBeforeClaim,
  hashGenerationRequest,
  InvalidGenerationOperationError,
  QuotaExceededError,
  runGenerationOperationItem,
  safeGenerationErrorMessage,
} from "@backend/core/auth/usage";
import {
  consumeExpensiveRouteRateLimit,
  EXPENSIVE_RATE_LIMIT_PRESETS,
  rateLimitResponse,
} from "@backend/core/security/rate-limit";

function boundedNumber(value: unknown, min: number, max: number, integer = false): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) return undefined;
  return integer ? Math.floor(value) : value;
}

/** 限制单个视频 item 的时长/分辨率上限，并删除模型、引用 URL、额外付费音频等可越权字段。 */
function sanitizeVideoOptions(value: unknown): Partial<VideoOptions> {
  const raw = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const width = boundedNumber(raw.width, 256, 1_920, true);
  const height = boundedNumber(raw.height, 256, 1_920, true);
  const validSize = width != null && height != null && width * height <= 2_073_600;
  const negativePrompt = typeof raw.negativePrompt === "string"
    ? raw.negativePrompt.trim().slice(0, 2_000)
    : "";
  return {
    ...(validSize ? { width, height } : {}),
    ...(boundedNumber(raw.duration, 1, 10, true) != null
      ? { duration: boundedNumber(raw.duration, 1, 10, true) }
      : {}),
    ...(boundedNumber(raw.fps, 1, 60, true) != null
      ? { fps: boundedNumber(raw.fps, 1, 60, true) }
      : {}),
    ...(boundedNumber(raw.motionStrength, 0, 1) != null
      ? { motionStrength: boundedNumber(raw.motionStrength, 0, 1) }
      : {}),
    ...(boundedNumber(raw.guidanceScale, 0, 30) != null
      ? { guidanceScale: boundedNumber(raw.guidanceScale, 0, 30) }
      : {}),
    ...(boundedNumber(raw.seed, 0, Number.MAX_SAFE_INTEGER, true) != null
      ? { seed: boundedNumber(raw.seed, 0, Number.MAX_SAFE_INTEGER, true) }
      : {}),
    ...(negativePrompt ? { negativePrompt } : {}),
  };
}

/** 主模型因输入图含真人人脸被平台风控拒绝（如火山 seedance 的肖像保护） */
function isFaceBlocked(e: unknown): boolean {
  return e instanceof Error && /肖像保护|InputImageSensitiveContentDetected/i.test(e.message);
}

function isSubmissionUncertain(e: unknown): boolean {
  return e instanceof ProviderError && e.code === "SUBMISSION_UNCERTAIN";
}

function canRetryWithoutLastFrame(error: unknown) {
  if (isSubmissionUncertain(error) || classifyAgentError(error).category !== "client_4xx") return false;
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /last[_ -]?frame|tail[_ -]?frame|flf2v|首尾帧|尾帧.*(?:不支持|无效|格式)/i.test(message);
}

function videoModelForMode(config: AgentRuntimeConfig, mode: VideoOptions["mode"]) {
  const model = config.model;
  if (mode === "image-to-video" && model.includes("/text-to-video")) {
    return model.replace("/text-to-video", "/image-to-video");
  }
  if (mode === "text-to-video" && model.includes("/image-to-video")) {
    return model.replace("/image-to-video", "/text-to-video");
  }
  return model;
}

function safeVideoResponse(result: VideoResult) {
  return {
    videoUrls: result.videoUrls,
    coverImageUrl: result.coverImageUrl,
    duration: result.duration,
    processingTime: result.processingTime,
    hasAudio: result.hasAudio,
  };
}

// AI 生视频：普通用户端只传业务参数，provider/model/apiKey/baseUrl 由 videoAgent 线上策略决定。
export async function POST(req: NextRequest) {
  const auth = await requireMerchant(req);
  if ("error" in auth) return auth.error;
  const body = await req.json().catch(() => ({}));
  const projectId = typeof body.projectId === "string" ? body.projectId.trim() : "";
  const prompt = typeof body.prompt === "string" ? body.prompt : "";
  const imageUrl = typeof body.imageUrl === "string" ? body.imageUrl : undefined;
  const requestedOperationId = typeof body.operationId === "string" ? body.operationId.trim() : "";
  const requestedItemKey = typeof body.itemKey === "string" ? body.itemKey.trim() : "";
  const operationType = body.operationType === "video-batch" ? "video-batch" : "video-single";
  // 尾帧（可选）：与首帧组成 flf2v 首尾帧模式，生成"从首帧运动到尾帧"的镜头（相邻分镜咬合流动）
  const lastFrameRaw = typeof body.lastFrameUrl === "string" ? body.lastFrameUrl : undefined;

  if (!projectId) {
    return NextResponse.json({ error: "缺少 projectId" }, { status: 400 });
  }
  if (Boolean(requestedOperationId) !== Boolean(requestedItemKey)) {
    return NextResponse.json({ error: "operationId 与 itemKey 必须同时提供" }, { status: 400 });
  }
  if (requestedOperationId && body.operationType !== "video-batch" && body.operationType !== "video-single") {
    return NextResponse.json({ error: "operationType 不合法" }, { status: 400 });
  }
  const rejectBeforeClaim = (failureCode: string) => {
    if (!requestedOperationId || !requestedItemKey || !projectId) return;
    try {
      failGenerationOperationItemBeforeClaim(auth.merchant.id, {
        operationKey: requestedOperationId,
        operationType,
        itemKey: requestedItemKey,
        agentId: "videoAgent",
        projectId,
        failureCode,
      });
    } catch {
      // 保留原请求的稳定错误响应，账本异常由后台监控跟进。
      console.error("[generation] 视频子项在 claim 前收口失败");
    }
  };
  const owned = await requireOwnedProject(auth.merchant.id, projectId);
  if ("error" in owned) return owned.error;
  const limit = consumeExpensiveRouteRateLimit(
    req,
    auth.merchant.id,
    "ai:video",
    EXPENSIVE_RATE_LIMIT_PRESETS.video,
  );
  if (!limit.allowed) {
    rejectBeforeClaim("rate_limit_before_claim");
    return rateLimitResponse(limit, "视频生成过于频繁，请稍后再试");
  }
  for (const ref of [imageUrl, lastFrameRaw]) {
    if (ref && parseMediaRef(ref) && !mediaRefBelongsToMerchant(ref, auth.merchant.id, projectId)) {
      rejectBeforeClaim("invalid_media_before_claim");
      return NextResponse.json({ error: "参考图片不存在" }, { status: 404 });
    }
  }

  let firstFrameUrl: string | undefined;
  let lastFrameUrl: string | undefined;
  try {
    firstFrameUrl = await toRemoteUsableImage(imageUrl);
    lastFrameUrl = firstFrameUrl ? await toRemoteUsableImage(lastFrameRaw) : undefined;
  } catch (error) {
    rejectBeforeClaim("image_preflight_failed");
    console.error("生视频参考图预处理失败:", safeGenerationErrorMessage(error));
    return NextResponse.json({ error: "参考图片处理失败，请更换图片后重试" }, { status: 400 });
  }
  const mode: VideoOptions["mode"] =
    body.mode === "text-to-video" || !firstFrameUrl ? "text-to-video" : "image-to-video";
  const options = sanitizeVideoOptions(body.options);

  if (!prompt && !firstFrameUrl) {
    rejectBeforeClaim("invalid_prompt_before_claim");
    return NextResponse.json({ error: "缺少 prompt 或 imageUrl" }, { status: 400 });
  }
  if (prompt.length > 6_000) {
    rejectBeforeClaim("invalid_prompt_before_claim");
    return NextResponse.json({ error: "prompt 过长" }, { status: 400 });
  }

  try {
    const operationId = requestedOperationId || `video:${crypto.randomUUID()}`;
    const itemKey = requestedItemKey || "single";
    const execution = await runGenerationOperationItem(auth.merchant.id, {
      operationKey: operationId,
      operationType,
      itemKey,
      agentId: "videoAgent",
      projectId,
      userLabel: `video:${prompt.slice(0, 32)}`,
      requestHash: hashGenerationRequest({
        projectId,
        mode,
        prompt,
        imageUrl: imageUrl || null,
        lastFrameUrl: lastFrameRaw || null,
        options,
      }),
      persistResult: true,
    }, async (config, _prompt, _usedFallback, context) => {
      if (!config.apiKey) {
        throw new Error("视频模型策略未配置可用凭据，请联系工作人员在后台发布可用策略");
      }
      const provider = createProvider({ name: config.provider, apiKey: config.apiKey, baseUrl: config.baseUrl });
      const selectedModel = videoModelForMode(config, mode);
      context?.reportTelemetry({ effectiveModel: selectedModel });
      try {
        return safeVideoResponse(await provider.generateVideo({
          ...options,
          modelId: selectedModel,
          mode,
          prompt,
          firstFrameUrl,
          lastFrameUrl,
        }));
      } catch (e) {
        // 首尾帧模式失败（尾帧含人脸/flf2v 特有约束等）→ 先退回"仅首帧"用主模型重试，保证不因尾帧优化而更糟
        let finalErr: unknown = e;
        if (lastFrameUrl && canRetryWithoutLastFrame(e)) {
          console.warn("[ai/video] 首尾帧模式失败，退回单首帧重试:", safeGenerationErrorMessage(e));
          try {
            return safeVideoResponse(await provider.generateVideo({
              ...options,
              modelId: selectedModel,
              mode,
              prompt,
              firstFrameUrl,
              lastFrameUrl: undefined,
            }));
          } catch (e2) {
            finalErr = e2;
          }
        }
        // 安全/肖像拦截不能换到更宽松的模型重试；这会绕过供应商的安全策略。
        // 前端可提示用户更换素材，或改用无需真人生成的静态运镜合成。
        if (mode === "image-to-video" && isFaceBlocked(finalErr)) {
          throw new Error("人脸素材未通过视频模型安全校验，请使用静态运镜或更换不含清晰人脸的素材");
        }
        throw finalErr;
      }
    });

    return NextResponse.json({ ...execution.value, operationId: execution.operationId, replayed: execution.replayed });
  } catch (error) {
    if (error instanceof QuotaExceededError) {
      return NextResponse.json({ error: error.message }, { status: 402 });
    }
    if (error instanceof InvalidGenerationOperationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (
      error instanceof GenerationOperationConflictError ||
      error instanceof GenerationItemInProgressError ||
      error instanceof GenerationItemFailedError ||
      error instanceof GenerationItemLeaseLostError
    ) {
      return NextResponse.json({ error: safeGenerationErrorMessage(error) }, {
        status: 409,
        ...(error instanceof GenerationItemInProgressError ? { headers: { "Retry-After": "3" } } : {}),
      });
    }
    console.error("生视频失败:", safeGenerationErrorMessage(error));
    return NextResponse.json(
      { error: safeGenerationErrorMessage(error, "视频生成失败，请稍后重试") },
      { status: 500 }
    );
  }
}
