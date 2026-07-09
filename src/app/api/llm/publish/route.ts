import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import { extractJSON } from "@backend/script-engine/generator";
import { buildPublishPrompt } from "@backend/core/publish/publish-pack";
import { runAgentOperation } from "@backend/core/agent/agent-strategy";

/**
 * 生成发布文案：标题（3 个）、#话题标签、一句话种草文案。
 * 用于带货视频发布到抖音/快手/小红书时直接复制。
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { productName, productDescription, category, platform, locale } = body;

    if (!productName) {
      return NextResponse.json({ error: "缺少商品名称" }, { status: 400 });
    }

    const parsed = await runAgentOperation("publish-copy", String(productName), async (config, systemPrompt) => {
      const client = new OpenAI({ baseURL: config.baseUrl, apiKey: config.apiKey || "no-key" });
      const en = locale === "en";
      const prompt = buildPublishPrompt({ productName, category, productDescription, platform }, en ? "en" : "zh");

      const resp = await client.chat.completions.create({
        model: config.model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: prompt },
        ],
        temperature: 0.9,
        max_tokens: 1200,
      });

      const content = resp.choices[0]?.message?.content;
      if (!content) throw new Error("LLM 未返回内容");
      return JSON.parse(extractJSON(content)) as {
        titles?: string[];
        hashtags?: string[];
        caption?: string;
      };
    });

    return NextResponse.json({
      titles: Array.isArray(parsed.titles) ? parsed.titles.slice(0, 3) : [],
      hashtags: Array.isArray(parsed.hashtags) ? parsed.hashtags : [],
      caption: parsed.caption ?? "",
    });
  } catch (error) {
    console.error("生成发布文案失败:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "生成失败" },
      { status: 500 }
    );
  }
}
