/**
 * 免 Key 发布文案包 —— 不配 LLM 也能在导出页「复制即发」。
 * 按品类 + 平台映射热门话题标签，用痛点/数字/情绪钩子模板拼标题与种草文案。
 * 本地门店（localStore）走同城形态：标题带城市/商圈锚点、话题用同城标签梯度、CTA 是到店动作。
 * 纯函数、确定性（同输入同输出），可单测；配了 LLM 的用户仍走 /api/llm/publish 拿更优文案。
 */

import { buildLocalTagPack, normalizeCityName, parseCustomTags, type LocalStoreInfo } from "./local-tags";

export interface PublishPack {
  titles: string[];
  hashtags: string[]; // 已带 # 前缀、去重
  caption: string;
}

export interface PublishPackInput {
  productName?: string;
  category?: string; // beauty/food/home/fashion/digital/other
  sellingPoints?: string; // 卖点/描述，可多句
  platform?: string; // douyin/kuaishou/xiaohongshu/tiktok
  locale?: "zh" | "en"; // 文案语言，默认 zh；en 出海用英文标题/话题/CTA（避免英文用户拿到中文文案）
  /** 本地门店信息：存在即走同城发布形态（城市锚点标题 + 同城标签梯度 + 到店 CTA） */
  localStore?: LocalStoreInfo;
}

// 品类热门话题（贴合抖音/快手/小红书带货语境）
const CATEGORY_TAGS: Record<string, string[]> = {
  beauty: ["好物分享", "美妆", "护肤", "变美", "平价好物", "种草"],
  food: ["美食", "好吃推荐", "零食", "吃货日常", "干饭人", "种草"],
  home: ["家居好物", "居家生活", "生活好物", "收纳", "好物推荐", "种草"],
  fashion: ["穿搭", "时尚", "OOTD", "穿搭分享", "好物分享", "种草"],
  digital: ["数码", "数码好物", "科技", "实用好物", "好物推荐", "种草"],
  other: ["好物推荐", "种草", "好物分享", "值得买", "宝藏好物", "日常分享"],
};

// 品类热门话题（英文 TikTok/Reels 带货语境）
const CATEGORY_TAGS_EN: Record<string, string[]> = {
  beauty: ["BeautyTok", "SkincareRoutine", "MakeupHacks", "BeautyFinds", "GlowUp", "TikTokMadeMeBuyIt"],
  food: ["FoodTok", "FoodieFinds", "SnackHaul", "TikTokFood", "MustTry", "TikTokMadeMeBuyIt"],
  home: ["HomeFinds", "HomeHacks", "CleanTok", "OrganizationTips", "CozyHome", "TikTokMadeMeBuyIt"],
  fashion: ["OOTD", "FashionTok", "StyleInspo", "OutfitIdeas", "FashionFinds", "TikTokMadeMeBuyIt"],
  digital: ["TechTok", "GadgetFinds", "TechReview", "CoolGadgets", "Innovation", "TikTokMadeMeBuyIt"],
  other: ["TikTokMadeMeBuyIt", "MustHave", "ProductReview", "WorthIt", "TikTokFinds", "DailyFinds"],
};

// 平台热门话题
const PLATFORM_TAGS: Record<string, string[]> = {
  douyin: ["抖音好物", "抖音电商"],
  kuaishou: ["快手好物", "快手电商"],
  xiaohongshu: ["小红书", "好物推荐"],
  tiktok: ["TikTokMadeMeBuyIt", "TikTokShop"],
};

// 本地门店发布的平台差异提示（同城内容在各平台的标签/话术差异，调研结论规则化）
const LOCAL_PLATFORM_HINTS: Record<string, string> = {
  douyin: "- 抖音：话题最多 5 个（宁精勿多）；CTA 指向'左下角定位/团购'\n",
  kuaishou: "- 快手：口吻更接地气；CTA 指向'左下角定位/团购'\n",
  xiaohongshu:
    "- 小红书：标题写成'搜索题'——植入 区域+品类+场景 关键词（如'西湖区遛娃咖啡店'），正文攻略化、弱促销；CTA 引导收藏/评论问路\n",
  wechat: "- 视频号：信任叙事（老板故事/街坊老店），CTA 引导转发朋友圈/进群\n",
};

// 本地门店标题里的品类动作词（"杭州美食清单+1"式标题用）
const LOCAL_TITLE_WORD: Record<string, string> = {
  food: "美食",
  beauty: "变美",
  fashion: "逛街",
  home: "好店",
  tech: "好店",
  other: "探店",
};

/** 取第一条卖点：按中英标点/换行切，去空白，限长（英文卖点更长，故 max 可调） */
function firstSellingPoint(sp: string | undefined, max: number): string {
  if (!sp) return "";
  const first = sp.split(/[。.,，;；\n、]/).map((s) => s.trim()).find((s) => s.length > 0) || "";
  return clip(first, max);
}

/** 按显示宽度近似裁剪（CJK 记 1，避免标题过长） */
function clip(s: string, max: number): string {
  const arr = Array.from(s.trim());
  return arr.length <= max ? s.trim() : arr.slice(0, max).join("").trim();
}

/**
 * 构建发布文案的 LLM 提示词（配了 LLM 的用户走这条拿更优文案）。
 * 跟随 locale：zh 出中文带货文案，en 出英文 TikTok 文案——避免英文用户的 LLM 输出中文。
 * 纯函数，提示词内容可确定性单测（LLM 输出本身依赖 key，不在此测）。
 */
export function buildPublishPrompt(
  input: {
    productName: string;
    category?: string;
    productDescription?: string;
    platform?: string;
    /** 本地门店信息：注入同城发布要求（城市锚点标题/同城标签梯度/到店 CTA/绑定标签必带） */
    localStore?: LocalStoreInfo;
  },
  locale: "zh" | "en" = "zh"
): string {
  const { productName, category, productDescription, platform, localStore } = input;
  if (locale === "en") {
    const platformHint = platform ? `Target platform: ${platform}.` : "Target platform: TikTok / Reels / Shorts.";
    return `You are a seasoned e-commerce short-video marketer. Write publishing copy for the product below, entirely in ENGLISH. ${platformHint}
Product: ${productName}
${category ? `Category: ${category}\n` : ""}${productDescription ? `Selling points: ${productDescription}\n` : ""}
Output STRICT JSON only (no extra text):
{
  "titles": ["3 catchy short titles with emotion/pain-point/number hooks, each <= 60 chars"],
  "hashtags": ["6-10 hashtags with #, TikTok-style; the FIRST must be a product-specific/branded hashtag (the product name, no spaces) for keyword-search discovery, the rest matching category and platform trends"],
  "caption": "one-line caption, conversational, with a clear call to action, <= 150 chars; lead with the main product keyword in the first ~30 characters for search discoverability"
}`;
  }
  const platformHint = platform ? `目标平台：${platform}。` : "目标平台：抖音/快手/小红书。";
  if (localStore) {
    // 本地门店：同城发布形态——标题点城市/商圈、标签走同城梯度且必带绑定标签、CTA 是到店动作
    const city = normalizeCityName(localStore.city);
    const boundTags = parseCustomTags(localStore.customTags);
    const storeLine = [
      city ? `城市：${city}` : "",
      localStore.landmark ? `商圈/地标：${localStore.landmark}` : "",
      localStore.shopName ? `门店：${localStore.shopName}` : "",
      localStore.storeAddress ? `地址：${localStore.storeAddress}` : "",
    ].filter(Boolean).join("；");
    return `你是资深本地生活短视频运营（帮实体门店做同城到店客流）。请为以下门店内容生成发布文案。${platformHint}
商品/招牌：${productName}
${category ? `品类：${category}\n` : ""}${productDescription ? `卖点：${productDescription}\n` : ""}${storeLine ? `门店信息：${storeLine}\n` : ""}
同城发布要求（优先级最高）：
- 观众是同城"能到店的人"，不是全国网友；标题至少 2 个要点出${city ? `"${city}"${localStore.landmark ? `或"${localStore.landmark}"` : ""}` : "城市或商圈"}，制造"就在你附近"的熟悉感
- 话题标签按同城梯度给：第 1 个是门店/品牌专属标签，随后依次为 商圈/地标标签 → 城市×品类（如 #${city || "城市"}美食）→ 城市大盘（#${city || "城市名"}）→ 内容型（#探店 等）${boundTags.length ? `；并且必须原样包含这些商家绑定标签：${boundTags.map((t) => `#${t}`).join(" ")}` : ""}
- caption 的行动号召是到店动作：点左下角定位/团购 / 想去的评论区扣 1 / 收藏起来去打卡——严禁"点击小黄车""下单链接"等电商挂车话术
${LOCAL_PLATFORM_HINTS[(platform || "").toLowerCase()] ?? ""}要求严格输出 JSON（不要多余文字）：
{
  "titles": ["3 个吸睛短标题，每个 ≤20 字"],
  "hashtags": ["6-10 个带 # 的话题标签，按上面的同城梯度排列"],
  "caption": "一句话文案，口语化，含到店号召，≤40 字；开头先点出门店/招牌关键词"
}`;
  }
  return `你是资深电商带货短视频运营。请为以下商品生成发布文案。${platformHint}
商品名称：${productName}
${category ? `品类：${category}\n` : ""}${productDescription ? `卖点：${productDescription}\n` : ""}
要求严格输出 JSON（不要多余文字）：
{
  "titles": ["3 个吸睛短标题，含情绪/痛点/数字钩子，每个 ≤20 字"],
  "hashtags": ["6-10 个带 # 的话题标签；第 1 个必须是商品专属/品牌标签（商品名、不含空格），利于商品词搜索发现，其余贴合品类与平台热点"],
  "caption": "一句话种草文案，口语化，含行动号召，≤40 字；开头先点出商品核心关键词（利于平台搜索发现）"
}`;
}

export function buildPublishPack(input: PublishPackInput): PublishPack {
  const en = input.locale === "en";
  const name = clip((input.productName || "").trim() || (en ? "this find" : "这款好物"), en ? 40 : 16);
  const cat = (input.category || "other").toLowerCase();
  const point = firstSellingPoint(input.sellingPoints, en ? 40 : 12);

  // 本地门店：同城形态（城市/商圈锚点标题 + 同城标签梯度 + 到店 CTA）——中文语境专属，en 不适用
  if (input.localStore && !en) {
    const city = normalizeCityName(input.localStore.city);
    const place = (input.localStore.landmark || "").trim() || city;
    const local = buildLocalTagPack(input.localStore, { category: cat, platform: input.platform });

    const titles = [
      clip(place ? `就在${place}，${name}来过没？` : `${name}，本地人常来的这家店`, 22),
      clip(point ? `${name}｜${point}` : `${name}，附近的朋友有口福了`, 22),
      clip(city ? `${city}${LOCAL_TITLE_WORD[cat] ?? "探店"}清单+1：${name}` : `探店清单+1：${name}`, 22),
    ];

    // 话题：门店/商品专属标签置顶 + 同城梯度（梯度里已含商圈/城市/品类/内容型/绑定标签）
    const rawName = (input.productName || "").trim();
    const productTag = rawName ? `#${clip(rawName.replace(/[^\p{L}\p{N}]/gu, ""), 12)}` : "";
    const seen = new Set<string>();
    const hashtags: string[] = [];
    for (const tag of [productTag, ...local.hashtags]) {
      if (!tag || tag === "#" || seen.has(tag)) continue;
      seen.add(tag);
      hashtags.push(tag);
      if (hashtags.length >= 10) break;
    }

    // 到店 CTA：评论区扣 1 + 看定位——绝不出现电商挂车话术
    const cta = "，想去的评论区扣1，地址就在定位～";
    const lead = `${name}真的可以${point ? "，" + point : ""}`;
    const caption = clip(lead, 40 - Array.from(cta).length) + cta;

    return { titles, hashtags, caption };
  }

  // 标题：情绪 + 卖点/数字钩子，三条不同角度（英文不强裁，CJK 限 22）
  const titles = en
    ? [
        `This ${name} is a total game-changer 🤯`,
        point ? `${name} — ${point}, you'll want one` : `${name} you won't regret buying`,
        `3 reasons to grab the ${name}`,
      ]
    : [
        clip(`${name}也太好用了吧！后悔没早买`, 22),
        clip(point ? `${name}｜${point}，谁用谁回购` : `${name}，闭眼入不踩雷`, 22),
        clip(`三个理由让你入手${name}`, 22),
      ];

  // 话题：商品专属标签 + 品类 + 平台，去重、带 #、控制在 ~10 个内。
  // 商品专属标签放最前——2026 抖音/TikTok 搜索发现高度依赖商品词，通用品类标签(好物分享/BeautyTok)
  // 曝光泛而不精；加一个商品名标签，让搜该商品的人能精准搜到你的视频。
  const platform = (input.platform || "").toLowerCase();
  const catTags = en ? CATEGORY_TAGS_EN : CATEGORY_TAGS;
  const rawName = (input.productName || "").trim();
  // 商品名去掉空格/标点（话题标签不能含空格），仅保留字母数字与 CJK，限长
  const productTag = rawName ? `#${clip(rawName.replace(/[^\p{L}\p{N}]/gu, ""), en ? 24 : 12)}` : "";
  const tagWords = [
    ...(catTags[cat] || catTags.other),
    ...(PLATFORM_TAGS[platform] || []),
  ];
  const seen = new Set<string>();
  const hashtags: string[] = [];
  for (const tag of [productTag, ...tagWords.map((w) => `#${w}`)]) {
    if (!tag || tag === "#" || seen.has(tag)) continue;
    seen.add(tag);
    hashtags.push(tag);
    if (hashtags.length >= 10) break;
  }

  // 种草文案：口语化 + 行动号召。先裁前半句，再固定拼 CTA，保证 CTA 尾巴不被整体裁断
  const cta = en ? " — tap the link below to grab it 🛒" : "，点下方小黄车带走它～";
  const lead = en
    ? `Obsessed with ${name}${point ? ", " + point : ""}`
    : `${name}真的绝了${point ? "，" + point : ""}`;
  const capMax = en ? 130 : 40;
  const caption = clip(lead, capMax - Array.from(cta).length) + cta;

  return { titles, hashtags, caption };
}
