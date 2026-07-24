# 案例展示

**路由**: `/examples/showcase`
**文件**: `src/app/examples/showcase/page.tsx` → `前端/案例展示/page.tsx`

## 功能
- 展示预置案例模板（分镜结构 + 产品图）
- 一键使用模板创建项目

## 修改入口
- 案例数据：`getExampleShowcase` / `getExampleTemplates`（`后端/shared/examples.ts`）
- 分镜渲染：页面 JSX

## 添加新功能
- 新案例：在 `后端/shared/examples.ts` 中添加
- 新模板格式：扩展 template 类型
