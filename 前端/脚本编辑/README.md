# 脚本编辑

**路由**: `/project/[id]/script`
**文件**: `src/app/project/[id]/script/page.tsx` → `前端/脚本编辑/page.tsx`

## 功能
- 查看/选择 AI 生成的脚本方案
- 分镜展示（钩子/痛点/产品/演示/背书/转化）
- 合规检查
- 保存为模板
- 重新生成脚本

## 修改入口
- 脚本加载：`loadScripts` 函数
- 重新生成：`handleGenerate` 函数
- 步骤进度：`StepProgressIndicator` 组件

## 添加新功能
- 新脚本操作：在操作按钮区添加
- 新分镜类型：在 `SHOT_TYPE_INFO`（`后端/shared/shot-constants.ts`）中添加
