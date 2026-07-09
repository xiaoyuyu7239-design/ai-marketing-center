# 视频预览

**路由**: `/project/[id]/video`  
**文件**: `src/app/project/[id]/video/page.tsx` → `前端/视频预览/page.tsx`  
**行数**: 831 行

## 功能
- 视频合成预览（BGM/配音/KTV字幕/AI声明/CTA/商品卡）
- 合成配置面板
- 实时进度轮询
- 视频下载

## 修改入口
- 合成配置：`config` state 对象
- 合成提交：`handleCompose` 函数
- BGM 选择：`bgm` state + API

## 添加新功能
- 新配置开关：在 config 对象 + UI toggle 中添加
- 新转场效果：在 `后端/video-composer/transitions.ts` 中添加

