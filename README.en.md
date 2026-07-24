# AI Marketing Center

AI Marketing Center is the in-progress transformation of [ClipForge](https://github.com/xixihhhh/clipforge) (formerly "带货剪手" / daihuo-jianshou, an open-source short-video creation engine) into a **web-based, subscription SaaS for small and medium merchants**: organizing products, selling points, scripts, assets, video, copy, and publish reminders into one content-production workflow a shop owner can keep up with.

Target mindset (the goal — see "Current Implementation Status" below for what's actually built): the owner shouldn't need to learn short-video operations. They upload a product, make a few choices, and confirm publishing; AI handles analysis, generation, reminders, and publish assistance.

> This README only describes capabilities that actually exist and are reproducible in this repository, plus goals explicitly marked "planned." Anything not listed under "implemented" isn't in the code yet.

## Positioning

For small merchants doing short-video marketing, the hard part usually isn't editing itself — it's that every part of the operating motion is heavy: not knowing what to post, no time to shoot/edit, weak copywriting and "internet sense," and an inability to keep up a consistent posting cadence at the right time.

AI Marketing Center isn't meant to be a standalone video generator. It breaks short-video marketing into a low-friction, repeatable, manageable workflow:

```text
Merchant profile → Upload product → AI extracts selling points → AI recommends content directions → Owner picks
→ AI batch-generates a video package → Saved to a publish queue → Publish reminder → Owner selects → Manual publish
```

## Target Users

Phase one targets small merchants who have products and some assets, want to keep posting short videos, but lack dedicated marketing operations capability.

Initial focus is 5 categories with clear template coverage and strong short-video marketing demand:

| Category | Typical content angles |
| --- | --- |
| Beauty & skincare | Pain-point, ingredient highlights, before/after, scenario-based |
| Food & snacks | Taste demo, stock-up recommendation, scenario sharing, comparison review |
| Home goods | Use-case scenarios, pain-point solving, feature demo, storage/cleaning |
| Apparel & bags | Try-on effect, outfit combos, style recommendation, detail/texture |
| Digital / 3C | Feature selling points, spec explanation, scenario demo, comparison review |

Product surface is **web only, plus an internal ops backend** — no merchant mini-program (evaluated the extra tech stack and WeChat review overhead, and decided against it).

## Current Implementation Status

This is the most important table in this transformation: it maps every step of the original product proposal's closed loop to what's actually true today, and will be updated as each phase ships.

| Step | Status | Notes |
| --- | --- | --- |
| Product image / product-link import | ✅ Implemented | Upload images, or paste a product URL for auto-extraction of title/price/images (`后端/core/stock/product-ingest.ts`) |
| AI selling-point analysis | ✅ Implemented | Analyzes product images for selling points/audience/pain points, written to `productAnalysis` (`后端/script-engine/generator.ts`) |
| Content-direction "pick one" | ❌ Not implemented | 5 script styles exist, but the system currently auto-selects by historical performance data — the owner can't yet actually choose a direction |
| Video generation (script/assets/composition/subtitles/BGM/title/copy/cover/hashtags) | ✅ Implemented | The core generation pipeline is solid and is the base layer the new SaaS reuses |
| Publish queue | 🚧 Partial | Real ranking/recommendation logic exists (`前端/生成库存/`), but approval/published state currently lives only in browser local storage — no DB persistence, lost on a new device |
| Publish reminder | 🚧 Prototype | Currently an in-page timer toast on the creation workbench, not a WeChat notification or system alarm |
| Jump-to-platform publish | ❌ Intentionally not pursued | Deep-link/auto-prefill into Douyin/Xiaohongshu etc. is typically only open to certified/official partners, not ordinary third-party apps. Current reality: generate copy + download the video, merchant manually opens the app to publish — future investment goes into polishing this manual flow |
| Merchant accounts / multi-tenancy | ❌ Not implemented | No login system yet; the database has no merchant entity; single-tenant |
| Plans / subscription billing | ❌ Not implemented | No plan/subscription tables, no payment integration |
| Platform-hosted AI models (no merchant-supplied keys) | ❌ Not implemented | Model keys are currently configured by the user in Settings (BYOK); not yet converted to platform-hosted + subscription-metered |
| Merchant mini-program | ❌ Out of scope (product decision) | Web only |
| Internal ops backend | 🚧 Partially overlapping | `/admin` exists today, but currently serves internal developers debugging the AI system (prompts, model evals) — not yet a merchant/subscription/review management backend |

## Video Generation Pipeline (Implemented)

Video generation is a standard content-production pipeline, not an isolated one-click feature:

```text
Product image → Selling-point analysis → Storyboard → Asset fill → Composition → Copy & cover → Into the publish queue
```

Two video modes are the current focus:

| Mode | Best for | Generation strategy |
| --- | --- | --- |
| Graphic montage | Fast-moving goods, food/snacks, home goods — low-friction, fast turnaround | Product image + selling-point captions + text cards + transitions + BGM + generic scene footage |
| Product close-up | Premium or higher-priced goods needing appearance/detail emphasis | Push-in, pan, lighting and selling-point stickers on the product image, keeping the product itself stable |

Two capabilities the original proposal never anticipated, but which already shipped: a pre-publish self-check (ad-law risk terms, hook strength, duration, captions, CTA, AIGC labeling) and a performance-feedback loop (aggregating conversion data by script style).

## Target Architecture (Planned, Not Yet Built)

| Layer | Composition |
| --- | --- |
| User layer | Merchant web app, internal ops backend (no mini-program) |
| Application layer | Content-production workflow, Agent role division, shared tooling |
| Model layer | Platform-hosted LLM, image-editing, image-to-video, and TTS models, metered per subscription |
| Foundation layer | Category template library, hook library, SEO strategy, compliance wordlists, merchant/plan data |

The transformation is staged: Phase 0 (this pass — documentation honesty + fixing AI analysis being skipped by default) → Phase 1 (merchant accounts + hosted-model metering + subscription billing) → Phase 2 (merchant onboarding, real content-direction selection, server-persisted publish queue, reminder-channel selection, manual-publish polish) → Phase 3 (merchant/subscription/review ops backend).

## Models & Tooling

| Type | Purpose | Current key source |
| --- | --- | --- |
| Text model | Script, selling points, titles, publish copy, SEO, prompts | User-configured in Settings (BYOK); planned to move to platform-hosted |
| Image model | Product-image processing, background generation, product-faithful edits | Same as above |
| Video model | Image-to-video, product motion shots | Same as above |
| Audio model | AI voiceover, caption timing, BGM pairing | Same as above; free Edge TTS is also supported with no key required |
| FFmpeg | Local composition, transcoding, subtitle burn-in, AV processing | Local binary, no key needed |
| Compliance tools | Risk-term checks, platform fit, AIGC labeling, pre-publish self-check | Pure local rules, no key needed |

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
- Vitest

## Local Development

Requirements:

- Node.js >= 20
- pnpm >= 10

```bash
pnpm install
pnpm dev
```

Default development URL:

```text
http://localhost:3000
```

The homepage redirects to `/start`; the main creation workbench is at `/project/agent`.

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

Business code actually lives in three Chinese-named directories (see the `@frontend`/`@backend`/`@server` path aliases in `tsconfig.json`); most page files under `src/app` are thin forwarding shells (e.g. `export { default } from "@frontend/创作工作台/page"`):

```text
前端/ (@frontend)     Pages and frontend logic, organized by feature module (e.g. 创作工作台/, 导出发布/, 后台管理/)
后端/ (@backend)      Business engine: script-engine (script generation), video-composer, providers (model adapters), core/publish (publish copy), db (schema)
服务器/ (@server)     Server-side capabilities — currently mainly internal admin (agents/prompts/model evals)
src/app/              Next.js route entries, mostly forwarding to their 前端/ module
src/app/api/          Server API routes
src/lib/__tests__/    Test code
public/               Static assets and showcase media
drizzle/              Database migrations
electron/             Desktop app entry and packaging config
mcp/                  Agent / MCP integration (carried over from the ClipForge phase, for AI agent/CLI use)
```

## What's Next

- Merchant accounts, hosted-model metering, subscription billing (Phase 1)
- Merchant onboarding, real content-direction selection, server-persisted publish queue, reminder-channel selection, manual-publish polish (Phase 2)
- Merchant-facing ops backend: merchant list, plan/quota adjustment, review queue (Phase 3)
- Payment rail (WeChat Pay / Alipay), reminder channel, and plan pricing are all still undecided and will be settled as each phase comes up

The long-term goal of AI Marketing Center is to turn small-merchant short-video marketing into a low-friction workflow an owner can actually keep up with; the generation engine and open-source foundation built during the ClipForge phase carry forward as its base layer.
