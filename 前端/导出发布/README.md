# 导出发布

**路由**: `/project/[id]/export`
**文件**: `src/app/project/[id]/export/page.tsx` → `前端/导出发布/page.tsx`

## 功能
- 多平台导出（抖音/快手/小红书/TikTok）
- A/B 版本对比
- 发布文案生成
- 效果数据反馈

## 修改入口
- 平台配置：`platformConfigs` 数组
- 发布文案：`handlePublish` 函数
- 数据反馈：`PerformanceFeedback` 组件

## 添加新功能
- 新平台：在 `platformConfigs` 中添加
- 新导出格式：扩展合成 API 参数
