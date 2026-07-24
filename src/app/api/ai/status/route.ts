import { NextRequest, NextResponse } from "next/server";
import { createProvider, toSafeProviderErrorDto } from "@backend/providers";
import { getAgentOperationReadiness, getAgentStrategy } from "@server/admin/agents";
import { requireMerchant } from "@backend/core/auth/require-merchant";
import { isAdminOrDesktopRequest } from "@server/admin/admin-auth";
import { AUTHENTICATED_IP_RATE_LIMIT_PRESETS, consumeAuthenticatedIpRateLimit, rateLimitResponse } from "@backend/core/security/rate-limit";

export async function GET(req: NextRequest) {
  const auth = await requireMerchant(req);
  if ("error" in auth) return auth.error;
  const state = await getAgentStrategy();
  return NextResponse.json({
    imageReady: getAgentOperationReadiness(state, "imageAgent").ready,
    videoReady: getAgentOperationReadiness(state, "videoAgent").ready,
    ttsReady: getAgentOperationReadiness(state, "ttsAgent").ready,
  }, { headers: { "Cache-Control": "no-store" } });
}

// 查询 AI 任务状态（生图/生视频是异步的）
export async function POST(req: NextRequest) {
  if (!isAdminOrDesktopRequest(req)) {
    return NextResponse.json({ error: "无权访问" }, { status: 403 });
  }
  const limit = consumeAuthenticatedIpRateLimit(req, "ai:provider-status", AUTHENTICATED_IP_RATE_LIMIT_PRESETS.providerProbe);
  if (!limit.allowed) return rateLimitResponse(limit, "供应商任务查询过于频繁，请稍后再试");
  const body = await req.json();
  const { provider: providerName, taskId, apiKey, baseUrl } = body;

  if (!providerName || !taskId) {
    return NextResponse.json({ error: "缺少必要参数" }, { status: 400 });
  }

  if (!apiKey) {
    return NextResponse.json({ error: "缺少 API Key，请先在设置中配置对应平台" }, { status: 400 });
  }

  try {
    const provider = createProvider({ name: providerName, apiKey, baseUrl });
    const status = await provider.getTaskStatus(taskId);
    return NextResponse.json(status);
  } catch (error) {
    const detail = toSafeProviderErrorDto(error, "查询任务状态失败，请稍后重试");
    // 日志也只记录安全 DTO，不打印可能夹带供应商原始响应的 Error 对象。
    console.error("查询任务状态失败:", {
      code: detail.code,
      category: detail.category,
      requestId: detail.requestId,
    });
    return NextResponse.json(
      { error: detail.message, detail },
      {
        status: detail.category === "rate_limit" ? 429 : 502,
        ...(detail.retryAfterSeconds !== undefined
          ? { headers: { "Retry-After": String(detail.retryAfterSeconds) } }
          : {}),
      },
    );
  }
}
