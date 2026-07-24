# ClipForge 前端白话手册

这份手册只看前端分类内容。总手册见 `ClipForge-白话详细手册.md`。

## 前端一句话

ClipForge 前端是一个短视频工厂操作台：用户从 `/start` 投入商品图或一句话主题，页面把任务一步步送去脚本、素材、合成、导出这些后端窗口。

术语提示：
- [Client Component：需要浏览器参与交互的页面积木]
- [App Router：Next.js 用文件夹当路牌的路由系统]
- [Zustand：浏览器里的轻量设置抽屉]
- [localStorage：浏览器自带的小保险柜]

## 页面地图

| 页面 | 文件 | 白话职责 | 主要后端接口 |
|---|---|---|---|
| 起步页 | `src/app/start/page.tsx` | 最短路径：上传商品图或一句话主题后直接开工。 | `/api/project`, `/api/upload`, `/api/llm/script`, `/api/topic/script` |
| 首页 | `src/app/page.tsx` | 项目入口和展示门面。 | `/api/project` |
| 设置页 | `src/app/settings/page.tsx` | 管理 AI 平台、LLM、TTS、默认模型、语言等。 | `/api/ai/test-provider`, `/api/ai/models`, `/api/llm/test`, `/api/tts` |
| 商品库 | `src/app/products/page.tsx` | 保存可复用商品资料和图片。 | `/api/products/upload` |
| 批量出片 | `src/app/batch/page.tsx` | 多商品并发跑“建项目→脚本→素材→合成”。 | `/api/project`, `/api/llm/script`, `/api/project/:id/stock-fill`, `/api/project/:id/compose` |
| 新建项目 | `src/app/project/new/page.tsx` | 传统完整表单，支持商品链接导入和模板参数。 | `/api/ingest/product`, `/api/project`, `/api/upload`, `/api/llm/script` |
| 主题成片 | `src/app/project/topic/page.tsx` | 只输入主题生成去商品化脚本。 | `/api/topic/script` |
| 脚本页 | `src/app/project/[id]/script/page.tsx` | 查看/选择脚本，重试生成，做发布前自检。 | `/api/project/:id`, `/api/project/:id/scripts`, `/api/llm/script`, `/api/topic/script` |
| 素材页 | `src/app/project/[id]/assets/page.tsx` | 给每个分镜配商品图、AI 图、AI 视频或免费素材。 | `/api/ai/models`, `/api/ai/image`, `/api/ai/video`, `/api/project/:id/assets`, `/api/project/:id/stock-fill` |
| 合成页 | `src/app/project/[id]/video/page.tsx` | 选择配音、BGM、字幕、贴片并发起 FFmpeg 合成。 | `/api/tts/free`, `/api/project/:id/bgm`, `/api/project/:id/compose` |
| 导出页 | `src/app/project/[id]/export/page.tsx` | 下载成片、多平台版本、发布文案、效果回填。 | `/api/project/:id/compose`, `/api/llm/publish`, `/api/project/:id/export-platform`, `/api/project/:id/metrics` |

## 用户主流程

```mermaid
flowchart LR
    A[/start 投料] --> B[创建项目]
    B --> C[上传商品图或创建主题项目]
    C --> D[生成脚本]
    D --> E[脚本页选方案]
    E --> F[素材页配画面]
    F --> G[视频页合成]
    G --> H[导出页下载/发布]
```

关键源码锚点：
- `src/app/start/page.tsx:126-180`：一键开始的核心链路。
- `src/app/project/[id]/script/page.tsx:75-120`：读取真实脚本，不再回退到假示例。
- `src/app/project/[id]/assets/page.tsx:151-173`：免费素材自动配画面。
- `src/app/project/[id]/assets/page.tsx:313-426`：单分镜素材生成。
- `src/app/project/[id]/video/page.tsx:265-347`：提交合成并轮询结果。
- `src/app/project/[id]/export/page.tsx:122-153`：发布文案的 AI/模板双路径。

## 前端状态

| 状态区域 | 文件 | 白话说明 |
|---|---|---|
| AI/LLM/TTS 设置 | `src/lib/stores/settings-store.ts:14-42` | 抽屉里放平台 Key、模型名、TTS 音色。 |
| 设置持久化 | `src/lib/stores/settings-store.ts:89-179` | 写到 `daihuo-jianshou-settings`，刷新页面不丢。 |
| Atlas 一键接入 | `src/lib/stores/settings-store.ts:146-173` | 一把 Key 同时填 LLM、生图、生视频、TTS。 |
| 商品库 | `src/lib/stores/product-library-store.ts` | 前端维护跨项目复用的商品资料。 |
| 模板库 | `src/lib/stores/template-store.ts` | 保存跑得好的脚本结构。 |
| 品牌设置 | `src/lib/stores/brand-store.ts` | Logo、颜色、水印等品牌统一信息。 |

## 前端调用契约

前端调用后端时遵守三条规矩：

1. JSON API 都加 `Content-Type: application/json`，例如 `src/app/project/[id]/video/page.tsx:280-304`。
2. 文件上传用 `FormData`，例如 `src/app/start/page.tsx:147-153`。
3. 长任务先 POST 得到任务 ID，再 GET 轮询，例如 `src/app/project/[id]/video/page.tsx:309-334`。

## 常见前端故障定位

| 现象 | 看哪里 | 多半原因 |
|---|---|---|
| “脚本生成失败，请检查 LLM 配置” | `src/app/project/[id]/script/page.tsx:158-169`, `/api/llm/script` 返回 | LLM baseUrl/model/key 不匹配，尤其 Ark 要填推理接入点 ID。 |
| 素材页提示未配置模型 | `src/app/project/[id]/assets/page.tsx:175-245` | 默认生图/生视频模型没有解析到已启用 Provider。 |
| 合成页一直等 | `src/app/project/[id]/video/page.tsx:309-334` | 后端 FFmpeg 异步任务未完成或失败，查 `/api/project/:id/compose`。 |
| 切语言后文案缺失 | `src/lib/i18n/messages/*.ts` | 新增页面文案没补中英文 key。 |
| 上传后刷新图片丢 | `src/app/products/page.tsx:182-202`, `/api/products/upload` | 不能只用 `blob:`，要先上传换成 `/api/files/...`。 |

## 前端二次开发步骤：新增一个页面

以新增 `campaigns` 页面为例：

1. 新建 `src/app/campaigns/page.tsx`，如果有交互，文件顶部加 `"use client"`。
2. 从 `src/components/ui/*` 复用按钮、输入框、卡片，不要另造一套 UI。
3. 用 `useT("campaigns")` 接入 i18n，并在 `src/lib/i18n/messages/index.ts` 及对应消息文件补词条。
4. 调后端时使用相对路径 `/api/campaigns`。
5. 如果页面需要全局设置，从 `useSettingsStore()` 取，不要自己读写 localStorage。
6. 给错误状态留位置：loading、empty、error、success 至少四种状态。
7. 跑 `pnpm lint`、`pnpm test`；涉及页面样式再手动打开浏览器检查。

## 易冲突前端文件

| 文件 | 冲突原因 | 建议 |
|---|---|---|
| `src/app/settings/page.tsx` | 设置页集中度高，平台/TTS/默认模型都在这里。 | 拆小组件后并行改，PR 小步走。 |
| `src/lib/stores/settings-store.ts` | 全局设置字段集中。 | 新字段写默认值，改名要考虑旧 localStorage。 |
| `src/lib/i18n/messages/*.ts` | 文案 key 多人同时加。 | key 带模块前缀，中文英文同 PR 补齐。 |
| `src/app/project/[id]/assets/page.tsx` | 素材、模型、视频生成逻辑都在同页。 | 新能力优先抽工具函数或小组件。 |
| `src/app/project/[id]/video/page.tsx` | 合成参数和轮询集中。 | 改合成 API 时同步更新这里和导出页 A/B 变体。 |
