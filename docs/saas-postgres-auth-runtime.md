# SaaS PostgreSQL 认证运行时

## 环境变量

- `DATABASE_URL`：Web 应用受限角色，只用于运行时查询。
- `DATABASE_MIGRATION_URL`：迁移专用高权限角色，只用于显式迁移命令。

两者都必须是标准 `postgres://` 或 `postgresql://` 连接串。代码不绑定托管商，也不会用 `DATABASE_URL` 代替迁移连接串。

本机真实数据库测试使用项目根目录的 `.env.saas.local`。该文件已被 `.gitignore` 的 `.env*` 规则覆盖，不得提交、复制到文档或打印完整连接串。本地角色职责固定为：

- `clipforge_saas_migrator`：拥有项目测试数据库和迁移对象，只用于显式迁移；
- `clipforge_saas_app`：只具备数据库连接、schema 使用和认证表 DML 权限，不具备建库、建表、改表或对象所有权；
- `clipforge_saas_test`：仅供本项目使用的本地测试数据库。

## 生成迁移

```bash
npm run db:saas:generate
```

生成只读取 `后端/saas/db/auth-schema.ts` 与 `后端/saas/db/project-schema.ts`，不连接数据库。生成成功只能说明迁移文件与 schema 同步，不能说明数据库里已经存在这些表。

## 应用迁移

```bash
node --env-file=.env.saas.local scripts/migrate-saas.mjs
```

迁移脚本只读取 `DATABASE_MIGRATION_URL`，不会回退到应用的 `DATABASE_URL`。只有命令退出 0 并核对目标数据库后，才能说迁移已应用。

## 本地数据库集成测试

```bash
npm run test:saas:integration
```

该命令只运行 `*.integration.test.ts`，使用 Node 环境和单 worker，并只读取受限角色的 `DATABASE_URL`。普通 `npm test` 明确排除真实数据库测试，避免在未配置环境或 CI 中误连数据库。每个数据库行为用例都在事务内执行并回滚。

截至 2026-07-11，本机专用测试库已实际完成 Phase 1A 与 Phase 1B 第一切片迁移：迁移命令退出 0；6 张认证表及其约束/索引已核验；`projects` 表由迁移角色拥有并启用 `projects_workspace_isolation` RLS policy；受限应用角色具备项目表 DML 但不具备 TRUNCATE、DDL 或对象所有权；数据库集成测试为 2/2 文件、10/10 用例通过。该结论只适用于本机测试目标，不代表生产数据库已配置。

## 认证 API

- `GET /api/auth/session`：读取当前服务端会话和可选工作区上下文。
- `DELETE /api/auth/session`：按 token 摘要撤销会话并清 Cookie。
- `GET /api/auth/workspaces`：只按已认证用户 ID 返回其有效工作区成员关系。

当前没有登录、注册、手机号验证码、邮箱魔法链接或 OAuth 回调接口。Phase 0 生产 API 门禁仍未给这些新路由放行，因此它们不能被描述为已公开上线。

## 项目第一切片 API

- `GET /api/saas/projects`：要求有效 session 和有效 workspace 成员关系，返回 workspace 内项目的 keyset 分页列表；
- `POST /api/saas/projects`：只接受项目核心元数据，workspace、ID、状态和时间戳全部由服务端决定；
- repository SQL 显式过滤 `workspace_id`，同时在事务内通过 `set_config('app.workspace_id', ..., true)` 启用 RLS 第二层隔离；
- 缺少 workspace 设置时应用角色看不到任何项目，workspace A 上下文不能读取或写入 workspace B 项目。

旧 `/api/project` 与 SQLite runtime 未被修改，也不存在单次请求双写。新路径仍被生产 gate 拦截，当前前端尚未切换到该 API。

## 仍不可宣称

- 未选择并接入真实登录供应商：不能说用户可以登录。
- Phase 0 生产业务 API 门禁仍在：不能说项目、文件或 AI API 已开放。
- 项目详情、更新、删除、脚本、素材、合成、旧数据导入和前端切换尚未完成。
- 本机测试通过不等于托管 PostgreSQL、生产备份恢复或跨实例运行已经验证。
