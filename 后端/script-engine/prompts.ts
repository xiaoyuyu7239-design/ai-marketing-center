/**
 * LLM Prompt 模板
 * 用于生成电商短视频带货脚本的系统提示词和结构化模板
 */

import { getTemplatesByCategory, categoryNameMap, type ProductCategory } from "./templates";
import { buildHookGuidance } from "./hook-patterns";

// ==================== 工具函数 ====================

/** 按字符串简单哈希取模板索引，让同商品固定但不同商品走不同模板，增加多样性 */
function hashProductToIndex(name: string, count: number): number {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % count;
}

// ==================== 系统角色 Prompt ====================

/** 系统角色 prompt：专业电商短视频编导 */
export const SYSTEM_PROMPT = `你是一位顶级电商短视频编导，拥有以下专业能力：

【身份背景】
- 5年抖音/快手电商短视频创作经验，累计操盘GMV超过10亿
- 精通消费心理学、AIDA营销模型（注意→兴趣→欲望→行动）
- 擅长用视听语言讲故事，每条视频都经过严格的分镜设计
- 深谙平台算法机制，完播率和互动率是创作的核心指标

【核心能力】
1. 黄金3秒设计：用视觉冲击、悬念提问、反差对比或利益承诺在前3秒留住观众
2. 痛点挖掘：精准找到目标用户的真实痛点，用场景化语言引发共鸣
3. 产品种草：将产品卖点转化为用户可感知的利益点，不说参数说体验
4. 信任构建：通过数据、对比、口碑、权威背书建立信任
5. 行动号召：用限时限量、价格锚点、赠品策略驱动立即购买

【2025-2026 短视频趋势】
- 真实感优先：用户更信任"随手拍"质感而非过度精致布光，避免影楼风和过度调色
- 原生表达：减少"家人们""宝子们""姐妹们"等已经被过度使用的称呼，用更自然的日常口吻
- 信息密度：每个分镜只讲一个信息点，不在同一镜头里堆砌多个卖点
- 短句快切：旁白以短句为主（单句不超过20字），画面每2-3秒有一个新的视觉刺激
- 情绪多样：不要总用"惊喜/震惊/抢购"三件套，可以尝试幽默、温暖、治愈、好奇、松弛等其他情绪

【严格禁止 — 以下表达会让视频显得"模板化、过时"】
- ❌ 过时开场白："你还在为…烦恼吗""不会还有人不知道吧""居然还有人不知道"
- ❌ 空洞形容词堆砌："绝绝子""yyds""惊艳到我了""这也太好看了吧"等泛滥词汇
- ❌ 虚假紧迫感："最后100件""马上涨价""库存告急"等不实表述
- ❌ 播音腔旁白：像新闻联播一样字正腔圆的朗读口吻，缺乏真实人味
- ❌ 模板句式："就是这款""答应我一定要试试""这谁顶得住""我不允许你不知道"
- ❌ 无意义叠词与语气填充："真的真的""超级超级""非常非常"等空洞副词
- ❌ 用滥的网感旧梗与程度词堆砌："回头率 XX"（爆高/超高等一切变体）"巨显瘦 / 巨藏肉""刚好戳我 / 太戳了""氛围感拉满""谁懂啊""美到窒息""绝了"——这些词 2020 年就用烂了，出现任何一个都判定为低质量文案

【创作原则】
- 文案口语化：说人话，像朋友聊天一样自然，允许口语中的停顿和语气词
- 节奏紧凑：每个分镜都有存在的理由，不允许废镜头
- 情绪曲线：开头抓眼球→中间建信任→结尾促行动（但不强制，允许松弛/温暖等情绪走向）
- 画面可执行：每个分镜的描述要足够具体，能直接指导拍摄或AI生成
- 商品展示镜头（product_reveal/cta）优先使用 product_image，确保商品不被AI篡改
- AI 生成的场景描述要具体、有画面感
- prompt 字段用英文写，要具体描述画面构图、光线、色调
- 语言差异化：同品类商品的脚本要在切入角度、叙事节奏、情绪基调上形成明显差异，避免不同商品念出来像同一套模板
- 画面差异化：相邻分镜的视觉内容要有明显变化（近景→特写→全景切换、暗→亮切换、静态→动态切换）
- 旁白语速节奏：每个分镜的 voiceover 字数 ≈ duration × 3 字（中文）或 duration × 2 词（英文），宁可少说不要赶

【输出要求】
你必须严格按照指定的 JSON 格式输出脚本，不要输出任何额外的解释文字。

【输出前自检 — 请在生成后逐条确认】
1. ✅ 开头 3 秒是否有一个让人"忍不住看下去"的理由？（画面/声音/文字的任意组合）
2. ✅ 旁白读起来像真人在聊天，而不是在念广告稿？（可以默读一遍测试）
3. ✅ 5-8 个分镜中是否有至少 3 种不同的镜头运动方式（推/拉/摇/移/微距/全景）？
4. ✅ 有没有使用【严格禁止】中列出的任何过时表达？
5. ✅ 相邻分镜的视觉内容（场景/光线/构图）是否有明显变化？
6. ✅ 如果把这个脚本套到另一个同品类商品上，需要改多少？（如果改不到30%说明太模板化，请重新生成）
7. ✅ searchTerms 是否是具象、可检索的英文词？（而非"beautiful scene"这种空泛词）
8. ✅ prompt 字段是否描述了具体的画面构图、光线和色调？（而非"product on table"这种过于简陋的描述）
如果不满足以上任意一条，请重新生成，直到满足为止。`;

/**
 * 内容语言策略 —— 把脚本从"电商带货话术"拉回"平台原生博主内容"的关键。
 * 让模型先判断品类（不依赖可能传错的 category 参数，服装常被误判成 other→beauty），再用对应口吻。
 * 注入到脚本生成 prompt，尤其解决服装/穿搭被套进电商 AIDA 模板导致的"老套感"。
 */
export const CONTENT_STRATEGY_GUIDE = `【内容语言 — 先判断品类再定口吻，这是脱离"电商广告腔"的关键】
先根据商品名称/图片自行判断真实品类，采用对应的博主内容策略（不要套用统一的"痛点→逼单"电商话术）：
· 服装 / 鞋包 / 配饰：穿搭博主风。开场即「上身效果」或场景战袍（如"过年穿什么显气质"），讲搭配与身材适配（"配工装裤又酷又软""小个子、微胖也能穿"）而非面料克重参数；用"我会回购"式自然种草。服装的画面主体必须是真人上身效果，不是商品平铺。
· 美妆 / 护肤：种草博主风。讲肤感、妆效、上脸瞬间与前后对比，不堆成分参数。
· 食品 / 零食：吃播种草风。特写口感、咀嚼画面、囤货与场景。
· 数码 / 家居 / 其他：真人测评 / 好物分享口吻，讲真实使用体验和感受。

通用铁律（所有品类都要遵守）：
- 用"我"的第一人称视角，像朋友分享，不是导购推销
- 场景化、说人话，一个镜头只讲一个信息点
- 严禁电商逼单话术："限时抢购""最后 XX 件""赶紧冲""答应我一定要买"——改成"链接放评论区，喜欢的自己看"这种松弛收尾
- 严禁过时开场："你还在为…烦恼吗""不会还有人不知道吧""居然还有人不知道"
- 结构不必套"钩子/痛点/产品/转化"：服装更适合「场景钩子→上身效果→设计细节→搭配或身材适配→自然收尾」

voiceover 按"画面贴字"写（很多用户会关掉配音、只留字幕+音乐，文案必须单独成立）：
- 每镜一句 6-12 字的短句：像发给闺蜜的碎碎念或小红书标题，有情绪、有画面感，不是完整推销句
- 用具体细节代替形容词："口袋装得下 iPad mini" 好过 "口袋超大"；"下摆刚好扫过脚踝" 好过 "很有气场"——具体的才可信
- 好的示例方向："这颜色一上身就赢了""口袋能装下整个下午""红色是冬天的答案"；坏的示例："这款采用优质面料，性价比超高""回头率 XX"（爆高/超高等一切变体）"巨藏肉""刚好戳我"
- 质感微距镜和空镜可以把 voiceover 留空（""），给画面呼吸感——不必每一镜都有字
- 避免华丽辞藻堆砌，宁可口语的松弛也不要文案腔的"绝美""高级感拉满"`;

/**
 * 画面策略 —— 以用户上传图为参考，为每镜生成"主体一致、构图各异"的分镜图再转动态。
 * 关键约束：视频平台风控拒绝清晰人脸图转视频，所以要动的镜头用无脸构图，正脸只当中段静态锚点；
 * 五大品类各有分镜配方（主体动作镜 + 质感微距 + 成分/元素空镜 + 氛围镜）。
 */
export const CATEGORY_VISUAL_GUIDE = `【画面策略 — 用图片模型基于用户上传的图，为每个分镜生成"贴合脚本、又保持同一件商品/同一个模特"的分镜图，再让它动起来。目标：每一镜画面都不同、有叙事推进，主体始终一致，绝不是四张一模一样的图。】

每个分镜的画面怎么定（直接决定画面单一还是丰富）：
- 选 1 个核心展示镜（product_reveal，放在第 2-3 镜的位置）：visualSource = "product_image"，直接用用户原图当画面，作最保真的锚点——不要放第 1 镜，开场必须是动态镜头
- 其余每个分镜：visualSource = "ai_generate" —— 让图片模型以用户上传图为参考做 image-to-image，保持商品/人物的身份、服装、外观、颜色、logo 完全一致，仅按这一镜的镜头描述改变角度、姿态、动作、景别、场景背景，生成这一镜专属的画面
- prompt 字段（英文）必须写清这一镜的构图/角度/动作/场景，例如 "same model wearing the same red knit outfit, turning around to show the back, street background, medium shot" —— 让每一镜画面明显不同，但一眼看得出是同一个主体

真人出镜的关键限制（直接决定哪一镜能动起来）：
- 视频平台风控不允许"含清晰人脸的图片"转视频。所以正脸只允许出现在 product_reveal 锚点镜（用户原图、中段静态定格），其余所有 ai_generate 分镜一律无脸构图——背影、侧影、颈部以下、手部/下半身局部、头发或动作自然遮脸——这正是服装号的主流拍法（360° 低角度仰拍跟走、分屏局部特写都是无脸的），动感靠肢体动作和镜头运动，不靠脸
- ai_generate 分镜的 prompt（英文）禁止出现 face / facing camera / smiling at camera / portrait / looking at camera 等词；构图词用 from behind / side profile / neck-down framing / cropped at shoulders / low-angle following shot

按品类的分镜画面（都遵循"保持主体一致、按镜头推进变化"）：
· 服饰 / 鞋包 / 配饰：正面站姿留给静态锚点镜；要动起来的镜头用背影转身 / 下半身迈步 / 腰线手部特写 / 背影街拍走动，突出穿着与搭配
· 美妆 / 护肤：同一商品换构图 + 手部涂抹 / 上脸质感 / 前后对比
· 食品 / 零食：同一商品换角度 + 开袋 / 咀嚼 / 拉丝 / 倒出等诱人动态
· 家居 / 日用：同一商品放进不同使用场景与动作
· 数码 / 3C：同一商品换特写 + 不同功能演示（屏幕点亮 / 按键 / 接口 / 光效）`;

/** 节奏与运动规范：抖音爆款的核心手感——镜头短、切得快、每一镜都在动 */
export const PACING_GUIDE = `【概念先行 — 先立世界，再写分镜；这是"高级片"和"卖点清单"的分水岭】
- 写任何分镜之前，先定一个一句话的创意概念：时间 × 地点 × 光线 × 情绪（如"深秋傍晚的老城街区，暖逆光，慢下来的散步"或"清晨厨房的第一缕阳光，治愈的独处时刻"），把它当成整条片的世界观
- 全片至少 80% 的分镜发生在这一个世界里：同一时段的光线、统一的色调、同一地点的不同角落——分镜之间换的是"角落与瞬间"，不是"世界"；至多允许 1 个抽离镜（棚拍特写/纯色微距）当呼吸
- 分镜排列走情绪弧线：走进这个世界 → 沉浸其中（动作/细节/质感）→ 情绪高点（全片最美一镜）→ 离开（远景/背影/光影收束）
- 严禁"卖点巡礼"式排列（一个卖点配一个特写、依次报数）——卖点要藏进动作和瞬间里，观众是被世界吸进来的，不是被清单说服的
- 每一镜的英文 prompt 共享同一组光线与色调关键词（如 warm backlight, golden hour, muted film tones），保证成片色调统一

【节奏与运动 — 抖音爆款和"老套广告"的最大差别就在这里】

节奏铁律：
- 单镜 1-3 秒：以 2 秒为主，高冲击碎镜（甩镜/特写打点）可用 1 秒，重点展示镜最多 3 秒；宁可多切几镜，也不要一镜拖 4 秒以上
- 构图与场景不允许重复：同一构图（如"背影走路"）全片最多出现 1 次；全片至少 3 种不同场景/背景（街拍、室内、纯色棚拍、橱窗、夜景灯光等换着来），相邻分镜不能同场景同景别
- 开场即动 + 强反差：第 1 镜必须是全片最有冲击力的"动态"镜头（低角度仰拍跟走 / 动作抓拍 / 细节微距快推 / 甩镜进场），最好带视觉反差（明暗 / 远近 / 快慢），禁止用静态摆拍或正脸站定当开场——观众 1 秒内看不到动就划走
- 相邻分镜的景别必须跳变（微距→全身→中景→特写），连续两镜同景别 = 废镜头
- 分镜配方（爆款的画面组成，按比例混排）：主体动作镜占一半；商品/质感微距 1-2 镜（面料纹理 / 膏体光泽 / 食物拉丝 / 金属细节）；成分或元素空镜 1 镜（美妆=原料水果/膏体旋涡，食品=食材特写，服饰=配饰/面料，数码=光效细节）；氛围收尾 1 镜

每一镜都必须"在动"（静止摆拍 = 失败）：
- description 必须以进行中的动作为主语写清"谁在做什么"：转身甩摆 / 迈步走向镜头 / 指尖抹开膏体 / 撕开包装倒出 / 按下开关点亮——禁止"站着展示""摆放在桌上"这类静态描述
- camera 必须写明显的镜头运动：快速推近 / 低角度环绕 / 手持跟拍 / 甩镜切换 / 从下摇到上——禁止"固定镜头"
- 主体动作 + 镜头运动至少占其一，最好两者都有；这两个字段会直接驱动图生视频模型，写得越具体画面越活
- description 只写真实拍得出来的画面，禁止 UI 元素（"弹出商品卡片""屏幕飘字幕""贴纸特效"）——字幕和贴片由系统后期叠加，写进画面描述只会让 AI 画出假窗口

【物理真实 — AI 片的廉价感大多来自"违反物理"，这一节是质感底线】
- 每个物体必须有可信的支撑：刷头/涂抹器要么被手拿着、要么平放在台面上，绝不悬空漂浮；商品立在真实表面上，不悬浮、不斜卡在半空
- 商品保持真实尺寸：放进场景时它是"手边的小物"（在手里、桌上、包里），不是场景中的巨物——禁止"草地上立着一人高的商品"式画面
- 液体只随重力走（下滴/垂落/缓慢晕开），禁止"悬浮水珠""液体定格在空中""膏体自己爬动"
- 慢动作可以，反物理不行——description 里出现"悬浮/漂浮/迸溅定格"一律重写
- 【运镜避坑，直接决定 i2v 会不会崩】纯静物商品镜（画面里只有商品、没有人/手）的 camera 绝对不要写"推近/拉远/放大/变焦/zoom"——图生视频对静物做推近会把商品本身放大、变大变小；静物镜的 camera 只写"光影缓慢流动 / 极轻微平移视差 / 焦外光斑呼吸 / 固定镜头"。要靠近展示细节，就改成"一只手入画拿起/触碰商品"的有人镜
- 【动作避坑】description 里的人物动作必须是单向、一次性的（转身、迈步走向镜头、抬手拿起、指尖抹开）；绝不写"拿出又放回""放下又拿起""塞进包里再拿出"这种往复动作——i2v 会来回鬼畜`;

// ==================== 流量热点库（可刷新） ====================

/**
 * 抖音/小红书当下流量热点选题库（截至 2026-07 手动整理，需定期刷新）。
 * 按品类给"当下能蹭的内容角度/情绪/场景/话题"，注入脚本让剧情骑在热点上，而不是干巴巴报卖点。
 * 结构故意做成纯数据，方便后续接实时热榜或人工季度更新。
 */
export const TREND_HOOKS: Record<string, string[]> = {
  // 通用情绪/生活方式热点（所有品类都可借）
  common: [
    "松弛感 / 反精致（真实、有点糙反而更被信任，别拍成影楼广告）",
    "情绪价值 / 治愈：给一个能被安慰、被认同的小瞬间",
    "打工人 / 早八人续命：通勤搭子、工位搭子、下班犒赏自己",
    "citywalk / 散步 / 附近感：把商品带进城市漫步的日常",
    "一人居 / 一人食一人饮：独处也要好好对待自己",
    "秋冬多喝热水 / 秋天的第一杯 / 换季的仪式感（按季节挑）",
    "搭子文化：把商品说成陪你上班/遛弯/加班的'搭子'",
  ],
  beauty: [
    "伪素颜 / 妈生感 / 早八快速出门", "换季护肤 / 屏障修复", "上妆无痕不卡粉", "沉浸式护肤 ASMR", "早C晚A 懒人版",
  ],
  food: [
    "深夜放毒 / 打工人续命", "沉浸式吃播 ASMR", "减脂也能吃的快乐", "平替快乐 / 学生党囤货", "一人食的治愈",
  ],
  home: [
    "出租屋 / 工位改造", "松弛感居家 / 极简", "收纳控 / 桌搭", "一人居的小确幸", "氛围感灯光 / 提升幸福感的小物",
  ],
  clothing: [
    "通勤穿搭 / 早八战袍", "微胖显瘦 / 小个子穿搭", "静奢 vs 多巴胺（按调性挑）", "换季叠穿", "氛围感 / 出片穿搭",
  ],
  digital: [
    "打工人效率装备", "极简桌搭 / 生产力", "便携出街 / 通勤党", "学生党平替", "沉浸式开箱",
  ],
};

/** 品类参数 → 热点库 key（容错各种叫法） */
function trendCategoryKey(category?: string): keyof typeof TREND_HOOKS {
  const c = (category || "").toLowerCase();
  if (/beauty|美妆|护肤|彩妆|cosmet|skin/.test(c)) return "beauty";
  if (/food|食品|零食|生鲜|饮|snack|drink/.test(c)) return "food";
  if (/home|家居|日用|家具|厨房|household|furniture/.test(c)) return "home";
  if (/cloth|服饰|鞋|包|穿搭|配饰|apparel|fashion|wear/.test(c)) return "clothing";
  if (/digital|数码|3c|电子|tech|electronic|gadget/.test(c)) return "digital";
  return "home";
}

/**
 * 流量热点指令：挑一个贴合商品的热点角度，把整条片子骑上去。
 * 同时注入 2026 的内容风向：真实感 > 过度精致、情绪价值 > 卖点罗列。
 */
export function buildTrendGuide(category?: string): string {
  const key = trendCategoryKey(category);
  const hooks = [...TREND_HOOKS.common, ...(TREND_HOOKS[key] || [])];
  return `【流量热点契合 — 让内容骑在当下抖音/小红书的热点上，而不是干巴巴报卖点】
当下可蹭的热点角度（挑 1 个最贴合本商品的，把整条片子的情绪与场景建在它上面，别硬蹭多个）：
${hooks.map((h) => `· ${h}`).join("\n")}

2026 内容风向（很重要，直接影响会不会被当成"过时广告"）：
- 真实感 > 过度精致：宁可"随手拍"的松弛质感，也不要影楼级摆拍的塑料感——有点生活痕迹反而更被信任
- 情绪价值 > 卖点罗列：观众是为一个能共鸣的情绪瞬间停留的（治愈/被懂/松一口气），不是为参数
- 落到具体的人和场景：把商品放进"某个具体的人、在某个具体时刻的生活切片"里，而不是悬浮的商品展示
- 第 1 镜就点题这个热点角度（前 3 秒定调），结尾留一个有情绪的余味`;
}

// ==================== 同城/本地门店（抖音同城客流） ====================

/**
 * 本地门店的同城热点选题库（截至 2026-07 按调研整理，需定期刷新；与电商 TREND_HOOKS 分开维护）。
 * 面向做抖音同城客流的实体商家：热点的"锚"是城市里正在发生的事，不是全网情绪。
 * 每条带"什么时候发"的时机提示（节假日提前 2 周、演唱会提前 1-2 周、天气当天、同城热榜 1-3 小时内）。
 */
export const LOCAL_TREND_HOOKS: Record<string, string[]> = {
  common: [
    "同城探店 / 打卡：把门店做成同城人'今天去哪儿'的答案",
    "周末去哪 / 节假日聚会：周四周五发周末攻略位；法定节假日提前 2 周开始发聚会/家庭套餐场景",
    "天气梗：降温/下雨/下雪/高温当天 1-2 天内接住城市情绪（'降温了，XX人来碗热的'、雪景门头的温差感）",
    "本地大事件承接：演唱会/赛事/展会官宣后提前 1-2 周备内容，散场后 2-3 天接余温（'来看演唱会的朋友，场馆旁边就有…'）",
    "城市文旅出圈的顺风车：城市上同城热榜时立即跟进，聚焦 1 个招牌单品 + 1 个视觉记忆点，用'外地人来打卡'视角",
    "开学季 / 毕业季 / 寒暑假：学生流与家庭客流的节奏切换（散伙饭/开学第一顿/学生价）",
    "城市身份认同 / 本地梗：本地话、老地名、本地人才懂的细节（'老XX人打死也不说的店'），一句话拉近距离",
    "'附近'搜索心智：附近好吃的/附近能坐一下午的店/地铁站出口的宝藏小店",
  ],
  food: [
    "下班觅食 / 深夜食堂：晚饭点前 1-2 小时发，接住'今晚吃什么'",
    "工作日午餐拯救：上午 11 点前发，写字楼/学校附近的干饭答案",
    "排队 / 出餐 / 后厨实拍的烟火气：同城人认'生意好'",
    "应季限定上新：换季菜单、时令食材、节令小吃（'冬天第一顿火锅'式仪式感）",
  ],
  beauty: [
    "节前变美：约会/婚礼/年会/过年前的预约高峰，提前 1-2 周发",
    "换季换发型 / Before-After 前后对比：素人变身的反差是美业最强内容",
    "手艺过程实拍：手法、细节、上手前后对比比广告词可信",
    "学生党 / 通勤党的性价比选择",
  ],
  fashion: [
    "逛街实拍 / 到店试穿上身：同城人要的是'能摸到面料'",
    "换季上新到店 / 闺蜜逛街打卡点",
  ],
  home: [
    "到店体验 / 实物比图靠谱：摸得着的质感",
    "小店改造 / 老板选品故事",
  ],
  tech: [
    "到店维修 / 现场检测的踏实感",
    "本地现货 / 当天取：比快递快的理由",
  ],
  other: [
    "小店日常 / 老板出镜：街坊生意的人情味",
    "到店体验的真实记录",
  ],
};

/** 本地门店上下文：注入脚本生成，驱动同城内容策略（城市锚点 → 商圈辐射） */
export interface LocalStorePromptContext {
  /** 城市（同城锚点） */
  city?: string;
  /** 商圈/地标/地铁站 */
  landmark?: string;
  /** 门店名 */
  storeName?: string;
  /** 门店地址/位置指引 */
  storeAddress?: string;
}

/**
 * 同城内容指令：给"能到店的人"写内容，不是给全国网友。
 * 本地门店模式下替代电商向的 buildTrendGuide（热点锚在城市里正在发生的事）。
 */
export function buildLocalStoreGuide(store: LocalStorePromptContext, category?: string): string {
  const key = trendCategoryKey(category) as string;
  const localKey = key === "clothing" ? "fashion" : key === "digital" ? "tech" : key;
  const hooks = [...LOCAL_TREND_HOOKS.common, ...(LOCAL_TREND_HOOKS[localKey] ?? LOCAL_TREND_HOOKS.other)];
  const place = [store.city, store.landmark].filter(Boolean).join(" · ");
  const storeLine = [
    store.city ? `城市：${store.city}` : "",
    store.landmark ? `商圈/地标：${store.landmark}` : "",
    store.storeName ? `门店：${store.storeName}` : "",
    store.storeAddress ? `地址：${store.storeAddress}` : "",
  ].filter(Boolean).join("；");

  return `【同城内容策略 — 这是本地实体门店的同城客流视频，观众是"能到店的人"，不是全国网友；本节与其他指令冲突时以本节为准】
${storeLine ? `门店信息：${storeLine}` : ""}

同城三信号（算法判定"本地内容"靠多信号叠加，三个都要有）：
1. 文案地域词：voiceover/贴字里出现城市、商圈、街道或地标（至少 2 个分镜有）
2. 画面地域元素：至少 1 个分镜是门头/街景/地标/店内实景（description 写明，这一镜优先 visualSource="product_image" 或 "user_upload" 用商家实拍——纯 AI 画面有被平台判低质的风险，实拍才有同城信任感）
3. 本地互动引导：结尾镜或互动引导里抛一个本地问题（如"你们都是${place || "XX"}哪个区的？评论区报个坐标"）

前 3 秒公式：{城市/商圈词} + {人群} + {钩子（悬念/福利/反常识）}，参考句式（学结构别照抄）：
· "这家店我一定要曝光，${place || "XX"}的朋友注意了"
· "坐标${store.city || "XX"}，刷到的有福了"
· "大家好我是XX，在${store.landmark || store.city || "XX"}开了 8 年${categoryNameHint(category)}"（老板出镜固定开场）
· "在${store.city || "XX"}怎么找到XX，本地人打死也不说的店"（老地名/懂行人设）

同城钩子（决定同城人会不会停下来）：
- 位置指引当卖点讲：距离、地铁站出口、商圈、"XX 对面"，越具体越可信；至少 1 个分镜的 voiceover 或贴字是位置信息
- 视角写给"住在这附近的人"：用"附近感"说话，不用"家人们/全国的朋友"
- CTA 必须是到店动作：点左下角定位/团购 / 想去的评论区扣 1 / 收藏起来去打卡——严禁出现"点击小黄车""链接下单"等电商挂车话术（本条覆盖其他任何平台策略里的挂车引导）
- 城市锚点辐射：内容优先服务同商圈的人（他们到店转化最高），再顺着"商圈 → 城区 → 全城"放大；不要面向全国说话
- 价格和分量可以大方讲：同城消费决策就看性价比与距离（"人均 50 吃到撑"式的具体数字最有效）

本地热点结合（挑 1 个最贴合本店、且时机对的，把整条片子的场景和情绪建在它上面，别硬蹭多个）：
${hooks.map((h) => `· ${h}`).join("\n")}

同城信任感（本地店和电商广告的最大差别）：
- 真实 > 精致：门头、店内实景、制作过程、后厨/工位、老板或店员出镜，比棚拍精修更能让同城人信任
- 有人气的画面优先：排队、出餐、翻台、熟客互动——同城人认"这家店生意好"
- 老板第一人称像街坊聊天："开了 8 年的老店""今天就备了 40 份"，不端着、不念广告稿`;
}

/** 品类中文名（同城开场句式用；不引入 templates 的 categoryNameMap 避免循环依赖语义） */
function categoryNameHint(category?: string): string {
  const key = trendCategoryKey(category);
  const map: Record<string, string> = { beauty: "美容美发店", food: "小店", home: "生活好物店", clothing: "服装店", digital: "数码店" };
  return map[key] ?? "小店";
}

// ==================== 风格结构模板 ====================

/** 脚本风格类型 */
export type ScriptStyleType = "pain_point" | "scene" | "comparison" | "story" | "mood" | "local" | "custom";

/** 风格中文名映射 */
export const styleNameMap: Record<ScriptStyleType, string> = {
  pain_point: "痛点种草",
  scene: "场景安利",
  comparison: "对比测评",
  story: "剧情故事",
  mood: "氛围大片",
  local: "同城到店",
  custom: "自定义",
};

/** 氛围大片模式：纯画面 + 音乐 + 一两句情绪短句——时尚广告片形态，对齐爆款"纯视频"参考片，不是带货口播 */
export const MOOD_FILM_GUIDE = `【脚本风格：氛围大片 — 本片是时尚广告片/情绪短片，不是带货口播；本节规则优先级最高，与其它内容语言规则冲突时以本节为准】
- 全片禁止卖点列举和推销话术：不说"显腿长/藏肉/省心/实用/性价比"，商品的好全部用画面表达
- 文字极简：全片最多 2 个分镜有 voiceover（每句 6-14 字的情绪短句，如"如风般轻盈，拥抱你的夏日"），其余分镜 voiceover 一律留空 ""
- 画面敢于"杂志化"：逆光、剪影、倒影、光斑、慢动作抓拍、微距质感——每一镜都要经得起截图当海报
- 结构自由：第 1 镜用全片最美的动态画面开场；结尾镜用背影/远景/光影收束（type 仍填 cta），不喊"点击链接"式行动号召（转化交给发布文案承接）
- 本模式适合搭配纯 BGM（不配音），字幕即贴字`;

/** 按风格的结构化 prompt 指令 */
export const stylePrompts: Record<Exclude<ScriptStyleType, "custom">, string> = {
  pain_point: `
【脚本风格：痛点种草型】
结构要求：痛点引入 → 产品救星 → 效果证明 → 限时抢购

创作要点：
1. 开头必须精准击中目标用户的痛点，用具体场景而非抽象描述
   - 好的："每次化妆卡粉斑驳，拍照都不敢放大看"
   - 差的："你的皮肤不好吗？"
2. 痛点要足够疼，用户看了要有"对对对就是我"的感觉
3. 产品出场时机要在痛点最强烈的时候，像"救星"一样登场
4. 使用效果要有对比：使用前vs使用后，越直观越好
5. 最后用限时限量制造紧迫感，逼单要自然不生硬

情绪节奏：焦虑 → 共鸣 → 期待 → 惊喜 → 心动 → 冲动下单`,

  scene: `
【脚本风格：场景安利型】
结构要求：生活场景切入 → 自然使用 → 效果展示 → 安利推荐

创作要点：
1. 开头是一个具体的生活场景（约会前、加班中、周末宅家、旅行途中等）
2. 产品的出现要"自然"，像生活中真的会用到，而非硬广
3. 重点展示产品融入生活的"美好瞬间"，让观众代入
4. 安利口吻要像"好东西忍不住分享"，而非"你一定要买"
5. 可以用 vlog 式的第一人称叙述，增加真实感和亲近感

情绪节奏：日常 → 代入 → 向往 → 好奇 → 被种草 → 想要同款`,

  comparison: `
【脚本风格：对比测评型】
结构要求：提出问题 → 多方对比 → 数据/效果说话 → 推荐最优

创作要点：
1. 开头可以用"花了XXX元测了N款，就为了告诉你买哪个"式的吸引
2. 对比维度要公平客观：外观、性能、价格、细节等
3. 每项对比用直观的方式呈现：并排测试、数据图表、慢动作回放
4. 语气保持客观中立，不贬低竞品而是突出推荐款的优势
5. 最后的推荐要有理有据，总结"为什么选这个"

情绪节奏：好奇 → 信任（专业感） → 认同 → 确认选择 → 下单`,

  story: `
【脚本风格：剧情故事型】
结构要求：剧情铺垫 → 冲突/转折 → 产品登场解决问题 → 美好结局+种草

创作要点：
1. 开头用一个有吸引力的故事开场："上周发生了一件事..."
2. 故事要简短但有冲突：约会翻车、面试尴尬、朋友聚会社死等
3. 产品作为解决冲突的关键道具出现，扭转故事走向
4. 结局要有反转和"爽感"，让观众看完有满足感
5. 最后自然过渡到产品介绍，不破坏故事的沉浸感
6. 故事时长控制在15-25秒，不能拖沓

情绪节奏：好奇 → 紧张/尴尬 → 转折惊喜 → 满足 → 种草 → 行动`,
  mood: MOOD_FILM_GUIDE,

  local: `
【脚本风格：同城到店】
结构要求：地域身份钩子 → 门店/招牌实拍 → 细节建信任（手艺/分量/价格）→ 位置指引 + 到店号召

创作要点：
1. 第 1 镜就点出城市/商圈（贴字或口播），让同城人 1 秒识别"这是我够得着的店"
2. 中段用真实感画面建立信任：制作过程、店内实景、人气镜头，一镜一个信息点
3. 价格和分量可以大方讲——同城消费决策就看性价比和距离，不用绕
4. 至少 1 个分镜专门讲位置：地铁站出口、商圈、参照物（"XX 对面""出地铁走 200 米"）
5. 结尾固定是到店动作：想去的评论区扣 1 / 点头像看定位 / 团购在评论区——不喊任何电商挂车话术

情绪节奏：熟悉感（这是我家附近）→ 心动 → 信任 → 想去 → 收藏/扣 1`,
};

// ==================== 视频模式指令 ====================

/** 按视频模式的素材生成策略 */
export const VIDEO_MODE_DIRECTIVES: Record<string, string> = {
  product_closeup: `
【视频模式：产品特写】
这是一条以商品本身为主角的视频（服饰/鞋包类例外：见「画面策略」，服饰要展示真人上身试穿效果）。

素材策略（极其重要，严格遵守）：
1. 所有分镜的 visualSource 优先使用 "product_image"（用户上传的原图最真实，直接用、别让 AI 重画）
2. 需要纯氛围空镜时才用 "ai_generate"；非服饰品类画面主体是产品、不生成人脸，服饰品类则展示真人上身
3. 每个使用 product_image 的分镜，设置 motion 字段控制运动效果：
   - hook 分镜：motion = "zoom_in_slow"（缓慢推进，营造悬念）
   - product_reveal：motion = "ken_burns"（缓慢漂移，展示全貌）
   - demo：motion = "pan_left" 或 "pan_right"（横移展示细节）
   - cta：motion = "static"（静止，聚焦购买信息）
4. prompt 字段描述产品周围的环境/光线/氛围，不描述人物
   - 好的 prompt："Premium tissue box on a clean marble surface, soft studio lighting, bokeh background, product photography"
   - 差的 prompt："A woman holding tissue paper"（不要出现人）
5. 可使用 textOverlay 在关键帧上叠加文字（卖点、价格等）

适合的商品：高客单价护肤品、食品、数码产品、家居用品等`,

  graphic_montage: `
【视频模式：图文混剪】
这是一条快节奏的图文混剪视频，用商品图+文字卡片+转场动画吸引注意力。

素材策略：
1. 以 "product_image" 为主，穿插文字卡片
2. 每个分镜都应设置 textOverlay 字段，叠加关键信息：
   - hook：textOverlay.style = "title"，文字大而醒目
   - pain_point：textOverlay.style = "highlight"，强调痛点
   - demo：textOverlay.style = "subtitle"，描述功能
   - cta：textOverlay.style = "price"，显示价格/优惠
3. 转场要快速密集（建议 ffmpeg_fade 或 direct_concat，不用 AI 转场）
4. 分镜时长要短（每个 2-4 秒），节奏紧凑
5. prompt 中描述简洁的背景和排版风格，不要人物
6. 所有分镜使用 motion 效果让画面不死板

适合的商品：快消品、日用品、零食、平价美妆等`,

  scene_demo: `
【视频模式：场景演示】
这是一条展示产品使用场景的视频，用 AI 生成使用环境，但不生成人脸。

素材策略：
1. product_reveal 和 cta 分镜使用 "product_image"（确保商品真实）
2. hook 和 demo 分镜使用 "ai_generate"，生成使用场景
3. AI 生成的画面必须避免人脸！可以出现：
   - 手部特写（涂抹、使用、操作）
   - 背影/侧影（模糊处理）
   - 只有物品的场景（桌面、浴室、厨房等）
4. prompt 中明确写 "no face visible, hands only" 或 "back view, silhouette"
   - 好的："Close-up of hands applying cream on skin, soft natural lighting, bathroom counter, no face visible"
   - 差的："A beautiful woman applying cream"（会生成假脸）
5. 场景要真实生活化，光线自然，避免过度渲染

适合的商品：护肤品、化妆品、厨房用品、健身器材等`,

  live_presenter: `
【视频模式：真人出镜】
这是一条有真人出镜讲解的视频。

素材策略：
1. 如果提供了出镜人物信息，所有含人物的分镜 prompt 必须包含人物外貌描述
2. product_reveal 和 cta 依然建议使用 "product_image"
3. hook 和 demo 可以使用 "ai_generate" 生成人物场景
4. 也可将 visualSource 设为 "user_upload"，让用户上传自己拍摄的真人素材
5. 如果没有真人素材，建议只在中景/远景使用 AI 人物，避免面部特写（容易失真）

建议：如果用户没有真人素材，优先考虑切换到"产品特写"或"场景演示"模式`,
};

// ==================== 平台 SEO 策略 ====================

/** 按投放平台的算法优化指令 */
export const PLATFORM_SEO_DIRECTIVES: Record<string, string> = {
  douyin: `
【抖音算法优化策略】
完播率优化（权重最高）：
- 前3秒必须有强钩子，不能用品牌logo或空镜头开场
- 每5秒要有一个信息密度高点（新信息、反转、视觉刺激）防止用户划走
- 结尾不要有"谢谢观看"之类的结束信号，要在高潮处戛然而止或抛出悬念
- 配音语速建议 3.5-4 字/秒，比日常略快

互动率优化：
- 在 voiceover 中自然植入 1-2 个引导互动的话术：
  "你们觉得值不值？评论区告诉我"
  "用过的姐妹扣1，没用过的扣2"
  "先收藏，下次买的时候不迷路"
- CTA 分镜的文案要有紧迫感："最后XX件"、"今天下单送XX"

转化率优化：
- 价格锚点要明确：先说原价/柜台价，再说活动价
- 最后 3 秒必须有清晰的购买引导："点击下方小黄车"
- 避免出现绝对化用语（"最好的"、"第一"）可能被限流`,

  kuaishou: `
【快手算法优化策略】
完播率优化：
- 快手用户更喜欢"接地气"的内容，开头用日常场景切入
- 语速可以略慢于抖音（3-3.5字/秒），更有"聊天感"
- 视频时长建议 20-40 秒（快手完播率权重比抖音更高）

互动率优化：
- 快手用户互动意愿强，多用"老铁们"、"家人们"等称呼
- 引导评论："这个价格你们能接受吗？"
- 引导关注："关注我，每天给你们找好物"

转化率优化：
- 快手用户价格敏感度高，性价比是核心卖点
- 多用"自用款"、"回购N次"等信任话术
- CTA 要简单直接："直接拍，不用犹豫"`,

  xiaohongshu: `
【小红书算法优化策略】
完播率优化：
- 小红书用户偏好"精致感"和"教程感"
- 开头用"分享"、"安利"、"测评"等小红书原生词汇
- 视频节奏可以比抖音慢，注重画面美感

互动率优化：
- 引导收藏："建议先收藏，需要的时候翻出来看"
- 引导评论："你们还想看什么类型的测评？"
- 用"姐妹"、"宝子"等小红书风格称呼

转化率优化：
- 小红书用户信任"真实分享"，避免过度营销感
- 多分享使用体验和对比，少说"赶紧买"
- 封面要精致，标题用关键词（品牌名+品类+核心卖点）`,

  tiktok: `
【TikTok Shop 算法优化策略】
官方推荐三段式结构（更易进推荐、提转化）：
- 黄金 3-6 秒钩子：第一帧即产品或惊艳效果，开门见山抛痛点/反差，不留缓冲、不放 logo 空镜
- 核心信息（Key Message）：3-5 个利益点快速给到，每点配一个画面，讲清"为什么是它"
- 明确 CTA：片尾清晰引导"点击橱窗/黄车下单"，可叠加限时优惠

高转化四范式（任选其一贯穿全片）：
- 测评（Review）：真实试用 + 优缺点，建立可信度
- 前后对比（Before/After）：使用前 vs 使用后的可视化反差
- 开箱（Unboxing）：拆封惊喜 + 细节特写，营造期待
- 教程（How-to）：手把手演示用法/场景，降低决策门槛

留存与合规：
- 节奏更快：每 2-3 秒切一个信息点，字幕全程在屏（多为静音观看）
- 价格/优惠用画面贴片强化，别只靠口播
- 面向海外受众时口播可用英文/目标语言；AI 生成内容需打标识，避免夸大与未经证实的功效宣称`,
};

// ==================== 黄金3秒策略 ====================

/** 黄金3秒开头策略库 */
export const goldenThreeSecondsStrategies = `
【黄金3秒开头策略 - 必须使用以下策略之一】

策略1「视觉冲击法」：用极度吸睛的画面作为第一帧
  - 夸张的对比（素颜vs妆后、脏vs干净）
  - 动态捕捉（爆浆、拉丝、泼水、碎裂）
  - 微距特写（质地、纹理、光泽）
  示例文案："这个效果真实存在吗？！"

策略2「悬念提问法」：抛出一个让人忍不住要看答案的问题
  - 反常识问题："XX元的东西居然比XX元的好用？"
  - 身份代入："月薪5000的姐妹都在用的XX"
  - 数字钩子："3秒搞定XX，我用了这个方法"
  示例文案："为什么这个XX全网都在抢？"

策略3「反差对比法」：制造强烈的认知反差
  - 价格反差："10块钱 vs 500块钱的XX"
  - 效果反差："同事以为我花了3000做的脸"
  - 身份反差："程序员教你化妆？效果比美妆博主还好"
  示例文案："千万别买贵了！同样的效果只要十分之一！"

策略4「利益承诺法」：直接告诉观众看完能得到什么
  - 省钱："看完这条帮你省500块"
  - 变美/变好："7天让你的XX发生质变"
  - 避坑："买XX前一定要看这条"
  示例文案："看完这条视频，你就知道买哪个了！"

策略5「情感共鸣法」：戳中观众的情感痛点
  - 焦虑共鸣："是不是也觉得XX越来越XX了？"
  - 快乐分享："今天开心到必须分享的一个好物！"
  - 后悔预警："早知道就该买！后悔没早点发现"
  示例文案："姐妹们，别划走！这个XX我后悔没早买！"
`;

// ==================== 输出格式约束 ====================

/** JSON 输出格式约束 prompt */
export const OUTPUT_FORMAT_PROMPT = `
【输出格式要求】
请严格按照以下 JSON 格式输出，不要包含任何 markdown 代码块标记或额外文字：

{
  "title": "脚本标题（10字以内，抓人眼球）",
  "totalDuration": 25,
  "shots": [
    {
      "shotId": 1,
      "type": "hook",
      "duration": 3,
      "description": "画面描述：要足够具体，包含场景布置、人物动作、物品位置、光线氛围等细节",
      "camera": "镜头运动描述：特写/中景/全景 + 推拉摇移跟升降等运动方式",
      "visualSource": "ai_generate",
      "transition": "direct_concat",
      "voiceover": "配音文案：口语化的播音文案，控制字数与duration匹配（约3字/秒）",
      "prompt": "英文AI生图/生视频prompt：用于生成该分镜的视觉素材",
      "searchTerms": ["english keyword", "alt keyword"],
      "characterId": "出镜人物ID（可选，有人物出镜时填写）"
    }
  ],
  "seo": {
    "title": "视频标题（含核心关键词，15字以内）",
    "hashtags": ["#话题标签1", "#话题标签2", "#话题标签3"],
    "coverText": "封面文案（8字以内，吸引点击）",
    "interactionGuide": "互动引导语（引导评论/收藏/关注）",
    "description": "视频描述文案（含关键词，50字以内）"
  }
}

字段规则：
- shotId: 从1开始递增的整数
- type: 只能是 "hook" | "pain_point" | "product_reveal" | "demo" | "social_proof" | "cta" 之一
- duration: 该分镜时长（秒），所有分镜 duration 之和应等于 totalDuration
- description: 中文画面描述，要具体到可以直接拍摄或让AI生成
- camera: 中文镜头运动描述
- visualSource: "ai_generate"（AI生成）| "product_image"（使用商品图）| "user_upload"（用户上传）
- transition: "ai_start_end" | "ai_reference" | "direct_concat" | "ffmpeg_fade"
- voiceover: 中文配音文案，字数约等于 duration x 3
- prompt: 英文 prompt，用于 AI 图像/视频生成，描述画面主体、风格、光线、构图等
- searchTerms: 1-3 个英文检索词，描述该分镜画面主体（用于从免费素材库自动搜画面，无商品主题成片时尤其关键），如 ["coffee morning", "cozy cafe"]
- characterId: 如果该分镜有人物出镜，填入人物ID；无人物的分镜省略此字段
- seo.title: 包含商品名和核心卖点的短标题
- seo.hashtags: 3-5个相关话题标签，第一个为品类大标签
- seo.coverText: 封面上叠加的大字文案
- seo.interactionGuide: 自然的互动引导话术
- seo.description: 发布时的视频描述

注意事项：
1. 第一个分镜的 type 必须是 "hook"，最后一个必须是 "cta"
2. totalDuration 控制在15-30秒之间
3. 分镜数量控制在5-8个
4. prompt 字段要用英文，风格描述要专业（如 cinematic, soft lighting, macro shot 等）
5. visualSource 为 "product_image" 时，prompt 字段可省略

【质量对比示例 -- 请对标"优秀"级别】

以下是一个食品类商品（螺蛳粉）的同一分镜的平庸 vs 优秀对比：

❌ 平庸（不要这样写）：
{
  "shotId": 1,
  "type": "hook",
  "description": "一碗螺蛳粉特写",
  "camera": "特写推进",
  "voiceover": "姐妹们，这个螺蛳粉真的绝绝子！",
  "prompt": "a bowl of noodles on table",
  "searchTerms": ["noodles", "food"]
}
→ 问题：画面描述太笼统、旁白用了禁用词"绝绝子"和"姐妹们"、prompt过于简陋、searchTerms太宽泛

✅ 优秀（对标这个质量）：
{
  "shotId": 1,
  "type": "hook",
  "description": "滚烫的螺蛳粉刚出锅，红油在表面微微冒泡，酸笋和腐竹堆在米粉上，热气蒸腾模糊了镜头边缘",
  "camera": "微距特写从酸笋缓慢拉到整碗俯拍，焦点从配料切到汤面油光",
  "voiceover": "加班到十一点，一碗粉比任何语言都懂你。",
  "prompt": "steaming hot luosifen in ceramic bowl, chili oil glistening on surface, pickled bamboo shoots and fried tofu skin on top, warm steam rising, overhead macro shot, warm amber lighting, cozy night kitchen atmosphere, shallow depth of field",
  "searchTerms": ["luosifen closeup", "steaming noodle soup", "chinese rice noodle"]
}
→ 优点：画面有温度感、旁白有真实生活场景、prompt描述画面质感而非仅主题、searchTerms具象可检索

请确保你输出的每个分镜都达到或超过"优秀"的水准。`;

// ==================== 商品分析 Prompt ====================

/** 商品图片分析 prompt */
export const PRODUCT_ANALYSIS_PROMPT = `你是一位专业的电商选品分析师。请仔细分析提供的商品图片，提取以下信息：

1. 【商品识别】
   - 商品名称/类型
   - 所属品类（美妆护肤/食品零食/家居日用/服饰鞋包/数码3C）
   - 品牌（如果可见）

2. 【视觉特征】
   - 主色调和配色方案
   - 包装设计风格（简约/华丽/可爱/科技感等）
   - 产品形态（固体/液体/粉末/组合等）
   - 材质质感（哑光/亮面/透明/磨砂等）

3. 【卖点提取】
   - 从图片可见的产品卖点（成分、功效、规格等）
   - 包装上的营销文案
   - 产品独特的设计亮点

4. 【目标用户推断】
   - 根据产品特征推断目标用户群体
   - 适合的使用场景
   - 可能的痛点和需求

5. 【短视频建议】
   - 推荐的拍摄角度和特写镜头
   - 建议突出的视觉元素
   - 适合的脚本风格（痛点种草/场景安利/对比测评/剧情故事）

请用 JSON 格式输出分析结果：
{
  "productName": "商品名称",
  "category": "beauty|food|home|fashion|tech",
  "brand": "品牌名（未知则留空）",
  "visualFeatures": {
    "mainColor": "主色调",
    "designStyle": "设计风格",
    "productForm": "产品形态",
    "texture": "材质质感"
  },
  "sellingPoints": ["卖点1", "卖点2", "卖点3"],
  "targetAudience": "目标用户描述",
  "usageScenarios": ["场景1", "场景2"],
  "painPoints": ["痛点1", "痛点2"],
  "videoSuggestions": {
    "recommendedAngles": ["角度1", "角度2"],
    "keyVisuals": ["视觉元素1", "视觉元素2"],
    "suggestedStyle": "pain_point|scene|comparison|story"
  }
}`;

// ==================== 组装完整 Prompt ====================

/** 脚本生成的输入参数 */
export interface ScriptGenerationInput {
  /** 商品名称 */
  productName: string;
  /** 输出语言（跟随界面语言；不再按商品名猜测——英文品名的商品在中文用户这里也该出中文脚本） */
  locale?: "zh" | "en";
  /** 商品品类 */
  category: ProductCategory;
  /** 商品描述/卖点 */
  productDescription?: string;
  /** 脚本风格 */
  styleType: ScriptStyleType;
  /** 目标时长（秒） */
  targetDuration?: number;
  /** 目标用户 */
  targetAudience?: string;
  /** 商品图片分析结果 */
  productAnalysis?: string;
  /** 视频模式 */
  videoMode?: "product_closeup" | "graphic_montage" | "scene_demo" | "live_presenter";
  /** 用户自定义要求 */
  customRequirements?: string;
  /** 参考脚本结构（爆款模板的镜头节奏/类型/转化逻辑，用于"套用模板"生成） */
  referenceStructure?: string;
  /** 出镜人物信息（仅 live_presenter 模式，用于注入 prompt 保持人物一致性） */
  character?: {
    id: string;
    name: string;
    appearance: string;
    voiceStyle?: string;
  };
  /** 价格区间 */
  priceRange?: string;
  /** 投放平台（逗号分隔：douyin,kuaishou,xiaohongshu） */
  platforms?: string;
  /** 产品用法与优势 */
  usageAdvantage?: string;
  /** 历史效果回流提示：有真实投放数据时注入，冷启动为空 */
  performanceHint?: string;
  /** 本地门店上下文：实体商家做同城客流时注入（城市锚点/商圈/门店），替代电商向热点指令 */
  localStore?: LocalStorePromptContext;
}

/**
 * 组装完整的用户 prompt
 * 将所有模板、策略、约束组合成一条完整的生成指令
 */
export function buildUserPrompt(input: ScriptGenerationInput): string {
  const {
    productName,
    category,
    productDescription,
    styleType,
    targetDuration = 25,
    targetAudience,
    productAnalysis,
    videoMode = "product_closeup",
    customRequirements,
    character,
    priceRange,
    platforms,
    usageAdvantage,
    performanceHint,
    localStore,
  } = input;

  // 获取品类模板
  const categoryData = getTemplatesByCategory(category);
  const categoryName = categoryNameMap[category];

  // 获取风格指令
  const styleDirective = styleType === "custom"
    ? `【脚本风格：自定义】\n请根据用户的自定义要求来确定脚本结构和风格。`
    : stylePrompts[styleType];

  // 按商品名哈希从品类模板中选一个，同商品固定但不同商品走不同模板，增加多样性
  const templateIndex = hashProductToIndex(productName, categoryData.templates.length);
  const referenceTemplate = categoryData.templates[templateIndex];

  // 组装 prompt
  const parts: string[] = [];

  parts.push(`请为以下商品创作一条电商短视频带货脚本：`);
  parts.push(`\n【商品信息】`);
  parts.push(`- 商品名称：${productName}`);
  parts.push(`- 商品品类：${categoryName}`);

  if (productDescription) {
    parts.push(`- 商品描述/卖点：${productDescription}`);
  }

  if (targetAudience) {
    parts.push(`- 目标用户：${targetAudience}`);
  }

  if (priceRange) {
    parts.push(`- 价格区间：${priceRange}`);
  }

  if (usageAdvantage) {
    parts.push(`- 用法与优势：${usageAdvantage}`);
  }

  parts.push(`- 目标总时长：${targetDuration}秒`);
  parts.push(`- 画面比例：9:16 竖屏（手机观看）`);
  parts.push(`- 目标平台：抖音/快手`);

  // 添加商品图片分析结果
  if (productAnalysis) {
    parts.push(`\n【商品图片分析结果】`);
    parts.push(productAnalysis);
  }

  // 注入出镜人物约束
  if (character) {
    parts.push(`\n【出镜人物】`);
    parts.push(`- 人物名称：${character.name}`);
    parts.push(`- 外貌特征：${character.appearance}`);
    if (character.voiceStyle) {
      parts.push(`- 声音风格：${character.voiceStyle}`);
    }
    parts.push(`- 重要：所有包含人物出镜的分镜，prompt 中必须包含该人物的外貌描述，确保画面一致性`);
    parts.push(`- 在 shot 的 characterId 字段填入 "${character.id}"`);
  }

  // 内容语言策略——氛围大片模式下带货口吻规则会与"禁卖点列举"冲突，直接跳过（风格指令里已有 MOOD_FILM_GUIDE）
  if (styleType !== "mood") {
    parts.push(`\n${CONTENT_STRATEGY_GUIDE}`);
  }
  // 内容角度：本地门店走同城策略（城市锚点+本地热点+到店 CTA），电商走通用流量热点——两者都放在画面策略前先定角度
  if (localStore) {
    parts.push(`\n${buildLocalStoreGuide(localStore, category)}`);
  } else {
    parts.push(`\n${buildTrendGuide(category)}`);
  }
  // 画面策略（基于用户图生成每镜专属分镜图，主体一致、画面推进）
  parts.push(`\n${CATEGORY_VISUAL_GUIDE}`);
  // 节奏与运动（单镜 2-3 秒、景别跳变、每镜必须有主体动作或镜头运动）
  parts.push(`\n${PACING_GUIDE}`);

  // 添加视频模式指令
  parts.push(`\n${VIDEO_MODE_DIRECTIVES[videoMode]}`);

  // 注入投放平台的 SEO 策略
  if (platforms) {
    const platformList = platforms.split(",");
    // 用第一个平台作为主要优化目标
    const primaryPlatform = platformList[0];
    if (PLATFORM_SEO_DIRECTIVES[primaryPlatform]) {
      parts.push(`\n${PLATFORM_SEO_DIRECTIVES[primaryPlatform]}`);
    }
    if (platformList.length > 1) {
      parts.push(`\n【注意】视频同时投放于：${platformList.join("、")}，脚本要兼顾各平台用户习惯`);
    }
  }

  // 添加品类专属指令
  parts.push(`\n${categoryData.directive}`);

  // 添加风格指令
  parts.push(`\n${styleDirective}`);

  // 添加历史效果回流（数据飞轮）：让下一次生成明显参考真实转化更高的风格/钩子
  if (performanceHint) {
    parts.push(`\n${performanceHint}`);
  }

  // 添加黄金3秒钩子指引（按品类优选机制 + 三拍结构）
  parts.push(`\n${buildHookGuidance(category)}`);

  // 添加参考模板
  parts.push(`\n【参考脚本案例（仅供参考风格和节奏，不要照搬内容）】`);
  parts.push(`模板名称：${referenceTemplate.name}`);
  parts.push(`参考示例：\n${referenceTemplate.example}`);

  // 添加自定义要求
  if (customRequirements) {
    parts.push(`\n【用户额外要求】`);
    parts.push(customRequirements);
  }

  // 添加输出格式约束
  parts.push(`\n${OUTPUT_FORMAT_PROMPT}`);

  // 语言跟随商品信息语言：英文商品(海外 TikTok Shop/Amazon 带货)就出英文带货脚本/旁白，
  // 否则上面 OUTPUT_FORMAT 的「中文配音文案」会让英文商品也产出中文旁白（视频本体就错了）。
  // 放最后最显著、覆盖规范里的「中文」。与 topic 路径(buildTopicPrompt)同一手法。
  const productText = `${productName || ""} ${productDescription || ""} ${usageAdvantage || ""}`;
  if (productText.trim() && !/[一-鿿]/.test(productText)) {
    parts.push(
      `\n【LANGUAGE — IMPORTANT, overrides any "中文" wording above】The product info is NOT in Chinese. Write every "title" and "voiceover" field in the SAME language as the product (e.g. natural English for an overseas TikTok Shop audience), never Chinese. Keep "searchTerms" in English as usual; "description"/"camera" may be concise English.`
    );
  }

  return parts.join("\n");
}

/**
 * 构建批量生成 prompt（一次生成多个不同风格的脚本）
 */
export function buildBatchPrompt(input: ScriptGenerationInput, count: number = 3): string {
  const basePrompt = buildUserPrompt(input);

  const refBlock = input.referenceStructure
    ? `\n\n【参考爆款结构】\n请参考以下经过验证的高转化分镜结构（镜头类型、节奏、转化逻辑），用本商品重新创作脚本（不要照搬文案，要贴合本商品卖点）：\n${input.referenceStructure}\n`
    : "";

  return `${basePrompt}${refBlock}

【批量生成要求】
请生成 ${count} 个不同风格/角度的脚本方案。每个方案的切入角度、开头策略、叙事节奏都要有明显差异。

输出格式改为：
{
  "scripts": [
    { "title": "...", "totalDuration": ..., "shots": [...] },
    { "title": "...", "totalDuration": ..., "shots": [...] }
  ]
}

请确保输出 ${count} 个脚本方案。`;
}

// ==================== 主题成片（去商品化）====================
//
// 「一句话主题成片」：用户只给一句话主题（如"在家如何泡一杯手冲咖啡"、"城市夜景的浪漫"），
// 不涉及任何商品，引擎产出一条有旁白、有画面节奏的短视频脚本，每个分镜都带英文检索词
// （stockKeywords），随后由 stock-fill 从免费素材库自动配齐画面 → 合成成片。
// 与带货脚本的区别：没有商品/卖点/逼单，全程 ai_generate（实际由免费素材兜底），重表达不重转化。

/** 主题成片的系统角色：通用短视频内容编导（知识/生活/故事/情绪向） */
export const TOPIC_SYSTEM_PROMPT = `你是一位顶级短视频内容编导，擅长把任意一个主题做成有画面、有节奏、让人看完有收获或有共鸣的竖屏短视频。

【核心能力】
1. 黄金3秒：用悬念、反差、利益承诺或情绪共鸣在前3秒留住观众
2. 信息节奏：把主题拆成层层递进的小信息点，每个分镜只讲一件事，不堆砌
3. 画面感：每个分镜都能对应到一段真实可检索的画面（风景、动作、物件、场景）
4. 旁白口语化：像朋友聊天，不书面、不说教，配音字数与时长匹配（约3字/秒）
5. 收尾升华：结尾用一句金句或行动建议收束，给观众"值得点赞收藏"的理由

【2025-2026 短视频趋势】
- 真实感 > 精致感：用户更喜欢"像朋友拍的"质感而非过度调色
- 短句快切：旁白以短句为主，画面每2-3秒有一个新的视觉刺激
- 情绪克制：不要强行煽情或过度正能量，允许平淡、松弛、留白

【严格禁止】
- ❌ 过时开场："你还在为…烦恼吗""不会还有人不知道吧"
- ❌ 空洞词汇堆砌："绝绝子""yyds""震撼""美到窒息"等泛滥表达
- ❌ 播音腔/配音腔：像纪录片旁白一样字正腔圆，缺乏真实人味
- ❌ 强行正能量升华：不要在结尾硬拗一句"人生感悟"

【创作原则】
- 这是一条没有商品的内容向短视频，不要出现任何带货、卖点、价格、下单、购买引导
- 每个分镜的画面都要能用免费素材库搜到，所以画面主体要常见、具象、可拍摄
- 画面里不强求出现人脸，优先用环境/动作/物件/风景表达
- searchTerms 必须用英文，描述该分镜的画面主体，是自动配画面的关键，绝不能省略

【输出要求】
你必须严格按照指定的 JSON 格式输出，不要输出任何额外的解释文字。

【输出前自检】
1. ✅ 开头 3 秒是否有让人停下来看的理由？
2. ✅ 旁白是否像真人在说话而非朗读课文？
3. ✅ searchTerms 是否全部是具象英文词（而非"beautiful"这种空泛词）？
4. ✅ 有没有使用【严格禁止】中列出的任何过时表达？
如果不满足，请重新生成。`;

/** 主题成片旁白风格 */
export type TopicNarrationStyle = "knowledge" | "story" | "lifestyle" | "inspiration" | "travel";

/** 旁白风格中文名 */
export const topicNarrationNameMap: Record<TopicNarrationStyle, string> = {
  knowledge: "知识科普",
  story: "情感故事",
  lifestyle: "生活方式",
  inspiration: "励志金句",
  travel: "旅行风光",
};

/** 各旁白风格的创作指令 */
const topicStylePrompts: Record<TopicNarrationStyle, string> = {
  knowledge: `
【旁白风格：知识科普】
- 开头抛出一个反常识或让人好奇的问题/事实
- 中间用 3-5 个递进的小知识点把主题讲清楚，每个分镜一个点
- 语言准确但不掉书袋，多用"其实""你可能不知道"等口语连接
- 结尾给一句可记住的总结金句`,
  story: `
【旁白风格：情感故事】
- 用第一人称或第二人称叙事，开头是一个有代入感的瞬间
- 中间有情绪起伏（铺垫→转折→释然），让观众跟着走
- 画面以氛围、光影、生活细节为主，烘托情绪
- 结尾落到一句能引发共鸣的感悟`,
  lifestyle: `
【旁白风格：生活方式】
- 像一段精致的生活 vlog 旁白，娓娓道来
- 展示一个具体的生活场景/流程/习惯的美好瞬间
- 画面注重质感与细节（手部动作、物件特写、自然光）
- 结尾是一句温柔的生活态度表达`,
  inspiration: `
【旁白风格：励志金句】
- 节奏明快有力，每个分镜一句短而有冲击力的话
- 用对比、排比制造气势，画面大气（风光、奔跑、登顶、城市）
- 不空喊口号，结合具体画面让情绪落地
- 结尾一句点题的金句，适合被点赞收藏`,
  travel: `
【旁白风格：旅行风光】
- 以目的地或风景为主角，旁白像一封写给某个地方的信
- 画面是地标、自然、人文细节的组合，节奏舒缓
- 旁白点出这个地方独特的氛围与值得去的理由
- 结尾留一句让人想出发的话`,
};

/** 主题成片的输出格式约束（复用 Shot 结构，但去掉商品/逼单，强制每镜 searchTerms） */
const TOPIC_OUTPUT_FORMAT_PROMPT = `
【输出格式要求】
请严格按照以下 JSON 格式输出，不要包含任何 markdown 代码块标记或额外文字：

{
  "title": "脚本标题（10字以内，抓人眼球）",
  "totalDuration": 25,
  "shots": [
    {
      "shotId": 1,
      "type": "hook",
      "duration": 3,
      "description": "中文画面描述：这一镜呈现什么画面（场景/动作/物件/光线），要具体可检索",
      "camera": "镜头运动描述：特写/中景/全景 + 推拉摇移",
      "visualSource": "ai_generate",
      "transition": "direct_concat",
      "voiceover": "中文旁白文案，字数约等于 duration × 3",
      "searchTerms": ["english keyword", "alt keyword"]
    }
  ]
}

字段规则：
- shotId: 从1开始递增的整数
- type: 第一个分镜用 "hook"，中间分镜用 "demo"，最后一个用 "cta"（此处表示收尾升华，不是带货）
- duration: 该分镜时长（秒），所有分镜 duration 之和应等于 totalDuration
- description: 中文画面描述，具体到可以直接检索或拍摄
- camera: 中文镜头运动描述
- visualSource: 固定为 "ai_generate"
- transition: "direct_concat" | "ffmpeg_fade" 之一（主题成片节奏明快，建议这两种）
- voiceover: 中文旁白文案，字数约等于 duration × 3
- searchTerms: 【必填】1-3 个英文检索词，精准描述该分镜画面主体，如 ["pour over coffee", "coffee beans closeup"]。每个分镜都必须有，否则无法自动配画面

注意事项：
1. 第一个分镜 type 必须是 "hook"，最后一个必须是 "cta"（收尾升华）
2. totalDuration 控制在 15-40 秒之间
3. 分镜数量控制在 5-9 个
4. 全程不得出现任何商品、卖点、价格、购买/下单引导
5. 每个分镜的 searchTerms 都不能省略，用常见、具象的英文词以保证素材库能搜到画面

【质量对比示例 -- 请对标"优秀"级别】

以主题"在家如何泡一杯手冲咖啡"为例：

❌ 平庸（不要这样写）：
{
  "shotId": 1,
  "type": "hook",
  "description": "一杯咖啡",
  "camera": "特写",
  "voiceover": "你知道怎么泡一杯好喝的手冲咖啡吗？",
  "searchTerms": ["coffee", "drink"]
}
→ 问题：画面描述太笼统、旁白过于书面、searchTerms太宽泛搜不到好素材

✅ 优秀（对标这个质量）：
{
  "shotId": 1,
  "type": "hook",
  "description": "热水壶嘴冒出白色蒸汽，水刚烧开到92度，厨房窗台上的晨光刚好打在滤杯边缘",
  "camera": "从蒸汽微距特写缓慢拉到窗台全景",
  "voiceover": "周末早上什么都不赶的时候，我会认真给自己冲一杯。",
  "searchTerms": ["pour over coffee", "kettle steam closeup", "morning kitchen sunlight"]
}
→ 优点：画面有生活气息、旁白像真人在说话、searchTerms具象且多样`;

/** 主题成片脚本生成输入 */
export interface TopicScriptInput {
  /** 一句话主题 */
  topic: string;
  /** 旁白风格，默认 knowledge */
  narrationStyle?: TopicNarrationStyle;
  /** 目标时长（秒），默认 25 */
  targetDuration?: number;
  /** 投放平台（逗号分隔），用于注入平台 SEO 策略（可选） */
  platforms?: string;
  /** 用户额外要求（可选） */
  customRequirements?: string;
}

/** 组装主题成片的用户 prompt */
export function buildTopicPrompt(input: TopicScriptInput): string {
  const {
    topic,
    narrationStyle = "knowledge",
    targetDuration = 25,
    platforms,
    customRequirements,
  } = input;

  const styleDirective = topicStylePrompts[narrationStyle] ?? topicStylePrompts.knowledge;

  const parts: string[] = [];
  parts.push(`请围绕以下主题创作一条竖屏短视频脚本（这是一条没有商品的内容向视频）：`);
  parts.push(`\n【主题】\n${topic}`);
  parts.push(`\n【基本要求】`);
  parts.push(`- 旁白风格：${topicNarrationNameMap[narrationStyle] ?? "知识科普"}`);
  parts.push(`- 目标总时长：${targetDuration}秒`);
  parts.push(`- 画面比例：9:16 竖屏（手机观看）`);

  // 旁白风格指令
  parts.push(`\n${styleDirective}`);

  // 黄金3秒（与带货共用，开头抓人逻辑通用）
  parts.push(`\n${goldenThreeSecondsStrategies}`);

  // 平台 SEO（可选，用第一个平台）
  if (platforms) {
    const primary = platforms.split(",")[0];
    if (PLATFORM_SEO_DIRECTIVES[primary]) {
      parts.push(`\n${PLATFORM_SEO_DIRECTIVES[primary]}`);
    }
  }

  if (customRequirements) {
    parts.push(`\n【用户额外要求】\n${customRequirements}`);
  }

  parts.push(`\n${TOPIC_OUTPUT_FORMAT_PROMPT}`);

  // 语言跟随主题语言：英文主题就出英文旁白/标题（否则上面 JSON 规范里的「中文配音文案」会让
  // 全球用户的英文主题也产出中文旁白——视频本体就错了）。放在最后最显著、覆盖规范里的「中文」。
  if (!/[一-鿿]/.test(topic)) {
    parts.push(
      `\n【LANGUAGE — IMPORTANT, overrides any "中文" wording above】The topic is NOT in Chinese. Write every "title" and "voiceover" field in the SAME language as the topic (e.g. natural English), never Chinese. Keep "searchTerms" in English as usual; "description"/"camera" may be concise English.`
    );
  }

  return parts.join("\n");
}

/** 批量生成多套主题成片脚本（不同切入角度） */
export function buildTopicBatchPrompt(input: TopicScriptInput, count: number = 3): string {
  const basePrompt = buildTopicPrompt(input);
  return `${basePrompt}

【批量生成要求】
请生成 ${count} 个不同切入角度的脚本方案，每个方案的开头钩子、叙事顺序、画面选择都要有明显差异。

输出格式改为：
{
  "scripts": [
    { "title": "...", "totalDuration": ..., "shots": [...] },
    { "title": "...", "totalDuration": ..., "shots": [...] }
  ]
}

请确保输出 ${count} 个脚本方案，且每个分镜都带 searchTerms。`;
}

// ==================== 向后兼容的旧接口 ====================

/**
 * 旧版脚本 prompt 构建函数（保持向后兼容）
 * @deprecated 请使用 buildUserPrompt 替代
 */
export function buildScriptPrompt(params: {
  productName: string;
  productCategory?: string;
  productDescription?: string;
  productAnalysis?: string;
  styleType: string;
  duration: number;
  templateHint?: string;
}): string {
  const category = mapOldCategory(params.productCategory);

  return buildBatchPrompt({
    productName: params.productName,
    category,
    productDescription: params.productDescription,
    productAnalysis: params.productAnalysis,
    styleType: (params.styleType as ScriptStyleType) || "pain_point",
    targetDuration: params.duration,
    customRequirements: params.templateHint,
  });
}

/** 将旧版品类名映射为新版品类 key */
function mapOldCategory(category?: string): ProductCategory {
  if (!category) return "beauty";
  const map: Record<string, ProductCategory> = {
    "美妆护肤": "beauty",
    "食品零食": "food",
    "家居日用": "home",
    "服饰鞋包": "fashion",
    "数码3C": "tech",
  };
  return map[category] || "beauty";
}

// ==================== 图片生产线（清洗 + 朋友圈图片套装） ====================

/**
 * 商品图清洗指令：随手拍/杂乱背景图 → 干净的电商主图。
 * 这是图片线和视频线共用的地基——杂乱输入会被"保持参考图一致"忠实地保真进所有下游产物。
 */
export const CLEAN_PRODUCT_IMAGE_PROMPT =
  "只做背景替换与去杂，不重打光：完整保留参考图中的商品本体——形状、比例、颜色、材质、logo 与文字细节一模一样，" +
  "尤其保留商品原本的颜色饱和度、明暗层次和材质高光反射，绝不把商品提亮、洗白或调成塑料感（禁止过曝、禁止整体泛白）。" +
  "去掉手、手指和杂乱背景，把商品原样居中放在干净的纯色浅灰背景上（背景比商品略深一点，别用纯白，以免商品和背景糊在一起）；" +
  "商品正下方紧贴一小圈柔和的接触阴影（短、贴地、edge 柔和），不要长投影、不要方向诡异的假影子，画面里只有这一件商品。" +
  "不要添加任何文字、水印或装饰图形。Preserve the product's original color, saturation, contrast and material highlights exactly — do NOT brighten, wash out or overexpose it. " +
  "Only replace the background with a clean solid light-gray backdrop (slightly darker than the product, never pure white) and add a soft, short contact shadow directly beneath the product. Remove hands and clutter, keep the exact same product, centered.";

/** 图片套装脚本里单张宣传图的规格 */
export interface ImagePackSpecImage {
  /** 这张图的用途（如"使用场景""细节质感""氛围陈列"） */
  purpose: string;
  /** 中文画面描述（给用户看） */
  description: string;
  /** 英文生图 prompt（给图生图模型） */
  prompt: string;
}

/** 图片套装脚本：一组朋友圈宣传图 + 配套文案 */
export interface ImagePackSpec {
  /** 一句话创意概念（时间×地点×光线×情绪） */
  concept: string;
  /** 朋友圈正文（2-4 行，店主口吻） */
  caption: string;
  /** 备选短文案 */
  altCaptions: string[];
  /** 场景图规格（3-5 张；清洗后的主图天然是第 1 张，不在此列） */
  images: ImagePackSpecImage[];
}

/**
 * 生成"朋友圈图片套装"脚本的 prompt：一组场景宣传图 + 店主口吻文案。
 * 与视频脚本同源的原则：概念先行（一个世界）、物理真实、无脸构图、不压字。
 */
export function buildImagePackPrompt(input: {
  productName: string;
  category?: string;
  productDescription?: string;
  productAnalysis?: string;
  locale?: "zh" | "en";
}): string {
  const en = input.locale === "en";
  return `为商品生成一套「朋友圈宣传图组」脚本，只输出合法 JSON，不要 markdown。

商品名称：${input.productName}
商品品类：${input.category || "自行判断"}
核心卖点：${input.productDescription || "根据商品名称与图片自行提炼"}
${input.productAnalysis ? `商品图片分析摘要：${input.productAnalysis.slice(0, 500)}` : ""}

这组图的用途：商家发朋友圈做日常宣传。第 1 张是已清洗好的干净商品主图（不用你生成），你要设计 3-5 张「场景宣传图」和配套文案。

${buildTrendGuide(input.category)}

【概念先行】先定一句话创意概念：时间 × 地点 × 光线 × 情绪（如"清晨书桌前的第一杯温水，柔和晨光"），并让它贴合上面挑中的那个热点角度。所有场景图都发生在这一个世界里：同一时段光线、统一色调；每张图的英文 prompt 共享同一组光线色调关键词。

【场景图要求】
- 每张图用途不同（使用场景 / 细节质感 / 生活方式氛围 / 搭配陈列），构图景别互不重复
- 商品是"手边的真实小物"：有可信支撑（放在桌面/被手拿着/在包里），保持真实尺寸，绝不悬浮、不巨大化
- 可以出现手部/背影等人体局部，但绝不出现清晰人脸；英文 prompt 禁用 face/portrait 等词
- 画面里不要有任何文字、水印、logo 贴片（图不压字，保持原生朋友圈质感）
- prompt（英文）具体到构图、光线、材质、色调

【文案要求 — 店主本人发圈的口吻，不是广告】
- caption：朋友圈正文，2-4 行短句，${en ? "英文" : "中文"}，像店主随手分享日常，可适度用 1-2 个 emoji；禁止"限时抢购/最后 X 件"式电商话术和"绝绝子/回头率/巨XX"式烂梗
- altCaptions：3 条备选短文案（每条一行），角度各不相同（场景带入 / 细节种草 / 松弛日常）

输出 JSON 格式：
{
  "concept": "一句话创意概念",
  "caption": "朋友圈正文",
  "altCaptions": ["备选1", "备选2", "备选3"],
  "images": [
    { "purpose": "使用场景", "description": "中文画面描述", "prompt": "english image prompt with shared light/color keywords" }
  ]
}

images 数组必须 3-5 个元素。${en ? "Write caption/altCaptions/description in English." : "caption、altCaptions、description 用中文；prompt 用英文。"}`;
}
