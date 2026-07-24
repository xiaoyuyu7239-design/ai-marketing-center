# 素材管理

**路由**: `/project/[id]/assets`
**文件**: `src/app/project/[id]/assets/page.tsx` → `前端/素材管理/page.tsx`

## 功能
- AI 生成分镜画面（图/视频）
- 商品保真模式（锁定商品主体）
- 自动配画面（免费素材库）
- 图生视频（静态图转动态镜头）
- 批量生成

## 修改入口
- AI 生成：`generateImage` / `generateVideo` / `generateMotion`
- 素材行渲染：`buildAssetRows`（`后端/core/stock/assets-view.ts`）

## 添加新功能
- 新素材类型：扩展 `AssetItem` 类型
- 新 AI 模型：在设置中心 → Agent 策略中配置
