import { NextRequest, NextResponse } from "next/server";
import { createProvider } from "@backend/providers";
import { toRemoteUsableImage } from "@backend/shared/remote-image";
import { runAgentOperation, type AgentRuntimeConfig } from "@server/admin/agents";
import type { VideoOptions, VideoResult } from "@backend/providers/types";

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
  const body = await req.json().catch(() => ({}));
  const prompt = typeof body.prompt === "string" ? body.prompt : "";
  const imageUrl = typeof body.imageUrl === "string" ? body.imageUrl : undefined;
  const firstFrameUrl = await toRemoteUsableImage(imageUrl);
  const mode: VideoOptions["mode"] =
    body.mode === "text-to-video" || !firstFrameUrl ? "text-to-video" : "image-to-video";
  const options = body.options && typeof body.options === "object" ? body.options as Record<string, unknown> : {};

  if (!prompt && !firstFrameUrl) {
    return NextResponse.json({ error: "缺少 prompt 或 imageUrl" }, { status: 400 });
  }

  try {
    const result = await runAgentOperation("videoAgent", `video:${prompt.slice(0, 32)}`, async (config) => {
      if (!config.apiKey) {
        throw new Error("视频模型策略未配置可用凭据，请联系工作人员在后台发布可用策略");
      }
      const provider = createProvider({ name: config.provider, apiKey: config.apiKey, baseUrl: config.baseUrl });
      return provider.generateVideo({
        modelId: videoModelForMode(config, mode),
        mode,
        prompt,
        firstFrameUrl,
        ...options,
      });
    });

    return NextResponse.json(safeVideoResponse(result));
  } catch (error) {
    console.error("生视频失败:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "生视频失败" },
      { status: 500 }
    );
  }
}
