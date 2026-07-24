import { NextRequest, NextResponse } from "next/server";
import { requireMerchant, requireOwnedProject } from "@backend/core/auth/require-merchant";
import { consumeExpensiveRouteRateLimit, EXPENSIVE_RATE_LIMIT_PRESETS, rateLimitResponse } from "@backend/core/security/rate-limit";
import { runAgentOperation } from "@backend/core/agent/agent-strategy";
import { analyzeProduct, extractJSON, parseJsonLoose } from "@backend/script-engine/generator";
import { parseMetricsOcrResponse, validateImageDataUrl } from "@backend/core/publish/metrics-ocr";
import { redactAgentLogText } from "@server/admin/agents";

const SAFE_ID = /^[a-zA-Z0-9\-]+$/;

/**
 * POST /api/project/[id]/metrics/ocr —— 把平台数据截图识别成数字，返回给前端预填效果回流表单。
 * 只做预填：认出的数字必须经老板核对后再走 POST /metrics 落库，OCR 认错不能直接进库。
 * body: { image: "data:image/png;base64,..." }
 *
 * 不计生成配额：数据回流是飞轮最薄弱的一环（商家忙、手填依从性低），回填是我们求着老板做的事，
 * 再扣他额度只会让飞轮更转不动；单张图 + max_tokens 上限已把平台侧成本封死（同 publish-ranker 的先例）。
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireMerchant(req);
  if ("error" in auth) return auth.error;
  const limit = consumeExpensiveRouteRateLimit(req, auth.merchant.id, "project:metrics-ocr", EXPENSIVE_RATE_LIMIT_PRESETS.auxiliaryModel);
  if (!limit.allowed) return rateLimitResponse(limit, "截图识别请求过于频繁，请稍后再试");
  const { id } = await params;
  if (!id || !SAFE_ID.test(id)) return NextResponse.json({ error: "无效的项目ID" }, { status: 400 });
  const owned = await requireOwnedProject(auth.merchant.id, id);
  if ("error" in owned) return owned.error;

  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    /* 落到下方校验统一报错 */
  }
  const checked = validateImageDataUrl(body.image);
  if (!checked.ok) return NextResponse.json({ error: checked.reason }, { status: 400 });

  try {
    const parsed = await runAgentOperation("metrics-ocr", id, async (config, systemPrompt) => {
      const raw = await analyzeProduct([checked.image], { ...config, timeoutMs: 20000, maxTokens: 400 }, systemPrompt);
      return parseJsonLoose(extractJSON(raw));
    });
    const result = parseMetricsOcrResponse(parsed);
    if (!result) {
      // 一个数字都没认出（截图不清楚/不是数据页）：明确告知，别拿一排 0 预填误导保存
      return NextResponse.json({ error: "没认出数字，换张更清楚的数据截图，或直接手动填写" }, { status: 422 });
    }
    return NextResponse.json(result);
  } catch (error) {
    console.warn("数据截图识别失败:", redactAgentLogText(error instanceof Error ? error.message : error));
    return NextResponse.json({ error: "AI 识别暂时不可用，先手动填一下吧" }, { status: 502 });
  }
}
