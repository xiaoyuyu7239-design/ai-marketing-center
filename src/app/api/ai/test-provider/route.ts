import { NextRequest, NextResponse } from "next/server";
import { isAdminOrDesktopRequest } from "@server/admin/admin-auth";
import { safeFetch } from "@backend/shared/ssrf-guard";
import { AUTHENTICATED_IP_RATE_LIMIT_PRESETS, consumeAuthenticatedIpRateLimit, rateLimitResponse } from "@backend/core/security/rate-limit";

/**
 * AI 平台 Key 连通性校验（生图/生视频平台）。
 * 各平台用最便宜的「鉴权先过」端点探针：
 * - 2xx → ok（Key 有效）
 * - 401/403 → invalid（Key 无效）
 * - 其它(404/400/5xx/网络) → unknown（无法判定，可直接试生成）
 * 走服务端发起，绕开浏览器 CORS；只读探针，不产生计费生成。
 */

const DEFAULT_BASE: Record<string, string> = {
  "atlas-cloud": "https://api.atlascloud.ai/api/v1",
  "fal-ai": "https://queue.fal.run",
  replicate: "https://api.replicate.com/v1",
  volcengine: "https://ark.cn-beijing.volces.com/api/v3",
  alibaba: "https://dashscope.aliyuncs.com/api/v1",
  siliconflow: "https://api.siliconflow.cn/v1",
};

type Probe = { url: string; headers: Record<string, string>; authFirst?: boolean };

function buildProbe(name: string, apiKey: string, baseUrl?: string): Probe {
  const base = (baseUrl || DEFAULT_BASE[name] || "").replace(/\/$/, "");
  if (name === "fal-ai") {
    // fal 先校验鉴权再解析 request id：到达 404/422 即说明 Key 有效
    return {
      url: `${base}/fal-ai/flux/requests/00000000-0000-0000-0000-000000000000/status`,
      headers: { Authorization: `Key ${apiKey}` },
      authFirst: true,
    };
  }
  if (name === "replicate") {
    return { url: `${base}/account`, headers: { Authorization: `Bearer ${apiKey}` } };
  }
  if (name === "alibaba") {
    // dashscope 原生无 /models，用 OpenAI 兼容模式的 /models 验 Key
    return { url: `https://dashscope.aliyuncs.com/compatible-mode/v1/models`, headers: { Authorization: `Bearer ${apiKey}` } };
  }
  // siliconflow / volcengine / atlas-cloud / 自定义 OpenAI 兼容：GET /models
  return { url: `${base}/models`, headers: { Authorization: `Bearer ${apiKey}` } };
}

export async function POST(req: NextRequest) {
  if (!isAdminOrDesktopRequest(req)) {
    return NextResponse.json({ status: "unknown", message: "无权访问" }, { status: 403 });
  }
  const limit = consumeAuthenticatedIpRateLimit(req, "ai:test-provider", AUTHENTICATED_IP_RATE_LIMIT_PRESETS.providerProbe);
  if (!limit.allowed) return rateLimitResponse(limit, "供应商连接测试过于频繁，请稍后再试");
  let body: { name?: string; apiKey?: string; baseUrl?: string } = {};
  try {
    body = await req.json();
  } catch {
    /* 空 body */
  }
  const { name, apiKey, baseUrl } = body;
  if (!name || !apiKey) {
    return NextResponse.json({ status: "unknown", message: "缺少平台或 Key" }, { status: 400 });
  }

  const probe = buildProbe(name, apiKey, baseUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const parsed = new URL(probe.url);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
      return NextResponse.json({ status: "unknown", message: "模型地址必须是无内嵌凭据的 HTTPS URL" }, { status: 400 });
    }
    const r = await safeFetch(
      probe.url,
      { method: "GET", headers: probe.headers, signal: controller.signal },
      0,
      {
        allowedProtocols: ["https:"],
        allowedHosts: [parsed.hostname],
        allowedPorts: [parsed.port],
      },
    );
    if (r.status === 401 || r.status === 403) {
      await r.body?.cancel("provider-probe-invalid").catch(() => undefined);
      return NextResponse.json({ status: "invalid", message: "Key 无效或无权限" });
    }
    if (r.ok || probe.authFirst) {
      // authFirst 平台：非 401/403 即视为鉴权通过
      await r.body?.cancel("provider-probe-complete").catch(() => undefined);
      return NextResponse.json({ status: "ok", message: "连接正常" });
    }
    await r.body?.cancel("provider-probe-unknown").catch(() => undefined);
    return NextResponse.json({ status: "unknown", message: `无法判定（HTTP ${r.status}），可直接试生成` });
  } catch (e) {
    const aborted = e instanceof Error && e.name === "AbortError";
    return NextResponse.json({ status: "unknown", message: aborted ? "超时，无法判定" : "网络异常，无法判定" });
  } finally {
    clearTimeout(timer);
  }
}
