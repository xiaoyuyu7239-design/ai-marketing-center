# 设置中心

**路由**: `/settings`  
**文件**: `src/app/settings/page.tsx` → `前端/设置中心/page.tsx`

## 功能
- 数字人形象管理（增删改查）
- 品牌店铺设置（Logo/颜色/水印/片尾）

## 修改入口
- 形象 CRUD：`useCharacterStore`
- 品牌配置：`useBrandStore`
- 水印设置：`watermark` state

## 添加新功能
- 新设置 Tab：在 `tabs` 切换区添加
- 新品牌配置项：扩展 `brandStore`

