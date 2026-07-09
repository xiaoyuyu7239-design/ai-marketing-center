# AI Marketing Center

AI Marketing Center is a local workspace for short-form marketing video production. It helps organize products, topics, scripts, assets, generation records, previews, and export workflows in one project.

Current focus areas:

- Product-driven and topic-driven short-video creation
- Script generation, storyboard management, asset management, and video composition
- Admin pages for prompts, model evaluations, and generation runs
- Local data storage, media archiving, and export workflows
- Web workspace plus desktop-app packaging

## Tech Stack

- Next.js 16
- React 19
- TypeScript
- Tailwind CSS
- Drizzle ORM
- SQLite / better-sqlite3
- FFmpeg
- Electron
- pnpm

## Local Development

```bash
pnpm install
pnpm dev
```

Default development URL:

```text
http://localhost:3000
```

## Common Commands

```bash
pnpm dev
pnpm build
pnpm start
pnpm test
pnpm lint
pnpm dist
```

## Main Folders

```text
src/                 app pages, API routes, and business logic
public/              static assets
drizzle/             database migrations
electron/            desktop app entry and packaging config
mcp/                 Agent / MCP integration
agent/               Agent workflow notes
prompt/              prompt materials
前端/ 后端/ 服务器/   project split notes and implementation records
视频背景/             local showcase media
```

## Notes

This repository stores the current customized AI Marketing Center workspace. Local archives, dependency folders, build caches, and runtime data such as `版本存档/`, `node_modules/`, `.next/`, `.pnpm-store/`, and `data/` are not uploaded to GitHub.
