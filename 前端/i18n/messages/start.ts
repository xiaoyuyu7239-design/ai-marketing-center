import type { NamespaceMessages } from "../config";

// start 命名空间词条（落地页「先做后配」/start）
export const start: NamespaceMessages = {
  zh: {
    // 顶部导航
    navProducts: "生成库存",
    navBatch: "批量",
    navSettings: "设置",
    // 主视觉
    eyebrow: "",
    h1Lead: "上传商品图，",
    h1Highlight: "先出短片方案",
    sub: "上传商品图后先生成可编辑脚本；确认方案后，可一键配免费素材、配音并提交合成。模型由绘卖工作人员统一维护。",
    quickPlaceholder: "输入文字描述",
    uploadAria: "上传商品图",
    uploadedCount: "已选择 {count} 张图",
    clearUpload: "清除",
    // 模式切换
    tabUpload: "上传商品图",
    tabTopic: "一句话成片",
    // 上传模式
    dropTitle: "拖入商品图，或点击上传",
    dropSub: "JPG / PNG，最多 5 张 · 没素材？下面点个示例",
    imgAlt: "商品图",
    removeAria: "删除",
    productNamePlaceholder: "商品名称（必填，如：便携榨汁杯）",
    sellingPointsPlaceholder: "核心卖点（选填）——填了脚本更精准",
    // 一句话模式
    topicPlaceholder: "说个主题，如：3 个让租房变高级的小物 / 冬天必囤的护手霜",
    // 未配 Key 提示
    keyboxText: "邀请内测的模型由绘卖工作人员统一维护，商家无需填写 API Key。",
    keyboxCta: "查看内测帮助",
    // Atlas 一键接入（落地页内联，免跳设置）
    atlasBadge: "工作人员配置",
    atlasTitle: "邀请内测统一模型策略",
    atlasDesc: "脚本、图片、视频和配音由绘卖后台按评测结果维护。",
    atlasGetKey: "查看内测帮助",
    atlasKeyPlaceholder: "商家端不接收模型 API Key",
    atlasConnectStart: "开始创作",
    atlasConnecting: "连接中…",
    atlasUseOther: "需要调整模型供应商？请联系绘卖工作人员。",
    atlasKeyInvalid: "Key 无效或无权限，请检查后重试",
    atlasConnectFailed: "连接失败，请检查网络后重试",
    // 主按钮 + 安心文案
    ctaStart: "上传商品图 开始创作",
    workspaceCtaAria: "进入创作工作台",
    openingUpload: "打开中…",
    busyDefault: "生成中…",
    reassureLead: "无需自备模型 Key，",
    reassureTail: "脚本、素材与合成策略由绘卖统一维护。",
    // 生成阶段提示
    stageCreate: "创建项目…",
    stageUpload: "上传商品图…",
    stageScript: "AI 写脚本…",
    // 错误提示
    errTopicScript: "生成失败，请检查 LLM 配置",
    errProjectCreate: "项目创建失败，请重试",
    errUpload: "图片上传失败，请检查网络",
    errScript: "脚本生成失败，请检查 LLM 配置",
    errGeneric: "出错了，请重试",
    // 示例
    examplesLabel: "没素材，先试试",
    // 最近项目
    recentLabel: "继续未完成的项目",
    untitledProject: "未命名项目",
    // 高级入口
    advLink: "高级设置 · 多平台 / 自定义模型 / 生成参数 ›",
    // 新建项目默认名（{name} 为商品名）
    projectName: "{name} 推广",
  },
  en: {
    // 顶部导航
    navProducts: "Generated inventory",
    navBatch: "Batch",
    navSettings: "Settings",
    // 主视觉
    eyebrow: "",
    h1Lead: "Upload a product photo, ",
    h1Highlight: "get a short-video plan",
    sub: "Upload a product photo to get an editable script first. After review, fill free visuals, voiceover, and submit rendering in one step. Models are managed by the Huimai team.",
    quickPlaceholder: "Describe with text",
    uploadAria: "Upload product images",
    uploadedCount: "{count} image(s) selected",
    clearUpload: "Clear",
    // 模式切换
    tabUpload: "Upload product photo",
    tabTopic: "One-sentence video",
    // 上传模式
    dropTitle: "Drop a product photo, or click to upload",
    dropSub: "JPG / PNG, up to 5 · No assets? Pick an example below",
    imgAlt: "Product photo",
    removeAria: "Remove",
    productNamePlaceholder: "Product name (required, e.g. Portable juicer cup)",
    sellingPointsPlaceholder: "Key selling points (optional) — sharper script if filled",
    // 一句话模式
    topicPlaceholder: "Type a topic, e.g. 3 small things that make a rental feel upscale / must-stock hand creams for winter",
    // 未配 Key 提示
    keyboxText: "Model access is managed by the Huimai team during invite-only beta. Merchants never need to enter an API key.",
    keyboxCta: "Beta help",
    // Atlas 一键接入（落地页内联，免跳设置）
    atlasBadge: "Staff managed",
    atlasTitle: "Managed model strategy for invite beta",
    atlasDesc: "Huimai staff maintain evaluated providers for scripts, images, video, and voiceover.",
    atlasGetKey: "Open beta help",
    atlasKeyPlaceholder: "Merchant clients do not accept model API keys",
    atlasConnectStart: "Start creating",
    atlasConnecting: "Connecting…",
    atlasUseOther: "Contact Huimai staff to change model providers.",
    atlasKeyInvalid: "Key invalid or unauthorized — check and retry",
    atlasConnectFailed: "Connection failed — check your network and retry",
    // 主按钮 + 安心文案
    ctaStart: "Upload a photo to start",
    workspaceCtaAria: "Open creator workspace",
    openingUpload: "Opening…",
    busyDefault: "Generating…",
    reassureLead: "No model key required. ",
    reassureTail: "Huimai manages script, media, and rendering providers for the beta.",
    // 生成阶段提示
    stageCreate: "Creating project…",
    stageUpload: "Uploading product photos…",
    stageScript: "AI is writing the script…",
    // 错误提示
    errTopicScript: "Generation failed. Check your LLM settings",
    errProjectCreate: "Failed to create project. Please try again",
    errUpload: "Image upload failed. Check your network",
    errScript: "Script generation failed. Check your LLM settings",
    errGeneric: "Something went wrong. Please try again",
    // 示例
    examplesLabel: "No assets? Try one",
    // 最近项目
    recentLabel: "Continue an unfinished project",
    untitledProject: "Untitled project",
    // 高级入口
    advLink: "Advanced · multi-platform / custom models / generation params ›",
    // 新建项目默认名（{name} 为商品名）
    projectName: "{name} Promo",
  },
};
