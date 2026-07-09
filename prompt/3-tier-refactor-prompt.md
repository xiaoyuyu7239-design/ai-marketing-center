# ClipForge 三层架构重构 — 专业 Prompt

## 项目背景
Next.js 16 App Router 全栈应用，共 ~190 源文件。当前所有代码集中在 `src/` 目录下，需按三层架构拆分为独立顶层目录。

## 关键约束（不可违反）
1. **Next.js App Router 的 `page.tsx` / `layout.tsx` / `route.ts` 必须留在 `src/app/` 内**，文件系统路由依赖这些文件的物理路径
2. `@/*` 别名映射到 `src/*`，新增别名 `@frontend/*` `@backend/*` `@server/*`
3. 搬迁后所有 import 路径需同步更新，不可有断裂引用
4. 每步搬迁后验证 `curl` 关键页面 200

## 三层定义

### 前端 `/Users/xiaoyu/Desktop/ai营销中台/前端/`
- UI 组件、页面样式、交互状态管理、国际化、静态资源
- 来源：`src/components/` `src/lib/stores/` `src/lib/i18n/`
- 目标结构：
```
前端/
├── components/
│   ├── ui/          # shadcn 基础组件 (badge/button/card/...)
│   ├── admin/       # 后台专用组件
│   ├── brand-wheat-logo.tsx
│   ├── generation-settings.tsx
│   ├── language-toggle.tsx
│   ├── locale-initializer.tsx
│   ├── performance-feedback.tsx
│   └── step-progress.tsx
├── stores/          # Zustand 状态管理
│   ├── agent-draft-store.ts
│   ├── brand-store.ts
│   ├── product-library-store.ts
│   ├── project-store.ts
│   ├── settings-store.ts
│   └── template-store.ts
├── i18n/            # 国际化
│   ├── config.ts
│   ├── index.ts
│   └── messages/
└── README.md
```

### 后端 `/Users/xiaoyu/Desktop/ai营销中台/后端/`
- AI/素材 Provider、脚本引擎、视频合成器、业务核心逻辑、共享工具
- 来源：`src/lib/providers/` `src/lib/script-engine/` `src/lib/video-composer/` `src/lib/core/` `src/lib/shared/`
- 目标结构：
```
后端/
├── providers/       # AI + 素材 Provider (18 files, 已有 BaseProvider OOP)
├── script-engine/   # 脚本生成引擎 (11 files, 已有策略模式)
│   └── templates/
├── video-composer/  # 视频合成器 (7 files)
├── core/
│   ├── publish/     # 合规检查 + 发布打包
│   ├── stock/       # 素材匹配 + 自动配画面
│   ├── media/       # TTS + 音频 + 合成预设
│   ├── agent/       # Agent 策略配置
│   └── script/      # 脚本导入
├── shared/          # 跨层共享工具 (utils, paths, errors, cache...)
│   ├── utils.ts
│   ├── constants.ts
│   ├── friendly-error.ts
│   ├── paths.ts
│   ├── poll-composition.ts
│   ├── use-drag-upload.ts
│   └── ...
├── db/              # 数据库 schema
│   ├── index.ts
│   └── schema.ts
└── README.md
```

### 服务器 `/Users/xiaoyu/Desktop/ai营销中台/服务器/`
- 服务端专用逻辑、管理员系统、基础设施
- 来源：`src/lib/server/` `electron/` `mcp/` `bin/` `scripts/`
- 目标结构：
```
服务器/
├── admin/           # 后台服务层 (agents/evals/prompts/runs)
│   ├── agents/      # Agent CRUD + 策略
│   ├── evals/
│   ├── prompts/
│   └── runs/
├── electron/        # Electron 桌面端
├── mcp/             # MCP 服务
├── cli/             # CLI 工具
├── scripts/         # 构建脚本
└── README.md
```

### 路由层（保留） `src/app/`
```
src/app/             # Next.js 路由层（薄层，仅 page/layout/route 文件）
├── page.tsx         # 首页（redirect → /start）
├── layout.tsx       # 根布局
├── globals.css      # 全局样式
├── start/           # 落地页
├── project/         # 创作者前台
├── products/        # 生成库存
├── batch/           # 批量创作
├── settings/        # 设置
├── examples/        # 案例展示
├── admin/           # 工作者后台页面
└── api/             # API 路由（薄层，委托给 后端/）
```

## 执行循环（3轮）

### 第1轮：分析 + 映射
- 建立 src→目标 的完整文件映射表
- 检查每个文件的依赖关系
- 计算需要更新的 import 数量
- 输出执行计划

### 第2轮：搬迁 + 更新
- 按"服务器→后端→前端"顺序搬迁（从依赖最少的开始）
- 添加 tsconfig.json 路径别名
- 批量更新所有 import 路径
- 每层搬迁后验证

### 第3轮：验收
- 所有关键页面 curl 200
- 零断裂引用
- 各目录有 README.md
- 打开浏览器视觉验证

## 验收标准
1. `前端/` `后端/` `服务器/` 三目录完整填充，`src/lib/` 仅保留测试和路由层引用
2. 新增 `@frontend/*` `@backend/*` `@server/*` 路径别名可用
3. 7 个关键页面全部返回 200
4. 浏览器预览创作者前台 + 工作者后台正常

## 注意事项
1. Next.js `page.tsx`/`route.ts`/`layout.tsx` 不可移出 `src/app/`
2. 测试文件暂留 `src/lib/__tests__/`，后续单独迁移
3. 先搬迁依赖最少的目录，逐步推进降低风险
4. 每步 `curl` 验证，发现问题立即回滚
5. `@/*` 别名保留作为过渡，新增并行别名
