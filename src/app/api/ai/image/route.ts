import { NextRequest, NextResponse } from "next/server";
import { createProvider } from "@backend/providers";
import { toRemoteUsableImage } from "@backend/shared/remote-image";
import type { AgentRuntimeConfig } from "@server/admin/agents";
import type { ImageOptions, ImageResult } from "@backend/providers/types";
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

/** 用户只能调整成本有上限的公开参数；模型、模式、引用图与生成数量由服务端固定。 */
function sanitizeImageOptions(value: unknown): Partial<ImageOptions> {
  const raw = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const width = boundedNumber(raw.width, 256, 2_048, true);
  const height = boundedNumber(raw.height, 256, 2_048, true);
  const validSize = width != null && height != null && width * height <= 4_194_304;
  const negativePrompt = typeof raw.negativePrompt === "string"
    ? raw.negativePrompt.trim().slice(0, 2_000)
    : "";
  return {
    ...(validSize ? { width, height } : {}),
    count: 1,
    ...(boundedNumber(raw.guidanceScale, 0, 30) != null
      ? { guidanceScale: boundedNumber(raw.guidanceScale, 0, 30) }
      : {}),
    ...(boundedNumber(raw.steps, 1, 100, true) != null
      ? { steps: boundedNumber(raw.steps, 1, 100, true) }
      : {}),
    ...(boundedNumber(raw.seed, 0, Number.MAX_SAFE_INTEGER, true) != null
      ? { seed: boundedNumber(raw.seed, 0, Number.MAX_SAFE_INTEGER, true) }
      : {}),
    ...(negativePrompt ? { negativePrompt } : {}),
  };
}

function imageModelForMode(config: AgentRuntimeConfig, mode: ImageOptions["mode"]) {
  const model = config.model;
  if (mode !== "image-to-image") return model;
  if (config.provider === "atlas-cloud" && model === "openai/gpt-image-2/text-to-image") return "openai/gpt-image-2/edit";
  if (config.provider === "fal-ai" && model === "openai/gpt-image-2") return "openai/gpt-image-2/image-to-image";
  if (model === "fal-ai/gpt-image-1.5") return "fal-ai/gpt-image-1.5/edit";
  if (model.startsWith("black-forest-labs/flux") && !model.includes("kontext")) return "black-forest-labs/flux-kontext-pro";
  if (model.endsWith("/text-to-image")) return model.replace("/text-to-image", "/image-to-image");
  return model;
}

function safeImageResponse(result: ImageResult) {
  return {
    imageUrls: result.imageUrls,
    duration: result.duration,
    seed: result.seed,
  };
}

// AI 生图：普通用户端只传业务参数，provider/model/apiKey/baseUrl 由 imageAgent 线上策略决定。
export async function POST(req: NextRequest) {
  const auth = await requireMerchant(req);
  if ("error" in auth) return auth.error;
  const body = await req.json().catch(() => ({}));
  const projectId = typeof body.projectId === "string" ? body.projectId.trim() : "";
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  const imageUrl = typeof body.imageUrl === "string" ? body.imageUrl : undefined;
  const requestedOperationId = typeof body.operationId === "string" ? body.operationId.trim() : "";
  const requestedItemKey = typeof body.itemKey === "string" ? body.itemKey.trim() : "";
  const operationType = body.operationType === "image-batch" ? "image-batch" : "image-single";

  if (!projectId) {
    return NextResponse.json({ error: "缺少 projectId" }, { status: 400 });
  }
  if (Boolean(requestedOperationId) !== Boolean(requestedItemKey)) {
    return NextResponse.json({ error: "operationId 与 itemKey 必须同时提供" }, { status: 400 });
  }
  if (requestedOperationId && body.operationType !== "image-batch" && body.operationType !== "image-single") {
    return NextResponse.json({ error: "operationType 不合法" }, { status: 400 });
  }
  const rejectBeforeClaim = (failureCode: string) => {
    if (!requestedOperationId || !requestedItemKey || !projectId) return;
    try {
      failGenerationOperationItemBeforeClaim(auth.merchant.id, {
        operationKey: requestedOperationId,
        operationType,
        itemKey: requestedItemKey,
        agentId: "imageAgent",
        projectId,
        failureCode,
      });
    } catch {
      // 拒绝请求的对外状态不应被账本收口的内部异常覆盖。
      console.error("[generation] 图片子项在 claim 前收口失败");
    }
  };
  const owned = await requireOwnedProject(auth.merchant.id, projectId);
  if ("error" in owned) return owned.error;
  const limit = consumeExpensiveRouteRateLimit(
    req,
    auth.merchant.id,
    "ai:image",
    EXPENSIVE_RATE_LIMIT_PRESETS.image,
  );
  if (!limit.allowed) {
    rejectBeforeClaim("rate_limit_before_claim");
    return rateLimitResponse(limit, "图片生成过于频繁，请稍后再试");
  }
  if (imageUrl && parseMediaRef(imageUrl) && !mediaRefBelongsToMerchant(imageUrl, auth.merchant.id, projectId)) {
    rejectBeforeClaim("invalid_media_before_claim");
    return NextResponse.json({ error: "参考图片不存在" }, { status: 404 });
  }
  let referenceImageUrl: string | undefined;
  try {
    referenceImageUrl = await toRemoteUsableImage(imageUrl);
  } catch (error) {
    rejectBeforeClaim("image_preflight_failed");
    console.error("生图参考图预处理失败:", safeGenerationErrorMessage(error));
    return NextResponse.json({ error: "参考图片处理失败，请更换图片后重试" }, { status: 400 });
  }
  const mode: ImageOptions["mode"] =
    body.mode === "image-to-image" && referenceImageUrl ? "image-to-image" : "text-to-image";
  const options = sanitizeImageOptions(body.options);

  if (!prompt) {
    rejectBeforeClaim("invalid_prompt_before_claim");
    return NextResponse.json({ error: "缺少 prompt" }, { status: 400 });
  }
  if (prompt.length > 6_000) {
    rejectBeforeClaim("invalid_prompt_before_claim");
    return NextResponse.json({ error: "prompt 过长" }, { status: 400 });
  }

  try {
    const operationId = requestedOperationId || `image:${crypto.randomUUID()}`;
    const itemKey = requestedItemKey || "single";
    const execution = await runGenerationOperationItem(auth.merchant.id, {
      operationKey: operationId,
      operationType,
      itemKey,
      agentId: "imageAgent",
      projectId,
      userLabel: `image:${prompt.slice(0, 32)}`,
      requestHash: hashGenerationRequest({ projectId, mode, prompt, imageUrl: imageUrl || null, options }),
      persistResult: true,
    }, async (config, _prompt, _usedFallback, context) => {
      if (!config.apiKey) {
        throw new Error("图片模型策略未配置可用凭据，请联系工作人员在后台发布可用策略");
      }
      const provider = createProvider({ name: config.provider, apiKey: config.apiKey, baseUrl: config.baseUrl });
      const selectedModel = imageModelForMode(config, mode);
      context.reportTelemetry({ effectiveModel: selectedModel });
      const request: ImageOptions = {
        ...options,
        modelId: selectedModel,
        mode,
        prompt,
        referenceImageUrl,
      };

      // 不在路由内偷偷换模型。任何配置/供应商失败都交回 Agent primary/fallback
      // 控制面分类、留痕与决策，保证成本和实际模型可审计。
      return safeImageResponse(await provider.generateImage(request));
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
    console.error("生图失败:", safeGenerationErrorMessage(error));
    return NextResponse.json(
      { error: safeGenerationErrorMessage(error, "图片生成失败，请稍后重试") },
      { status: 500 }
    );
  }
}
