# 批量创作

**路由**: `/batch`
**文件**: `src/app/batch/page.tsx` → `前端/批量创作/page.tsx`

## 功能
- 批量上传多个商品 → 并发生成脚本
- 进度追踪（每个商品独立状态）
- 批量合成 + 导出

## 修改入口
- 并发控制：`CONCURRENCY` 常量
- 任务状态：`batchTasks` state

## 添加新功能
- 新任务类型：扩展 task schema
- 批量导出：在工具栏添加
