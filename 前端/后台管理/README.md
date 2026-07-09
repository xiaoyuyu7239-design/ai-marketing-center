# 后台管理

**路由**: `/admin/*`  
**文件**: `src/app/admin/` + `前端/后台管理/`

## 功能
- Agent 策略管理（模型选择/参数配置）
- Prompt 版本管理
- 模型评估（成功率/耗时/成本）
- 运行记录查看

## 子页面
- `/admin` — 总览仪表盘
- `/admin/agents` — Agent 管理
- `/admin/prompts` — Prompt 管理
- `/admin/model-evals` — 模型评估
- `/admin/runs` — 运行记录

## 修改入口
- Agent 配置：`服务器/admin/agents/service.ts`
- Prompt 管理：`服务器/admin/prompts/index.ts`
- UI 组件：`前端/components/admin/admin-workspace.tsx`

## 添加新功能
- 新管理页面：在 `src/app/admin/` 创建新路由 + 在 `admin-workspace.tsx` 添加管理逻辑

