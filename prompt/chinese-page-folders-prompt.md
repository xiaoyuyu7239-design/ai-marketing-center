# 前端页面中文命名目录化 — 专业 Prompt

## 目标
将 `前端/` 目录按页面拆分为中文命名文件夹，每个文件夹对应一个网页，便于查找、修改、优化和新增页面。

## 当前状态
- 19 个页面文件在 `src/app/` 下（Next.js 路由层）
- 7 个大型页面（>500行）：agent(934)、video(831)、products(657)、script(654)、batch(626)、assets(621)、clone(579)
- 组件/stores/i18n 已在 `前端/components/` `前端/stores/` `前端/i18n/` 下

## 中文页面文件夹映射

| 路由 | 中文名 | 用途 |
|------|--------|------|
| `/start` | 创作者首页 | 落地页，背景视频+CTA |
| `/project/agent` | 创作工作台 | 一键生成入口 |
| `/project/[id]/script` | 脚本编辑 | 脚本方案选择与编辑 |
| `/project/[id]/assets` | 素材管理 | AI生图/配画面 |
| `/project/[id]/video` | 视频预览 | 合成预览+配置 |
| `/project/[id]/export` | 导出发布 | 发布+数据反馈 |
| `/project/clone` | 复刻项目 | 克隆爆款视频 |
| `/project/topic` | 主题创作 | 一句话成片 |
| `/products` | 生成库存 | 商品库管理 |
| `/batch` | 批量创作 | 批量生成 |
| `/settings` | 设置中心 | 人物+品牌设置 |
| `/examples/showcase` | 案例展示 | 案例模板浏览 |
| `/admin` | 后台管理 | Agent/Prompt/评估管理 |
| `/` | 首页 | 重定向到/start |

## 执行方案

### 每个页面文件夹包含：
1. **`page.tsx`** — 从 `src/app/.../page.tsx` 提取的主组件
2. **`README.md`** — 中文说明：功能、涉及组件、修改入口、添加指引

### src/app/ page.tsx 改为薄层重导出：
```tsx
export { default } from "@frontend/pages/创作者首页/page"
```

### 目录结构：
```
前端/
├── components/          # 跨页面共享组件
├── stores/              # 全局状态
├── i18n/                # 国际化
├── 创作者首页/           # /start
├── 创作工作台/           # /project/agent
├── 脚本编辑/             # /project/[id]/script
├── 素材管理/             # /project/[id]/assets
├── 视频预览/             # /project/[id]/video
├── 导出发布/             # /project/[id]/export
├── 复刻项目/             # /project/clone
├── 主题创作/             # /project/topic
├── 生成库存/             # /products
├── 批量创作/             # /batch
├── 设置中心/             # /settings
├── 案例展示/             # /examples/showcase
└── 后台管理/             # /admin
```

## 约束
1. `src/app/` 内的 `page.tsx` 不可删除（Next.js 路由依赖），改为重导出
2. `"use client"` 指令随组件移到新位置
3. import 路径从 `@/` 更新为 `@frontend/`、`@backend/`、`@server/`
4. 每步验证页面 200

## 执行循环
1. 创建所有中文文件夹 + README
2. 逐页面提取组件到新位置
3. 更新 src/app/ page.tsx 为重导出
4. 全量验证
