import { sql } from "drizzle-orm";
import { check, index, sqliteTable, text, integer, uniqueIndex } from "drizzle-orm/sqlite-core";
import type { MediaCredit } from "@backend/core/publish/media-credit-types";

// 商家表 —— 多租户账号体系的根实体；建档画像字段用于给脚本生成注入默认品类/人群
export const merchants = sqliteTable("merchants", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(), // scrypt 派生，格式 "salt:hash"（见 后端/core/auth/password.ts）
  shopName: text("shop_name"), // 店铺/品牌名，建档阶段补充
  category: text("category"), // 主营品类：beauty/food/home/fashion/tech/other
  region: text("region"), // 地区/城市（自由文本，如"杭州"；本地门店的同城锚点城市）
  targetAudience: text("target_audience"), // 目标客户描述（如"25-35岁宝妈"）
  priceRange: text("price_range"), // 主力价格带（如"50-150元"）
  platforms: text("platforms"), // 主投平台，逗号分隔（douyin,xiaohongshu,...）
  // ===== 本地门店画像（做抖音同城客流的实体商家）=====
  storeType: text("store_type"), // 经营形态：ecommerce=纯电商（默认）/ local=实体门店 / both=两者都有
  landmark: text("landmark"), // 商圈/地标/地铁站（如"武林商圈"、"地铁2号线凤起路站"），同城内容的位置钩子
  storeAddress: text("store_address"), // 门店地址/位置指引（如"文三路 259 号 1 层"），POI 提醒与到店指引用
  customTags: text("custom_tags"), // 商家绑定的常用话题标签，逗号分隔（发布文案每次自动带上）
  planId: text("plan_id").notNull().default("trial").references(() => plans.id),
  // 运营赠送的额外月度额度（立项方案"后台调整/赠送次数"）：每月可用 = 套餐额度 + quotaBonus
  quotaBonus: integer("quota_bonus").notNull().default(0),
  // ===== 发布提醒（黄金时间微信推送）=====
  // 每天计划发几条（1-5）。此前只存前端 localStorage（dailyPickCount），服务端定时提醒要用，故落库为准
  dailyPublishTarget: integer("daily_publish_target").notNull().default(3),
  // 发布提醒总开关；开着且绑定了微信（wechat_bindings 有记录）才会真的推送
  publishReminderEnabled: integer("publish_reminder_enabled", { mode: "boolean" }).notNull().default(true),
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
});

// 协议同意事件只追加、不覆盖：记录用户注册时实际看到并同意的三份文档版本，时间只取服务端。
export const legalConsentEvents = sqliteTable("legal_consent_events", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  merchantId: text("merchant_id").notNull().references(() => merchants.id, { onDelete: "cascade" }),
  termsVersion: text("terms_version").notNull(),
  privacyVersion: text("privacy_version").notNull(),
  aiNoticeVersion: text("ai_notice_version").notNull(),
  acceptedAt: integer("accepted_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
});

// 待发布库记录 —— 商家"认可入库/已发布"状态的服务端持久化（此前只存在浏览器 localStorage，换设备即丢，运营后台也读不到）
export const publishRecords = sqliteTable("publish_records", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  merchantId: text("merchant_id").notNull().references(() => merchants.id, { onDelete: "cascade" }),
  projectId: text("project_id").notNull().unique().references(() => projects.id, { onDelete: "cascade" }),
  approvedAt: integer("approved_at", { mode: "timestamp" }), // 认可入库时间；null=未入库
  publishedAt: integer("published_at", { mode: "timestamp" }), // 商家手动发布后自行标记；null=未发布
  platform: text("platform"), // 实际发布平台（douyin/xiaohongshu/...），标记发布时可带
  // 审核状态：approved=商家自审通过（默认）；rejected=运营驳回；pending 保留位（当前无自动进入路径）
  reviewStatus: text("review_status", { enum: ["pending", "approved", "rejected"] }).notNull().default("approved"),
  reviewNote: text("review_note"), // 运营驳回原因，回传给商家看（如"含广告法违禁词"）
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
});

// 微信提醒绑定 —— 商家（老板/店员）扫服务号带参二维码关注后，openid 与商家账号的绑定关系。
// 一个商家可绑多个微信（老板 + 店员都收提醒）；一个 openid 只归属一个商家（unique 兜底防串号）。
export const wechatBindings = sqliteTable("wechat_bindings", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  merchantId: text("merchant_id").notNull().references(() => merchants.id, { onDelete: "cascade" }),
  openId: text("open_id").notNull().unique(),
  remark: text("remark"), // 备注（如"老板"、"店员小王"），设置页展示/解绑时辨认用
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
});

// 发布提醒发送流水 —— "每商家每天每个时段最多提醒一次"的去重依据，也是排查"没收到提醒"的证据链
export const reminderLogs = sqliteTable("reminder_logs", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  merchantId: text("merchant_id").notNull().references(() => merchants.id, { onDelete: "cascade" }),
  planDate: text("plan_date").notNull(), // 服务器本地日期 "YYYY-MM-DD"（部署需设 TZ=Asia/Shanghai）
  windowKey: text("window_key").notNull(), // 时段标识 "startMinute-endMinute"，如 "1020-1140"
  channel: text("channel").notNull().default("wechat"),
  status: text("status", { enum: ["sent", "failed", "skipped"] }).notNull(),
  detail: text("detail"), // 提醒文案摘要 / 失败原因 / 跳过原因
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
});

// 商家会话表 —— cookie 里只存 token，凭 token 查此表换取 merchantId
export const merchantSessions = sqliteTable("merchant_sessions", {
  id: text("id").primaryKey(), // 原始 token 的 SHA-256 摘要；数据库泄露时不能直接复用会话
  merchantId: text("merchant_id").notNull().references(() => merchants.id, { onDelete: "cascade" }),
  expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
});

// 套餐表 —— 目前只有额度字段用于配额拦截，价格/支付通道待后续拍板后再接入
export const plans = sqliteTable("plans", {
  id: text("id").primaryKey(), // 如 "trial"、"pro"，人可读 slug 而非随机 uuid
  name: text("name").notNull(),
  monthlyGenerationQuota: integer("monthly_generation_quota").notNull(), // 每自然月可调用生成类 Agent 的次数
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
});

// 生成用量父流水 —— 一次用户动作只占一个额度：例如「生成 9 个分镜」是 1 条父流水，
// 9 个真实模型调用写到 generation_operation_items。success 保留给旧数据/后台统计兼容：
// reserved/running/partial/succeeded 为 true（占位或已产出），全失败才改为 false（释放额度）。
export const generationUsage = sqliteTable(
  "generation_usage",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    merchantId: text("merchant_id").notNull().references(() => merchants.id, { onDelete: "cascade" }),
    // 新生成流程冻结所属项目，子项 claim 必须与此完全一致。
    // 旧流水、无项目脚本以及 compose 兼容记录可为空。
    projectId: text("project_id"),
    agentId: text("agent_id").notNull(), // 父流程的主 Agent；子步骤可在 items.agentId 记录实际 Agent
    success: integer("success", { mode: "boolean" }).notNull(),
    // 客户端为同一次点击生成的幂等键。旧流水为空；SQLite UNIQUE 允许多条 NULL。
    operationKey: text("operation_key"),
    operationType: text("operation_type").notNull().default("single"),
    // requestHash 冻结父请求业务上下文；manifestHash 冻结全部 itemKey + agentId。
    // 只存 SHA-256，不存 prompt、商品信息或任何模型凭据。
    requestHash: text("request_hash"),
    manifestHash: text("manifest_hash"),
    status: text("status", { enum: ["reserved", "running", "succeeded", "partial", "failed"] })
      .notNull()
      .default("succeeded"),
    expectedItems: integer("expected_items").notNull().default(1),
    completedItems: integer("completed_items").notNull().default(1),
    succeededItems: integer("succeeded_items").notNull().default(1),
    failedItems: integer("failed_items").notNull().default(0),
    createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
  },
  (table) => [
    uniqueIndex("generation_usage_merchant_type_operation_key_unique").on(
      table.merchantId,
      table.operationType,
      table.operationKey,
    ),
    index("generation_usage_merchant_status_created_idx").on(table.merchantId, table.status, table.createdAt),
  ],
);

// 父流程的逐项执行记录。result 只允许保存已脱敏、可 JSON 序列化的公开响应；
// 绝不能写 AgentRuntimeConfig、API Key、Authorization 或供应商原始请求。
export const generationOperationItems = sqliteTable(
  "generation_operation_items",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    usageId: text("usage_id").notNull().references(() => generationUsage.id, { onDelete: "cascade" }),
    itemKey: text("item_key").notNull(),
    agentId: text("agent_id").notNull(),
    // 首次 claim 时由服务端对该子请求的安全 DTO 求 SHA-256；重放必须一致。
    requestHash: text("request_hash"),
    status: text("status", { enum: ["pending", "running", "succeeded", "failed"] })
      .notNull()
      .default("pending"),
    result: text("result", { mode: "json" }).$type<unknown>(),
    failureCode: text("failure_code"),
    attempts: integer("attempts").notNull().default(0),
    // pending 时是最终 claim 截止时间，running 时是有期租约；
    // 迟到的供应商结果不能覆盖已回收子项。
    leaseToken: text("lease_token"),
    leaseExpiresAt: integer("lease_expires_at", { mode: "timestamp" }),
    startedAt: integer("started_at", { mode: "timestamp" }),
    completedAt: integer("completed_at", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  },
  (table) => [
    uniqueIndex("generation_operation_items_usage_item_unique").on(table.usageId, table.itemKey),
    index("generation_operation_items_usage_status_idx").on(table.usageId, table.status),
    check(
      "generation_operation_items_status_check",
      sql`${table.status} IN ('pending', 'running', 'succeeded', 'failed')`,
    ),
    check("generation_operation_items_attempts_check", sql`${table.attempts} >= 0`),
  ],
);

// 项目表
export const projects = sqliteTable("projects", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  // 所属商家；可空是为了兼容多租户改造前的存量本地数据（迁移时未回填），新写入必须带值
  merchantId: text("merchant_id").references(() => merchants.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  status: text("status", { enum: ["draft", "scripting", "assets", "video", "composing", "done"] }).notNull().default("draft"),
  // 内容类型：product=带货（围绕商品），topic=主题成片（无商品，一句话主题→旁白脚本→免费素材自动配画面）
  contentType: text("content_type", { enum: ["product", "topic", "image_pack"] }).default("product"),
  // topic 模式下用户输入的一句话主题（如"在家如何泡一杯手冲咖啡"）
  topic: text("topic"),
  productName: text("product_name"),
  productCategory: text("product_category"),
  productDescription: text("product_description"),
  productPrice: text("product_price"), // 商品价格文案（如「¥39.9」「£63.00」，主要来自链接 ingest，用于商品卡贴片）
  shopUrl: text("shop_url"), // 商品购买/落地页链接，用于二维码、片尾 CTA 和投放归因
  affiliateCode: text("affiliate_code"), // 分佣/渠道码，生成商品链接时可自动追加
  productImages: text("product_images", { mode: "json" }).$type<string[]>().default([]),
  productAnalysis: text("product_analysis"), // LLM 视觉分析结果
  productId: text("product_id"), // 关联商品库（可选，也可直接填写）
  brandId: text("brand_id"), // 关联品牌设置
  templateId: text("template_id"), // 使用的脚本模板
  videoMode: text("video_mode", { enum: ["product_closeup", "graphic_montage", "scene_demo", "live_presenter"] }).default("product_closeup"), // 视频模式
  sourceType: text("source_type", { enum: ["manual", "clone"] }).default("manual"), // manual=手动创建, clone=爆款复刻
  sourceVideoUrl: text("source_video_url"), // 爆款复刻来源视频 URL
  characterId: text("character_id"), // 项目绑定的出镜人物（仅 live_presenter 模式）
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
});

// 脚本表
export const scripts = sqliteTable("scripts", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  version: integer("version").notNull().default(1),
  styleType: text("style_type", { enum: ["pain_point", "scene", "comparison", "story", "local", "custom"] }).notNull(),
  title: text("title"),
  totalDuration: integer("total_duration"), // 总时长（秒）
  shots: text("shots", { mode: "json" }).$type<Shot[]>().default([]),
  selected: integer("selected", { mode: "boolean" }).default(false),
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
});

// 效果回流：发布后人工录入的各条投放数据。录入时定格 style/category/platform，
// 便于按风格聚合「哪种更能卖」（项目后续改了也不污染历史样本）。
export const publishMetrics = sqliteTable(
  "publish_metrics",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    style: text("style").notNull(), // 脚本风格 key：pain_point/scene/comparison/story/custom
    hookId: text("hook_id"), // 钩子机制 id（= HookPattern.id），钩子 A/B 回流用，可空
    category: text("category"), // 品类（定格）
    platform: text("platform"), // douyin/tiktok/kuaishou/xiaohongshu/...
    views: integer("views").notNull().default(0),
    likes: integer("likes").notNull().default(0),
    comments: integer("comments").notNull().default(0),
    shares: integer("shares").notNull().default(0),
    orders: integer("orders").notNull().default(0), // 成交单数
    note: text("note"),
    publishedAt: integer("published_at", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
  },
  (table) => [uniqueIndex("publish_metrics_project_platform_unique").on(table.projectId, table.platform)]
);

// 发布前诊断表 —— 发布前按维度给脚本打"内容诊断分"+ 相对预测（数据飞轮第一环：
// 诊断分定格落库，与发布后回流的 publish_metrics 形成"预测 vs 实际"对照，供后续做校准升级）
export const contentDiagnosis = sqliteTable("content_diagnosis", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  scriptId: text("script_id"), // 被诊断的脚本 id（脚本重生成会删旧行，故不设外键，仅留追溯）
  style: text("style"), // 脚本风格 key（定格，同 publish_metrics.style 口径）
  platform: text("platform"), // 目标平台（当前先只做 douyin）
  overallScore: integer("overall_score").notNull(), // 0-100 总分（各维度均值）
  dimensions: text("dimensions", { mode: "json" }).$type<DiagnosisDimension[]>().default([]),
  summary: text("summary"), // 一句话总评
  suggestions: text("suggestions", { mode: "json" }).$type<string[]>().default([]), // 可执行的改进建议
  // 相对预测：只做"高于/持平/低于账号历史平均"的方向判断，绝不给绝对播放量；历史样本不足时为 null
  prediction: text("prediction", { enum: ["above", "average", "below"] }),
  predictionConfidence: text("prediction_confidence", { enum: ["low", "medium", "high"] }),
  predictionBasis: text("prediction_basis"), // 预测依据（样本数/账号基线），对商家透明展示
  source: text("source", { enum: ["llm", "rule"] }).notNull().default("llm"), // rule=LLM 不可用时本地规则兜底
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
});

// 单条视频复盘表 —— 回流数据到位后，结合"当时的诊断分 + 实际表现 + 账号基线"生成复盘
// （哪里好/哪里差/下条怎么改）。结论定位"待验证假设"；nextActions 摘要写进店铺记忆反哺下次生成。
export const videoRetros = sqliteTable("video_retros", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  diagnosisId: text("diagnosis_id"), // 当时的发布前诊断（可空：老板可能没做过诊断）
  style: text("style"), // 脚本风格 key（定格）
  platform: text("platform"),
  // 预测 vs 实际对照（校准的原始记录）：predicted 定格自当时诊断，actual 由代码按账号基线算
  predicted: text("predicted", { enum: ["above", "average", "below"] }),
  actual: text("actual", { enum: ["above", "average", "below"] }), // null=账号其他视频样本不足，无从对比
  actualBasis: text("actual_basis"), // 实际判断的依据（大白话，直接展示给商家）
  highlights: text("highlights", { mode: "json" }).$type<string[]>().default([]), // 这条做对了什么
  issues: text("issues", { mode: "json" }).$type<string[]>().default([]), // 哪里拖了后腿
  nextActions: text("next_actions", { mode: "json" }).$type<string[]>().default([]), // 下条试试（待验证假设）
  summary: text("summary"), // 一句话总结
  source: text("source", { enum: ["llm", "rule"] }).notNull().default("llm"), // rule=LLM 不可用时本地兜底
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
});

// 账号周报表 —— 按商家汇总"近7天 vs 再前7天"的回流数据、风格洞察和复盘经验，
// LLM 写成大白话周报（数字统计与趋势由代码算并定格进 stats，LLM 只负责讲成人话）
export const weeklyReports = sqliteTable("weekly_reports", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  merchantId: text("merchant_id").notNull().references(() => merchants.id, { onDelete: "cascade" }),
  periodStart: integer("period_start", { mode: "timestamp" }), // 本周窗口起点（生成时刻 - 7 天）
  periodEnd: integer("period_end", { mode: "timestamp" }), // 本周窗口终点（生成时刻）
  stats: text("stats", { mode: "json" }), // WeeklyReportData 快照（含上周对比与趋势），定格留证
  highlights: text("highlights", { mode: "json" }).$type<string[]>().default([]), // 这周的亮点
  watchouts: text("watchouts", { mode: "json" }).$type<string[]>().default([]), // 要注意的
  nextActions: text("next_actions", { mode: "json" }).$type<string[]>().default([]), // 下周怎么干
  summary: text("summary"), // 一句话总结
  source: text("source", { enum: ["llm", "rule"] }).notNull().default("llm"), // rule=LLM 不可用时本地兜底
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
});

// 素材表
export const assets = sqliteTable("assets", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  shotId: integer("shot_id").notNull(), // 对应分镜序号
  // stock_footage = 版权素材库（如 Pexels）检索下载的免费可商用视频/图片
  type: text("type", { enum: ["ai_generated", "product_image", "user_upload", "stock_footage"] }).notNull(),
  filePath: text("file_path"),
  thumbnailPath: text("thumbnail_path"),
  provider: text("provider"),
  model: text("model"),
  prompt: text("prompt"),
  // 素材来源信息（stock_footage 合规必需：留存出处链接/作者/授权，导出时生成 credits）
  sourceUrl: text("source_url"), // 素材来源页 URL（如 Pexels 视频详情页）
  author: text("author"), // 素材作者（署名用）
  license: text("license"), // 授权类型，如 "Pexels"
  licenseUrl: text("license_url"),
  attributionText: text("attribution_text"),
  requiresAttribution: integer("requires_attribution", { mode: "boolean" }),
  status: text("status", { enum: ["pending", "generating", "done", "failed"] }).notNull().default("pending"),
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
});

// 视频片段表
export const videoClips = sqliteTable("video_clips", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  shotId: integer("shot_id").notNull(),
  assetId: text("asset_id").references(() => assets.id),
  filePath: text("file_path"),
  duration: integer("duration"), // 毫秒
  provider: text("provider"),
  model: text("model"),
  transitionType: text("transition_type", { enum: ["ai_start_end", "ai_reference", "direct_concat", "ffmpeg_fade"] }).default("ai_start_end"),
  status: text("status", { enum: ["pending", "generating", "done", "failed"] }).notNull().default("pending"),
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
});

// 合成输出表
export const compositions = sqliteTable(
  "compositions",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    outputPath: text("output_path"),
    resolution: text("resolution", { enum: ["720p", "1080p"] }).default("1080p"),
    aspectRatio: text("aspect_ratio", { enum: ["9:16", "16:9", "1:1"] }).default("9:16"), // 竖屏为主
    duration: integer("duration"), // 毫秒
    bgmPath: text("bgm_path"),
    ttsEnabled: integer("tts_enabled", { mode: "boolean" }).default(false),
    aigcDisclosure: integer("aigc_disclosure", { mode: "boolean" }).notNull().default(true),
    credits: text("credits", { mode: "json" }).$type<MediaCredit[]>().default([]),
    subtitleStyle: text("subtitle_style", { mode: "json" }).$type<SubtitleStyle>(),
    status: text("status", { enum: ["pending", "composing", "done", "failed"] }).notNull().default("pending"),
    createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
  },
  (table) => [index("compositions_project_created_idx").on(table.projectId, table.createdAt)],
);

// 通用持久任务表 —— 首个任务类型是 compose，后续图片/视频/批处理可复用同一套幂等、租约与恢复语义。
// payload 只能写业务输入快照，严禁保存 API Key、session、完整 AgentRuntimeConfig 等秘密。
export const jobs = sqliteTable(
  "jobs",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    type: text("type").notNull(),
    merchantId: text("merchant_id").notNull().references(() => merchants.id, { onDelete: "cascade" }),
    projectId: text("project_id").references(() => projects.id, { onDelete: "cascade" }),
    compositionId: text("composition_id").references(() => compositions.id, { onDelete: "cascade" }),
    idempotencyKey: text("idempotency_key").notNull(),
    // 冻结安全 payload 的 SHA-256；同幂等键但请求不同必须 409。
    requestHash: text("request_hash"),
    // 仅 payload.options.agentTts=true 时绑定 workflow 额度父流水；free TTS/纯 FFmpeg 为空。
    generationUsageId: text("generation_usage_id").references(() => generationUsage.id, { onDelete: "set null" }),
    // 至少一段付费 TTS 已成功原子落盘（或按可信 provenance 复用）后才为 true。
    paidTtsUsed: integer("paid_tts_used", { mode: "boolean" }).notNull().default(false),
    payloadVersion: integer("payload_version").notNull().default(1),
    payload: text("payload", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    result: text("result", { mode: "json" }).$type<Record<string, unknown>>(),
    status: text("status", { enum: ["pending", "running", "succeeded", "failed", "cancelled"] })
      .notNull()
      .default("pending"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(2),
    availableAt: integer("available_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
    leaseOwner: text("lease_owner"),
    leaseToken: text("lease_token"),
    lockedAt: integer("locked_at", { mode: "timestamp" }),
    leaseExpiresAt: integer("lease_expires_at", { mode: "timestamp" }),
    heartbeatAt: integer("heartbeat_at", { mode: "timestamp" }),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    startedAt: integer("started_at", { mode: "timestamp" }),
    finishedAt: integer("finished_at", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  },
  (table) => [
    uniqueIndex("jobs_merchant_type_idempotency_unique").on(
      table.merchantId,
      table.type,
      table.idempotencyKey,
    ),
    uniqueIndex("jobs_composition_unique").on(table.compositionId),
    uniqueIndex("jobs_generation_usage_unique").on(table.generationUsageId),
    index("jobs_status_available_created_idx").on(table.status, table.availableAt, table.createdAt),
    index("jobs_status_lease_idx").on(table.status, table.leaseExpiresAt),
    index("jobs_merchant_status_idx").on(table.merchantId, table.status),
    index("jobs_project_status_idx").on(table.projectId, table.status),
    check(
      "jobs_status_check",
      sql`${table.status} IN ('pending', 'running', 'succeeded', 'failed', 'cancelled')`,
    ),
    check("jobs_attempts_check", sql`${table.attempts} >= 0`),
    check("jobs_max_attempts_check", sql`${table.maxAttempts} > 0`),
    check(
      "jobs_running_lease_check",
      sql`${table.status} <> 'running' OR (${table.leaseOwner} IS NOT NULL AND ${table.leaseToken} IS NOT NULL AND ${table.leaseExpiresAt} IS NOT NULL)`,
    ),
  ],
);

// Golden 媒体评测任务与商家生成任务分开存储：这是管理员对 draft 候选的付费评测，
// 不应伪造 merchantId，也不占用商家套餐额度。payload 只保存无密钥的候选快照和指纹。
// submitting 是唯一可以执行付费 POST 的状态；该状态租约过期且没有 remoteTaskId 时，
// 恢复器必须终止为 submission_uncertain，绝不能重提产生第二笔费用。
export const goldenMediaEvalJobs = sqliteTable(
  "golden_media_eval_jobs",
  {
    // 与最终 AgentEvalRecord.id 共用，便于产物目录和人工评分稳定引用。
    id: text("id").primaryKey(),
    idempotencyKey: text("idempotency_key").notNull(),
    requestHash: text("request_hash").notNull(),
    agentId: text("agent_id").notNull(),
    caseId: text("case_id").notNull(),
    candidateRole: text("candidate_role", { enum: ["primary", "fallback"] }).notNull(),
    candidateKey: text("candidate_key").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    promptVersion: text("prompt_version").notNull(),
    strategyRevision: integer("strategy_revision").notNull(),
    requestKind: text("request_kind", {
      enum: ["image-generation", "video-generation", "tts-generation"],
    }).notNull(),
    payloadVersion: integer("payload_version").notNull().default(1),
    payload: text("payload", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    status: text("status", {
      enum: [
        "pending",
        "submitting",
        "submitted",
        "polling",
        "succeeded",
        "failed",
        "submission_uncertain",
      ],
    }).notNull().default("pending"),
    remoteTaskId: text("remote_task_id"),
    result: text("result", { mode: "json" }).$type<Record<string, unknown>>(),
    artifactUrls: text("artifact_urls", { mode: "json" }).$type<string[]>().default([]),
    pollAttempts: integer("poll_attempts").notNull().default(0),
    maxPollAttempts: integer("max_poll_attempts").notNull().default(240),
    availableAt: integer("available_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
    leaseOwner: text("lease_owner"),
    leaseToken: text("lease_token"),
    leaseExpiresAt: integer("lease_expires_at", { mode: "timestamp" }),
    heartbeatAt: integer("heartbeat_at", { mode: "timestamp" }),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    startedAt: integer("started_at", { mode: "timestamp" }),
    submittedAt: integer("submitted_at", { mode: "timestamp" }),
    finishedAt: integer("finished_at", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  },
  (table) => [
    uniqueIndex("golden_media_eval_jobs_idempotency_unique").on(table.idempotencyKey),
    index("golden_media_eval_jobs_status_available_idx").on(table.status, table.availableAt, table.createdAt),
    index("golden_media_eval_jobs_status_lease_idx").on(table.status, table.leaseExpiresAt),
    index("golden_media_eval_jobs_case_candidate_idx").on(table.caseId, table.candidateKey, table.createdAt),
    check(
      "golden_media_eval_jobs_status_check",
      sql`${table.status} IN ('pending', 'submitting', 'submitted', 'polling', 'succeeded', 'failed', 'submission_uncertain')`,
    ),
    check("golden_media_eval_jobs_poll_attempts_check", sql`${table.pollAttempts} >= 0`),
    check("golden_media_eval_jobs_max_poll_attempts_check", sql`${table.maxPollAttempts} > 0`),
    check(
      "golden_media_eval_jobs_active_lease_check",
      sql`${table.status} NOT IN ('submitting', 'polling') OR (${table.leaseOwner} IS NOT NULL AND ${table.leaseToken} IS NOT NULL AND ${table.leaseExpiresAt} IS NOT NULL)`,
    ),
    check(
      "golden_media_eval_jobs_remote_task_check",
      sql`${table.status} NOT IN ('submitted', 'polling') OR ${table.remoteTaskId} IS NOT NULL`,
    ),
    check(
      "golden_media_eval_jobs_succeeded_checkpoint_check",
      sql`${table.status} <> 'succeeded' OR ${table.remoteTaskId} IS NOT NULL OR ${table.requestKind} = 'tts-generation'`,
    ),
  ],
);

// 商家分镜图转动态的持久任务。与管理端 Golden 队列隔离，但沿用同一条安全边界：
// submitting 是唯一允许执行付费 POST 的状态；POST 返回 taskId 后必须先 checkpoint，
// 才能释放租约进入只读 GET 轮询。若 submitting 租约过期且没有 taskId，则结果不可判定，
// 必须终止为 submission_uncertain，绝不能自动重提产生第二笔费用。
export const motionVideoJobs = sqliteTable(
  "motion_video_jobs",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    merchantId: text("merchant_id").notNull().references(() => merchants.id, { onDelete: "cascade" }),
    projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    generationUsageId: text("generation_usage_id").references(() => generationUsage.id, { onDelete: "set null" }),
    generationItemId: text("generation_item_id").references(() => generationOperationItems.id, { onDelete: "set null" }),
    operationKey: text("operation_key").notNull(),
    itemKey: text("item_key").notNull(),
    requestHash: text("request_hash").notNull(),
    shotId: integer("shot_id").notNull(),
    sourceAssetId: text("source_asset_id").references(() => assets.id, { onDelete: "set null" }),
    // 只保存业务参数、资格/图片 hash、公开模型端点快照和 secretRef；禁止 API Key/Authorization。
    payloadVersion: integer("payload_version").notNull().default(1),
    payload: text("payload", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    status: text("status", {
      enum: [
        "pending",
        "submitting",
        "submitted",
        "polling",
        "downloading",
        "saving",
        "succeeded",
        "failed",
        "submission_uncertain",
      ],
    }).notNull().default("pending"),
    remoteTaskId: text("remote_task_id"),
    result: text("result", { mode: "json" }).$type<Record<string, unknown>>(),
    // succeeded 必须保留 outputClipId；删除被引用 clip 应明确拒绝，而非 SET NULL 后撞 CHECK。
    outputClipId: text("output_clip_id").references(() => videoClips.id, { onDelete: "restrict" }),
    outputFilePath: text("output_file_path"),
    progress: integer("progress"),
    pollAttempts: integer("poll_attempts").notNull().default(0),
    maxPollAttempts: integer("max_poll_attempts").notNull().default(240),
    paidCapabilityUsed: integer("paid_capability_used", { mode: "boolean" }).notNull().default(false),
    availableAt: integer("available_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
    leaseOwner: text("lease_owner"),
    leaseToken: text("lease_token"),
    leaseExpiresAt: integer("lease_expires_at", { mode: "timestamp" }),
    heartbeatAt: integer("heartbeat_at", { mode: "timestamp" }),
    errorCode: text("error_code"),
    errorCategory: text("error_category"),
    errorRequestId: text("error_request_id"),
    errorMessage: text("error_message"),
    errorRetryable: integer("error_retryable", { mode: "boolean" }),
    retryAfterSeconds: integer("retry_after_seconds"),
    suggestedAction: text("suggested_action"),
    startedAt: integer("started_at", { mode: "timestamp" }),
    submittedAt: integer("submitted_at", { mode: "timestamp" }),
    finishedAt: integer("finished_at", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  },
  (table) => [
    uniqueIndex("motion_video_jobs_merchant_operation_item_unique").on(
      table.merchantId,
      table.operationKey,
      table.itemKey,
    ),
    uniqueIndex("motion_video_jobs_generation_item_unique").on(table.generationItemId),
    index("motion_video_jobs_status_available_idx").on(table.status, table.availableAt, table.createdAt),
    index("motion_video_jobs_status_lease_idx").on(table.status, table.leaseExpiresAt),
    index("motion_video_jobs_merchant_project_created_idx").on(
      table.merchantId,
      table.projectId,
      table.createdAt,
    ),
    index("motion_video_jobs_project_shot_created_idx").on(table.projectId, table.shotId, table.createdAt),
    check(
      "motion_video_jobs_status_check",
      sql`${table.status} IN ('pending', 'submitting', 'submitted', 'polling', 'downloading', 'saving', 'succeeded', 'failed', 'submission_uncertain')`,
    ),
    check("motion_video_jobs_shot_id_check", sql`${table.shotId} >= 0`),
    check("motion_video_jobs_poll_attempts_check", sql`${table.pollAttempts} >= 0`),
    check("motion_video_jobs_max_poll_attempts_check", sql`${table.maxPollAttempts} > 0`),
    check(
      "motion_video_jobs_progress_check",
      sql`${table.progress} IS NULL OR (${table.progress} >= 0 AND ${table.progress} <= 100)`,
    ),
    check(
      "motion_video_jobs_active_lease_check",
      sql`${table.status} NOT IN ('submitting', 'polling', 'downloading', 'saving') OR (${table.leaseOwner} IS NOT NULL AND ${table.leaseToken} IS NOT NULL AND ${table.leaseExpiresAt} IS NOT NULL)`,
    ),
    check(
      "motion_video_jobs_remote_task_check",
      sql`${table.status} NOT IN ('submitted', 'polling', 'downloading', 'saving', 'succeeded') OR ${table.remoteTaskId} IS NOT NULL`,
    ),
    check(
      "motion_video_jobs_succeeded_output_check",
      sql`${table.status} <> 'succeeded' OR (${table.outputClipId} IS NOT NULL AND ${table.outputFilePath} IS NOT NULL)`,
    ),
  ],
);

// 每张已落库分镜图的最新动态资格快照。页面读取它即可在提交视频任务前展示
// AI 动态/轻运镜/需重生/人工复核；图片内容 hash、检测器或规则 revision 变化时必须重评。
export const motionAssetAssessments = sqliteTable(
  "motion_asset_assessments",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    merchantId: text("merchant_id").notNull().references(() => merchants.id, { onDelete: "cascade" }),
    projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    assetId: text("asset_id").notNull().references(() => assets.id, { onDelete: "cascade" }),
    shotId: integer("shot_id").notNull(),
    imageRef: text("image_ref").notNull(),
    imageHash: text("image_hash").notNull(),
    mediaKind: text("media_kind", { enum: ["image", "video", "unknown"] }).notNull(),
    width: integer("width"),
    height: integer("height"),
    policy: text("policy", {
      enum: ["ai_video", "static_pan", "regenerate_faceless", "use_existing_video"],
    }).notNull(),
    eligibilityState: text("eligibility_state", {
      enum: ["eligible", "fallback", "regenerate_required", "manual_review"],
    }).notNull(),
    eligibilityReason: text("eligibility_reason").notNull(),
    eligibilityRevision: text("eligibility_revision").notNull(),
    sourceModelRevision: text("source_model_revision").notNull(),
    faceStatus: text("face_status", {
      enum: ["clear", "face_detected", "review_required", "not_applicable"],
    }).notNull(),
    faceCheckedImageHash: text("face_checked_image_hash"),
    faceDetectorRevision: text("face_detector_revision").notNull(),
    faceSource: text("face_source", { enum: ["detector", "manual", "unavailable"] }).notNull(),
    faceConfidencePermille: integer("face_confidence_permille"),
    faceCount: integer("face_count"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  },
  (table) => [
    uniqueIndex("motion_asset_assessments_asset_unique").on(table.assetId),
    index("motion_asset_assessments_merchant_project_shot_idx").on(
      table.merchantId,
      table.projectId,
      table.shotId,
    ),
    check("motion_asset_assessments_shot_id_check", sql`${table.shotId} >= 0`),
    check(
      "motion_asset_assessments_hash_check",
      sql`length(${table.imageHash}) = 64 AND ${table.imageHash} NOT GLOB '*[^0-9a-f]*'`,
    ),
    check(
      "motion_asset_assessments_face_confidence_check",
      sql`${table.faceConfidencePermille} IS NULL OR (${table.faceConfidencePermille} >= 0 AND ${table.faceConfidencePermille} <= 1000)`,
    ),
    check(
      "motion_asset_assessments_dimensions_check",
      sql`(${table.width} IS NULL OR ${table.width} > 0) AND (${table.height} IS NULL OR ${table.height} > 0)`,
    ),
  ],
);

// 商品库表 — 跨项目复用的商品信息
export const products = sqliteTable("products", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  merchantId: text("merchant_id").references(() => merchants.id, { onDelete: "cascade" }),
  name: text("name").notNull(), // 商品名称
  category: text("category", { enum: ["beauty", "food", "home", "fashion", "tech", "other"] }).notNull(),
  description: text("description"), // 卖点描述
  images: text("images", { mode: "json" }).$type<string[]>().default([]), // 商品图 URL 列表
  price: text("price"), // 价格信息（如"59.9元"、"199-299元"）
  targetAudience: text("target_audience"), // 目标人群
  analysis: text("analysis"), // LLM 视觉分析结果（缓存）
  videoCount: integer("video_count").default(0), // 已生成的视频数量
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
});

// 品牌设置表 — 统一的品牌视觉标识
export const brandSettings = sqliteTable("brand_settings", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  merchantId: text("merchant_id").references(() => merchants.id, { onDelete: "cascade" }),
  name: text("name").notNull(), // 品牌/店铺名
  logoPath: text("logo_path"), // logo 图片路径
  primaryColor: text("primary_color"), // 品牌主色（hex）
  secondaryColor: text("secondary_color"), // 品牌辅色
  fontFamily: text("font_family"), // 首选字体
  watermark: text("watermark", { mode: "json" }).$type<WatermarkConfig>(), // 水印配置
  introTemplatePath: text("intro_template_path"), // 片头模板路径
  outroTemplatePath: text("outro_template_path"), // 片尾模板路径
  isDefault: integer("is_default", { mode: "boolean" }).default(true),
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
});

// 脚本模板表 — 用户保存的成功脚本模板
export const scriptTemplates = sqliteTable("script_templates", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  name: text("name").notNull(), // 模板名称
  description: text("description"), // 模板描述
  category: text("category"), // 适用品类
  videoMode: text("video_mode"), // 适用视频模式
  styleType: text("style_type"), // 脚本风格
  shots: text("shots", { mode: "json" }).$type<Shot[]>().default([]), // 脚本结构（shot 的 prompt 会被替换）
  sourceProjectId: text("source_project_id"), // 来源项目
  useCount: integer("use_count").default(0), // 被使用次数
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
});

// 素材 RAG 知识库表 — 轻量素材检索的语料底座
// 种子来源：品类脚本模板（结构）、黄金3秒钩子（表达）、同城热点选题（场景）、品类指令，
// 后续可增量灌入用户沉淀模板与高转化回流样本（source 区分）。
// 设计取舍：规模在千级样本，用 SQLite 存 embedding BLOB + 内存余弦即可，不引入向量数据库。
export const ragSamples = sqliteTable(
  "rag_samples",
  {
    id: text("id").primaryKey(), // 稳定 id（种子用确定性 id，便于幂等重灌与评测标注）
    industry: text("industry"), // 行业（预留，当前与 category 同源，留给未来更细分层）
    category: text("category"), // 品类：beauty/food/home/fashion/tech；null=通用（如通用钩子）
    scene: text("scene"), // 营销场景，如 "妆前妆后对比"、"同城探店"、"深夜食堂"
    platform: text("platform"), // 适用平台：douyin/xiaohongshu/...；null=通用
    styleType: text("style_type"), // 内容方向/脚本风格：pain_point/comparison/mood/local/...；null=通用
    videoMode: text("video_mode"), // 适用视频模式：product_closeup/scene_demo/...；null=通用
    storeType: text("store_type"), // 经营形态适配：ecommerce/local/both；null=通用（电商与同城分流的硬边界）
    structure: text("structure", { mode: "json" }).$type<RagSampleStructure | null>(), // 分镜结构骨架（结构类样本）
    expression: text("expression"), // 优质表达文本（钩子/场景/示例台词）
    searchText: text("search_text").notNull(), // 拼接后的检索文本（embedding 与词法回退都基于它）
    embedding: text("embedding", { mode: "json" }).$type<number[] | null>(), // 预计算向量（float 数组，JSON 存储；千级规模够用）
    embeddingModel: text("embedding_model"), // 生成 embedding 的编码器标识，用于避免跨编码器维度错配
    source: text("source", {
      enum: ["template", "hook", "local_trend", "category_directive", "user_template", "metrics_top"],
    }).notNull(),
    seedVersion: integer("seed_version").notNull().default(1), // 种子版本；知识库刷新后据此幂等重灌
    createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
  },
  (table) => [
    index("rag_samples_source_seed_idx").on(table.source, table.seedVersion),
    index("rag_samples_category_store_idx").on(table.category, table.storeType),
  ],
);

// 人物/角色表 — 跨项目复用的出镜人物
export const characters = sqliteTable("characters", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  name: text("name").notNull(), // 人物名称，如"小美"
  description: text("description"), // 简短描述，如"25岁女生，活泼开朗"
  appearance: text("appearance"), // 外貌特征（用于注入 AI prompt）
  referenceImages: text("reference_images", { mode: "json" }).$type<string[]>().default([]), // 参考图 URL 列表
  voiceProfile: text("voice_profile", { mode: "json" }).$type<CharacterVoiceProfile>(), // 声音偏好
  isDefault: integer("is_default", { mode: "boolean" }).default(false), // 是否为默认出镜人物
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
});

// 设置表
export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value", { mode: "json" }),
  updatedAt: integer("updated_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
});

// ===== 类型定义 =====

/** 视频模式：决定素材生成策略 */
export type VideoMode =
  | "product_closeup"   // 产品特写：商品原图 + 运动特效，真实感最高
  | "graphic_montage"   // 图文混剪：商品图 + 文字卡片 + 转场动画
  | "scene_demo"        // 场景演示：AI 生成使用场景（不含人脸）
  | "live_presenter";   // 真人出镜：人物出镜讲解（需要角色或用户上传素材）

export interface Shot {
  shotId: number;
  type: "hook" | "pain_point" | "product_reveal" | "demo" | "social_proof" | "cta";
  duration: number; // 秒
  description: string; // 画面描述
  camera: string; // 镜头运动
  visualSource: "ai_generate" | "product_image" | "user_upload";
  transition: "ai_start_end" | "ai_reference" | "direct_concat" | "ffmpeg_fade";
  voiceover: string; // 配音文案
  prompt?: string; // AI 生图/生视频 prompt
  /** 该分镜的英文素材检索词（1-3 个），用于从免费素材库自动配画面（无商品主题成片的关键） */
  stockKeywords?: string[];
  /** 出镜人物 ID，关联 characters 表（可选） */
  characterId?: string;
  /** 运动效果，仅 product_image 类型使用 */
  motion?: "zoom_in_slow" | "pan_left" | "pan_right" | "ken_burns" | "static";
  /** 文字叠加层（图文混剪模式） */
  textOverlay?: {
    text: string;
    style: "title" | "subtitle" | "highlight" | "price";
  };
}

/** RAG 样本的分镜结构骨架（结构类样本用；只留骨架，不含具体文案） */
export interface RagSampleStructure {
  /** 结构名称，如 "素颜逆袭" */
  name: string;
  /** 一句话结构说明 */
  summary?: string;
  /** 分镜骨架：镜头类型 + 时长（秒） + 可选镜头运动 */
  shots: Array<{ type: string; duration: number; camera?: string }>;
}

/** 发布前诊断的单个维度得分（key 枚举见 后端/core/publish/content-diagnosis.ts） */
export interface DiagnosisDimension {
  /** hook / clarity / pacing / copy / cta */
  key: string;
  /** 0-100 */
  score: number;
  /** 该维度的一句话评语 */
  comment: string;
}

/** 人物声音偏好 */
export interface CharacterVoiceProfile {
  /** 声音风格描述，如"温柔女声"、"专业男声" */
  style: string;
  /** 语速偏好 0.8-1.5 */
  speed?: number;
  /** 情感倾向 */
  emotion?: "neutral" | "happy" | "serious" | "energetic";
}

/** 水印配置 */
export interface WatermarkConfig {
  /** 是否启用 */
  enabled: boolean;
  /** 位置 */
  position: "top-left" | "top-right" | "bottom-left" | "bottom-right";
  /** 透明度 0-1 */
  opacity: number;
  /** 缩放比例 0.1-0.5 */
  scale: number;
}

export interface SubtitleStyle {
  fontFamily: string;
  fontSize: number;
  color: string;
  strokeColor: string;
  strokeWidth: number;
  position: "bottom" | "center" | "top";
}
