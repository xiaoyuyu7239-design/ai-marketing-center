import { NextRequest, NextResponse } from "next/server";
import { createProvider } from "@backend/providers";
import { toRemoteUsableImage } from "@backend/shared/remote-image";
import { runAgentOperation, type AgentRuntimeConfig } from "@server/admin/agents";
import type { ImageOptions, ImageResult } from "@backend/providers/types";

const VOLCENGINE_IMAGE_FALLBACKS: Record<string, string[]> = {
  "doubao-seedream-5-0-260128": ["doubao-seedream-4-0-250828"],
};

type ImageRouteResult = ImageResult & { warning?: string };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isArkModelNotOpen(message: string): boolean {
  return /ModelNotOpen|not activated the model|activate the model service/i.test(message);
}

function modelLabel(model: string): string {
  if (model.includes("seedream-5")) return "Seedream 5.0";
  if (model.includes("seedream-4")) return "Seedream 4.0";
  if (model.includes("gpt-image-2")) return "GPT Image 2";
  return "当前图片模型";
}

function formatImageError(providerName: string, model: string, raw: string): string {
  if (raw.startsWith("图片模型策略未配置")) return raw;
  if (providerName === "volcengine" && isArkModelNotOpen(raw)) {
    return `${modelLabel(model)} 未开通，请联系工作人员在后台切换或开通图片模型。`;
  }
  return raw;
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

function safeImageResponse(result: ImageRouteResult) {
  return {
    imageUrls: result.imageUrls,
    duration: result.duration,
    seed: result.seed,
    ...(result.warning ? { warning: result.warning } : {}),
  };
}

// AI 生图：普通用户端只传业务参数，provider/model/apiKey/baseUrl 由 imageAgent 线上策略决定。
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  const imageUrl = typeof body.imageUrl === "string" ? body.imageUrl : undefined;
  const referenceImageUrl = await toRemoteUsableImage(imageUrl);
  const mode: ImageOptions["mode"] =
    body.mode === "image-to-image" && referenceImageUrl ? "image-to-image" : "text-to-image";
  const options = body.options && typeof body.options === "object" ? body.options as Record<string, unknown> : {};

  if (!prompt) {
    return NextResponse.json({ error: "缺少 prompt" }, { status: 400 });
  }

  try {
    const result = await runAgentOperation("imageAgent", `image:${prompt.slice(0, 32)}`, async (config) => {
      if (!config.apiKey) {
        throw new Error("图片模型策略未配置可用凭据，请联系工作人员在后台发布可用策略");
      }
      const provider = createProvider({ name: config.provider, apiKey: config.apiKey, baseUrl: config.baseUrl });
      const selectedModel = imageModelForMode(config, mode);
      const buildRequest = (modelId: string): ImageOptions => ({
        modelId,
        mode,
        prompt,
        referenceImageUrl,
        ...options,
      });

      try {
        return await provider.generateImage(buildRequest(selectedModel));
      } catch (error) {
        const raw = errorMessage(error);
        const fallbacks = config.provider === "volcengine" && isArkModelNotOpen(raw)
          ? VOLCENGINE_IMAGE_FALLBACKS[selectedModel] ?? []
          : [];
        if (fallbacks.length === 0) throw error;

        let fallbackError = raw;
        for (const fallbackModel of fallbacks) {
          try {
            const fallbackResult = await provider.generateImage(buildRequest(fallbackModel)) as ImageRouteResult;
            fallbackResult.warning = `${modelLabel(selectedModel)} 未开通，已自动使用备用图片模型。`;
            return fallbackResult;
          } catch (e) {
            fallbackError = errorMessage(e);
          }
        }
        throw new Error(`${formatImageError(config.provider, selectedModel, raw)}；备用图片模型也失败：${formatImageError(config.provider, fallbacks.at(-1) ?? selectedModel, fallbackError)}`);
      }
    });

    return NextResponse.json(safeImageResponse(result as ImageRouteResult));
  } catch (error) {
    console.error("生图失败:", error);
    const msg = errorMessage(error);
    return NextResponse.json(
      { error: msg },
      { status: 500 }
    );
  }
}
