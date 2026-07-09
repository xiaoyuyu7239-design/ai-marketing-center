# AI Marketing Center

AI 营销中台是一个面向短视频营销创作的本地化工作台，用来把商品、主题、脚本和素材组织成可生成、可预览、可导出的营销内容生产流程。

项目当前重点覆盖：

- 商品或主题驱动的短视频创作流程
- 脚本生成、分镜管理、素材管理和视频合成
- 管理后台、模型评测、提示词和生成记录管理
- 本地数据存储、素材归档和导出发布流程
- Web 工作台与桌面应用打包能力

## 技术栈

- Next.js 16
- React 19
- TypeScript
- Tailwind CSS
- Drizzle ORM
- SQLite / better-sqlite3
- FFmpeg
- Electron
- pnpm

## 本地运行

```bash
pnpm install
pnpm dev
```

默认开发地址：

```text
http://localhost:3000
```

## 常用命令

```bash
pnpm dev
pnpm build
pnpm start
pnpm test
pnpm lint
pnpm dist
```

## 主要目录

```text
src/                 应用页面、接口和业务代码
public/              静态资源
drizzle/             数据库迁移
electron/            桌面应用入口和打包配置
mcp/                 Agent / MCP 接入能力
agent/               Agent 工作流资料
prompt/              提示词资料
前端/ 后端/ 服务器/   项目拆分资料和实现记录
视频背景/             本地展示素材
```

## 说明

这个仓库保存的是当前魔改后的 AI 营销中台项目状态。`版本存档/`、`node_modules/`、`.next/`、`.pnpm-store/`、`data/` 等本地依赖、构建缓存和大体积归档不会上传到 GitHub。
