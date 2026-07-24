# 创作工作台

**路由**: `/project/agent`
**文件**: `src/app/project/agent/page.tsx` → `前端/创作工作台/page.tsx`
**行数**: 934 行（项目最大页面）

## 功能
- AI 一键生成短视频：上传商品图 → 生成脚本 → 素材 → 视频
- 登录弹窗
- 待发布列表侧边栏
- 画面设置（质量/比例/时长）
- 案例展示轮播

## 修改入口
- 生成流程：`page.tsx` 中的 `handleSubmit`
- 设置面板：`page.tsx` 中的 `settingsOpen` 相关代码
- 案例数据：`showcaseItems` 数组 + `public/case-videos/`

## 添加新功能
- 新设置选项：在 `qualityOptions` / `aspectRatioOptions` / `targetDurationOptions` 中添加
- 新输入方式：在 `textarea` 区域添加
