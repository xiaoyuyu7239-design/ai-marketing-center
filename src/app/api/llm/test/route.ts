import { NextRequest, NextResponse } from "next/server";

/**
 * 服务端测试 LLM 连接。
 * 必须走服务端：浏览器直连厂商 API 会被 CORS 拦截，导致即便 Key 正确也误报"连接失败"。
 *
 * 注意：只测 /models 会把“Key 可用但当前模型/推理接入点不可用”误判为成功。
 * 因此这里直接用当前 model 发一次极小的 OpenAI-compatible chat 请求，和脚本生成路径保持一致。
 */
function arkEndpointHint(baseUrl: string, errorText: string) {
  if (!/ark\.cn-.*volces\.com|volces\.com\/api\/v3/i.test(baseUrl)) return "";
  if (!/InvalidEndpointOrModel|endpoint|model|not found|not exist|404/i.test(errorText)) return "";
  return "。火山方舟的 model 字段通常要填写控制台创建的「推理接入点 ID」（一般以 ep- 开头），不是模型展示名；请把文本模型/视觉模型改成你的接入点 ID。";
}

async function readProviderError(resp: Response) {
  const text = await resp.text().catch(() => "");
  if (!text) return `${resp.status} ${resp.statusText}`;
  try {
    const data = JSON.parse(text) as { error?: { message?: string }; message?: string };
    return data.error?.message || data.message || text.slice(0, 500);
  } catch {
    return text.slice(0, 500);
  }
}

export async function POST(req: NextRequest) {
  try {
    const { baseUrl, apiKey, model } = await req.json();
    if (!baseUrl || !apiKey || !model) {
      return NextResponse.json({ ok: false, error: "缺少 baseUrl、apiKey 或 model" }, { status: 400 });
    }

    const cleanBase = String(baseUrl).replace(/\/$/, "");
    const cleanModel = String(model).trim();
    const url = `${cleanBase}/chat/completions`;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve("timeout");
      }, 8000);
    });
    const request = fetch(url, {
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
      signal: controller.signal,
    }).catch((e) => {
      if (e instanceof Error && e.name === "AbortError") return "timeout" as const;
      throw e;
    });
    const result = await Promise.race([request, timeout]);
    if (timer) clearTimeout(timer);
    if (result === "timeout") {
      return NextResponse.json({
        ok: false,
        error: "连接测试超时：服务端 8 秒内没有响应，请稍后重试或检查 Ark 接入点/网络。",
      });
    }
    const resp = result;

    if (resp.ok) {
      return NextResponse.json({ ok: true });
    }
    const text = await readProviderError(resp);
    return NextResponse.json({
      ok: false,
      status: resp.status,
      error: `${resp.status} ${resp.statusText}${text ? ` - ${text}` : ""}${arkEndpointHint(cleanBase, text)}`,
    });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      error: error instanceof Error ? error.message : "连接失败",
    });
  }
}
