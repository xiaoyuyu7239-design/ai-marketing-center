# 创作者首页

**路由**: `/start`  
**文件**: `src/app/start/page.tsx` → `前端/创作者首页/page.tsx`

## 功能
- 品牌落地页，全屏背景视频 + CTA 按钮
- 语言切换（中文/English）
- 导航：生成库存、批量创作、设置

## 修改入口
- 背景视频：`public/showcase-bg.mp4`
- CTA 文字：`前端/i18n/messages/start.ts` → `ctaStart`
- 整体样式：`page.tsx` 内 `<style>` 块（cf- 系列 CSS 类）

## 添加新功能
在 `page.tsx` 中的 `cf-wrap` 内添加新的 section

