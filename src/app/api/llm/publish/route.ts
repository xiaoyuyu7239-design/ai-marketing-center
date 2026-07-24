import { NextRequest, NextResponse } from "next/server";
import { createSafeOpenAIClient } from "@backend/shared/openai-client";
import { extractJSON, arkThinkingOff } from "@backend/script-engine/generator";
import { buildPublishPrompt } from "@backend/core/publish/publish-pack";
import { buildLocalTagPack, parseCustomTags, type LocalTagPack } from "@backend/core/publish/local-tags";
import { requireMerchant } from "@backend/core/auth/require-merchant";
import {
  consumeExpensiveRouteRateLimit,
  EXPENSIVE_RATE_LIMIT_PRESETS,
  rateLimitResponse,
} from "@backend/core/security/rate-limit";
import { getMerchantProfile } from "@backend/core/auth/merchant-profile";
import {
  runMeteredAgentOperation,
  QuotaExceededError,
  safeGenerationErrorMessage,
} from "@backend/core/auth/usage";

/**
 * 生成发布文案：标题（3 个）、#话题标签、一句话种草文案。
 * 用于带货视频发布到抖音/快手/小红书时直接复制。
 * 本地门店商家（建档 storeType=local/both）自动走同城形态：
 * 标题带城市/商圈锚点、话题按同城梯度、CTA 是到店动作，并强制并入商家绑定标签 + 返回 POI 发布清单。
 */
export async function POST(req: NextRequest) {
  const auth = await requireMerchant(req);
  if ("error" in auth) return auth.error;
  const limit = consumeExpensiveRouteRateLimit(req, auth.merchant.id, "llm:publish", EXPENSIVE_RATE_LIMIT_PRESETS.auxiliaryModel);
  if (!limit.allowed) return rateLimitResponse(limit, "发布文案生成过于频繁，请稍后再试");
  try {
    const body = await req.json();
    const { productName, productDescription, category, platform, locale } = body;

    if (!productName) {
      return NextResponse.json({ error: "缺少商品名称" }, { status: 400 });
    }

    // 本地门店画像 → 同城发布形态（服务端注入，不信任客户端传参）
    const profile = await getMerchantProfile(auth.merchant.id).catch(() => null);
    const isLocalStore = profile?.storeType === "local" || profile?.storeType === "both";
    const localStore = isLocalStore
      ? {
          city: profile?.region,
          landmark: profile?.landmark,
          shopName: profile?.shopName,
          storeAddress: profile?.storeAddress,
          customTags: profile?.customTags,
        }
      : undefined;
    const localPack: LocalTagPack | null = localStore
      ? buildLocalTagPack(localStore, { category, platform })
      : null;

    const parsed = await runMeteredAgentOperation(auth.merchant.id, "publish-copy", String(productName), async (config, systemPrompt) => {
      const client = createSafeOpenAIClient({ baseURL: config.baseUrl, apiKey: config.apiKey || "no-key" });
      const en = locale === "en";
      const prompt = buildPublishPrompt(
        { productName, category, productDescription, platform, localStore },
        en ? "en" : "zh"
      );

      const resp = await client.chat.completions.create(arkThinkingOff({
        model: config.model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: prompt },
        ],
        temperature: 0.9,
        max_tokens: 1200,
      }, config.baseUrl));

      const content = resp.choices[0]?.message?.content;
      if (!content) throw new Error("LLM 未返回内容");
      return JSON.parse(extractJSON(content)) as {
        titles?: string[];
        hashtags?: string[];
        caption?: string;
      };
    });

    // 标签化绑定的兜底：商家绑定标签 + 同城锚点标签必须出现在最终话题里（LLM 漏了就并入）
    let hashtags = Array.isArray(parsed.hashtags) ? parsed.hashtags.filter((h): h is string => typeof h === "string") : [];
    if (localStore) {
      const seen = new Set(hashtags);
      const mustHave = [
        ...parseCustomTags(localStore.customTags).map((t) => `#${t}`),
        ...(localPack?.hashtags.slice(0, 4) ?? []),
      ];
      for (const tag of mustHave) {
        if (seen.has(tag)) continue;
        seen.add(tag);
        hashtags.push(tag);
      }
      hashtags = hashtags.slice(0, 12);
    }

    return NextResponse.json({
      titles: Array.isArray(parsed.titles) ? parsed.titles.slice(0, 3) : [],
      hashtags,
      caption: parsed.caption ?? "",
      // 同城发布信息（本地门店专属）：POI 清单 + 锚点说明 + 完整标签梯度，导出页展示
      ...(localPack && { local: localPack }),
    });
  } catch (error) {
    if (error instanceof QuotaExceededError) {
      return NextResponse.json({ error: error.message }, { status: 402 });
    }
    console.error("生成发布文案失败:", safeGenerationErrorMessage(error));
    return NextResponse.json(
      { error: safeGenerationErrorMessage(error, "发布文案生成失败，请稍后重试") },
      { status: 500 }
    );
  }
}
