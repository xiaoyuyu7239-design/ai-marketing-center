import { NextRequest, NextResponse } from "next/server";
import { createProvider } from "@backend/providers";
import type { MediaType, Model } from "@backend/providers/types";
import { isAdminOrDesktopRequest } from "@server/admin/admin-auth";
import { AUTHENTICATED_IP_RATE_LIMIT_PRESETS, consumeAuthenticatedIpRateLimit, rateLimitResponse } from "@backend/core/security/rate-limit";

/**
 * 聚合各启用平台的可用模型列表
 * 供前端（设置页默认模型选择、素材/视频生成入口）拉取并展示可选模型
 *
 * 请求体：
 *   { providers: [{ name, apiKey?, baseUrl? }], mediaType?: 'image' | 'video' }
 * 返回：
 *   { models: Model[] }  // 已按 provider 聚合
 */
export async function POST(req: NextRequest) {
  if (!isAdminOrDesktopRequest(req)) {
    return NextResponse.json({ error: "无权访问" }, { status: 403 });
  }
  const limit = consumeAuthenticatedIpRateLimit(req, "ai:list-models", AUTHENTICATED_IP_RATE_LIMIT_PRESETS.providerProbe);
  if (!limit.allowed) return rateLimitResponse(limit, "模型列表刷新过于频繁，请稍后再试");
  const body = await req.json();
  const providers = (body.providers ?? []) as Array<{
    name: string;
    apiKey?: string;
    baseUrl?: string;
  }>;
  const mediaType = body.mediaType as MediaType | undefined;

  if (!Array.isArray(providers) || providers.length === 0) {
    return NextResponse.json({ models: [] });
  }

  // 并发拉取每个平台的模型列表，单个平台失败不影响其他平台
  const results = await Promise.allSettled(
    providers.map(async (p) => {
      const provider = createProvider({
        name: p.name,
        apiKey: p.apiKey ?? "",
        baseUrl: p.baseUrl ?? "",
      });
      return provider.listModels(mediaType);
    })
  );

  const models: Model[] = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled") {
      models.push(...r.value);
    } else {
      console.warn(`获取 ${providers[i]?.name} 模型列表失败:`, r.reason);
    }
  });

  return NextResponse.json({ models });
}
