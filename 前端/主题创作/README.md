# 主题创作

**路由**: `/project/topic`
**文件**: `src/app/project/topic/page.tsx` → `前端/主题创作/page.tsx`

## 功能
- 输入主题/话题 → AI 生成科普/纪录类短片
- 一句话成片（无需商品图）
- 免费素材自动配画面

## 修改入口
- 主题脚本生成：`handleGenerate` 函数（调用 `/api/topic/script`）

## 添加新功能
- 新内容类型：扩展 topic 分类
