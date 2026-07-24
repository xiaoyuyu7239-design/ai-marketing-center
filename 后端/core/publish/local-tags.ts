/**
 * 同城标签梯度 + POI 发布清单 —— 本地门店商家（做抖音同城客流）的"标签化绑定"核心。
 *
 * 规则依据（2026-07 调研，多源交叉验证的服务商共识）：
 * - 话题标签 3-5 个宁精勿多（抖音单条上限 5），按槽位填充：
 *   门店/品牌专属 → 区域/商圈×品类 → 城市×品类 → 城市大盘 → 内容型；堆砌泛标签会让账号受众标签紊乱
 * - 商圈定向主要靠"发布时选门店/商圈级 POI 位置"，话题负责城市/品类维度
 * - 标签按优先级从前往后排：商家发抖音取前 5 个即可，小红书可多带
 * - 挂 POI + 挂团购是"看视频→到店"的最短路径，首小时回评决定同城页推荐
 *
 * 纯函数、确定性（同输入同输出），前后端同构可单测；不调模型。
 */

export interface LocalStoreInfo {
  /** 城市（同城锚点；接受"杭州市/浙江省杭州市"等原始输入，内部归一化） */
  city?: string | null;
  /** 商圈/地标/行政区/地铁站（如"武林商圈"、"西湖区"） */
  landmark?: string | null;
  /** 门店名（挂 POI 用） */
  shopName?: string | null;
  /** 门店地址/位置指引 */
  storeAddress?: string | null;
  /** 商家绑定的常用标签（逗号分隔，merchant.customTags 原文） */
  customTags?: string | null;
}

export interface LocalTagPack {
  /** 同城标签梯度，已带 # 前缀、去重，按优先级排列（门店 → 商圈 → 城市×品类 → 城市大盘 → 内容型 → 自定义绑定） */
  hashtags: string[];
  /** 标签用法提示（抖音取前 5 个等） */
  tagHint: string;
  /** 发布动作清单（POI/团购/评论区/首小时回评/定位合规），导出页勾选用 */
  poiChecklist: string[];
  /** 同城锚点一句话说明（UI 展示） */
  anchorNote: string;
}

/** 品类 → 同城标签用词：cityWord 拼"城市×品类"（#杭州美食），contentTags 是内容型补位 */
const LOCAL_CATEGORY_WORDS: Record<string, { cityWord: string; contentTags: string[] }> = {
  food: { cityWord: "美食", contentTags: ["探店", "本地人推荐"] },
  beauty: { cityWord: "美容美发", contentTags: ["变美日记", "本地人推荐"] },
  fashion: { cityWord: "穿搭", contentTags: ["逛街", "宝藏小店"] },
  home: { cityWord: "家居", contentTags: ["宝藏小店", "本地人推荐"] },
  tech: { cityWord: "数码", contentTags: ["宝藏小店", "本地人推荐"] },
  other: { cityWord: "探店", contentTags: ["本地人推荐", "同城好店"] },
};

/**
 * 归一化城市名："浙江省杭州市"→"杭州"、"杭州市"→"杭州"。
 * 只做保守清洗（去省级前缀、去"市/地区"后缀），认不出就原样返回，绝不猜。
 */
export function normalizeCityName(raw?: string | null): string {
  let s = (raw ?? "").trim();
  if (!s) return "";
  const provinceIdx = s.lastIndexOf("省");
  if (provinceIdx >= 0) s = s.slice(provinceIdx + 1);
  // 自治区全称（如"广西壮族自治区南宁市"）
  const regionIdx = s.lastIndexOf("自治区");
  if (regionIdx >= 0) s = s.slice(regionIdx + 3);
  if (s.length > 2) s = s.replace(/(市|地区)$/, "");
  return Array.from(s).slice(0, 12).join("");
}

/** 标签词清洗：去 #、去空格标点，仅留字母数字与 CJK，限长；空返回 "" */
function tagWord(raw?: string | null, max = 16): string {
  const cleaned = (raw ?? "").replace(/[^\p{L}\p{N}]/gu, "");
  return Array.from(cleaned).slice(0, max).join("");
}

/** 解析商家绑定的自定义标签（逗号分隔原文 → 干净词组） */
export function parseCustomTags(raw?: string | null): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const piece of raw.split(/[,，、#\s]+/)) {
    const tag = tagWord(piece);
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    tags.push(tag);
    if (tags.length >= 10) break;
  }
  return tags;
}

/**
 * 构建同城标签梯度 + POI 发布清单。
 * category 用现有商家品类枚举（beauty/food/home/fashion/tech/other），platform 可选。
 */
export function buildLocalTagPack(
  store: LocalStoreInfo,
  options: { category?: string; platform?: string } = {}
): LocalTagPack {
  const city = normalizeCityName(store.city);
  const landmark = tagWord(store.landmark);
  const shop = tagWord(store.shopName, 12);
  const catKey = (options.category || "other").toLowerCase();
  const words = LOCAL_CATEGORY_WORDS[catKey] ?? LOCAL_CATEGORY_WORDS.other;

  // 槽位梯度（由近及远，优先级从前往后；抖音取前 5 个）
  const ladder: string[] = [];
  // ① 门店/品牌专属（利于店名搜索）
  if (shop) ladder.push(shop);
  // ② 区域/商圈：行政区拼品类（#天河美食 式实证用法），商圈/地标原样
  if (landmark) ladder.push(landmark.endsWith("区") ? `${landmark}${words.cityWord}` : landmark);
  // ③ 城市×品类（#杭州美食）——同城品类大盘，必占一槽
  if (city) ladder.push(`${city}${words.cityWord}`);
  // ④ 城市大盘（#杭州探店 / #杭州同城）
  if (city) ladder.push(catKey === "food" || catKey === "other" ? `${city}探店` : `${city}同城`);
  // ⑤ 内容型补位
  ladder.push(...words.contentTags);
  // ⑥ 商家绑定的自定义标签（"标签化绑定"——每条内容固定携带）
  ladder.push(...parseCustomTags(store.customTags));

  const seen = new Set<string>();
  const hashtags: string[] = [];
  for (const word of ladder) {
    const tag = `#${word}`;
    if (!word || seen.has(tag)) continue;
    seen.add(tag);
    hashtags.push(tag);
    if (hashtags.length >= 8) break; // 宁精勿多：8 个封顶（抖音发 5 个、小红书可全带）
  }

  const poiName = [store.shopName, store.storeAddress].map((s) => (s ?? "").trim()).filter(Boolean).join(" · ");
  const interactCity = city || "本地";
  const poiChecklist = [
    poiName
      ? `发布时挂门店 POI／添加位置，选到「${poiName}」这种门店/商圈级位置，别只选城市——挂了 POI 视频才进同城页，顾客能一键导航`
      : "发布时挂门店 POI／添加位置，要选到门店或商圈级位置，别只选城市（建议先在建档里补门店地址）——挂了 POI 视频才进同城页",
    "有团购/券必须一起挂上（展示在视频左下角）——'看视频→点团购→到店'是转化最短路径",
    `评论区置顶一条位置信息（${store.landmark ? `${store.landmark.trim()}，` : ""}怎么走、几点营业），再抛一个本地互动问题（如"你们都是${interactCity}哪个区的？"）`,
    "发出后 1 小时内尽量条条回评——首小时互动直接影响同城页推荐",
    "定位必须真实：不伪造、不频繁更换发布定位（有限流/封号风险）",
  ];

  const anchorNote = city
    ? `同城锚点：${city}${store.landmark ? ` · ${store.landmark.trim()}` : ""}——先打透同商圈能到店的人，再向全城辐射`
    : "还没填城市：去「设置 → 商家信息」补上城市和商圈，同城标签和位置钩子才能生效";

  return {
    hashtags,
    tagHint: "标签已按优先级排好：抖音单条最多 5 个话题，从前往后取即可；小红书可多带几个",
    poiChecklist,
    anchorNote,
  };
}
