# 复刻项目

**路由**: `/project/clone`  
**文件**: `src/app/project/clone/page.tsx` → `前端/复刻项目/page.tsx`

## 功能
- 粘贴爆款视频链接 → AI 分析结构
- 上传商品图 + AI 复刻分镜脚本
- 保留原视频的节奏和转化结构

## 修改入口
- 视频分析：`handleAnalyze` 函数
- 复刻生成：`handleGenerate` 函数（与创作工作台共用 API 流程）

## 添加新功能
- 新分析维度：在 `mockShots` / `analyze` 逻辑中添加

