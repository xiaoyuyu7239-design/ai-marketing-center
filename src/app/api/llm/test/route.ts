import { NextRequest, NextResponse } from "next/server";
import { isAdminOrDesktopRequest } from "@server/admin/admin-auth";
import { safeFetch } from "@backend/shared/ssrf-guard";
import { AUTHENTICATED_IP_RATE_LIMIT_PRESETS, consumeAuthenticatedIpRateLimit, rateLimitResponse } from "@backend/core/security/rate-limit";

/**
 * 服务端测试 LLM 连接。
 * 必须走服务端：浏览器直连厂商 API 会被 CORS 拦截，导致即便 Key 正确也误报"连接失败"。
 *
 * 注意：只测 /models 会把“Key 可用但当前模型/推理接入点不可用”误判为成功。
 * 因此这里直接用当前 model 发一次极小的 OpenAI-compatible chat 请求，和脚本生成路径保持一致。
 */
function arkEndpointHint(baseUrl: string, status: number) {
  if (!/ark\.cn-.*volces\.com|volces\.com\/api\/v3/i.test(baseUrl)) return "";
  if (![400, 404, 422].includes(status)) return "";
  return "。火山方舟的 model 字段通常要填写控制台创建的「推理接入点 ID」（一般以 ep- 开头），不是模型展示名；请把文本模型/视觉模型改成你的接入点 ID。";
}

export async function POST(req: NextRequest) {
  if (!isAdminOrDesktopRequest(req)) {
    return NextResponse.json({ ok: false, error: "无权访问" }, { status: 403 });
  }
  const limit = consumeAuthenticatedIpRateLimit(req, "llm:test", AUTHENTICATED_IP_RATE_LIMIT_PRESETS.providerProbe);
  if (!limit.allowed) return rateLimitResponse(limit, "模型连接测试过于频繁，请稍后再试");
  try {
    const { baseUrl, apiKey, model } = await req.json();
    if (!baseUrl || !apiKey || !model) {
      return NextResponse.json({ ok: false, error: "缺少 baseUrl、apiKey 或 model" }, { status: 400 });
    }

    const cleanBase = String(baseUrl).replace(/\/$/, "");
    const parsedBase = new URL(cleanBase);
    if (parsedBase.protocol !== "https:" || parsedBase.username || parsedBase.password) {
      return NextResponse.json({ ok: false, error: "模型地址必须是无内嵌凭据的 HTTPS URL" }, { status: 400 });
    }
    const cleanModel = String(model).trim();
    const url = `${cleanBase}/chat/completions`;
    const resp = await safeFetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: cleanModel,
        messages: [{ role: "user", content: "Reply with OK." }],
        temperature: 0,
        max_tokens: 1,
      }),
      signal: AbortSignal.timeout(8000),
    }, 0, {
      allowedProtocols: ["https:"],
      allowedHosts: [parsedBase.hostname],
      allowedPorts: [parsedBase.port],
    });

    if (resp.ok) {
      await resp.body?.cancel("provider-probe-complete").catch(() => undefined);
      return NextResponse.json({ ok: true });
    }
    await resp.body?.cancel("provider-probe-error").catch(() => undefined);
    return NextResponse.json({
      ok: false,
      status: resp.status,
      error: `供应商返回 HTTP ${resp.status}${arkEndpointHint(cleanBase, resp.status)}`,
    });
  } catch {
    return NextResponse.json({
      ok: false,
      error: "连接测试失败，请检查模型地址、网络和证书配置",
    });
  }
}
