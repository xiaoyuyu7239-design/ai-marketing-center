import { NextRequest, NextResponse } from "next/server";
import { generateSpeech, type TTSConfig } from "@backend/core/media/tts";
import { isAdminOrDesktopRequest } from "@server/admin/admin-auth";
import { redactAgentLogText } from "@server/admin/agents";
import { AUTHENTICATED_IP_RATE_LIMIT_PRESETS, consumeAuthenticatedIpRateLimit, rateLimitResponse } from "@backend/core/security/rate-limit";

// TTS 配音试听：返回 mp3 音频字节，供前端预览音色
export async function POST(req: NextRequest) {
  if (!isAdminOrDesktopRequest(req)) {
    return NextResponse.json({ error: "无权访问" }, { status: 403 });
  }
  const limit = consumeAuthenticatedIpRateLimit(req, "tts:paid-preview", AUTHENTICATED_IP_RATE_LIMIT_PRESETS.paidTtsPreview);
  if (!limit.allowed) return rateLimitResponse(limit, "付费配音试听过于频繁，请稍后再试");
  try {
    const body = await req.json();
    const { text, ttsConfig } = body as { text?: string; ttsConfig?: TTSConfig };

    if (!text) {
      return NextResponse.json({ error: "缺少配音文本" }, { status: 400 });
    }
    if (!ttsConfig?.baseUrl || !ttsConfig?.apiKey || !ttsConfig?.model || !ttsConfig?.voice) {
      return NextResponse.json(
        { error: "请先在设置中配置 TTS（baseUrl、apiKey、model、voice）" },
        { status: 400 }
      );
    }

    const audio = await generateSpeech(text, ttsConfig);
    return new NextResponse(new Uint8Array(audio), {
      headers: {
        "Content-Type": "audio/mpeg",
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    console.error("TTS 失败:", redactAgentLogText(error instanceof Error ? error.message : error));
    return NextResponse.json(
      { error: "TTS 生成失败，请检查后台模型配置与服务状态" },
      { status: 500 }
    );
  }
}
