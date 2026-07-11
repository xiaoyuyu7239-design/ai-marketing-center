# Phase 1B PostgreSQL 项目第一切片设计

日期：2026-07-11  
状态：设计稿，等待书面复核；未授权实现  
前置证据：Phase 1A 本机 PostgreSQL 迁移已应用并核验，认证/工作区数据库集成测试 6/6 通过

## 1. 目标与边界

第一切片只建立可验证的租户项目入口：PostgreSQL `projects` schema、强制 `workspaceId` 的 repository、项目列表和项目创建 API。它不迁移脚本、素材、合成、商品、品牌、人物或模板，不改当前前端，不开放生产 gate，也不接入登录供应商。

该切片必须同时具备应用层过滤和 PostgreSQL RLS。只有 `workspace_id` 列但没有事务级租户上下文，不足以宣称租户安全。

## 2. 方案比较与选择

### 方案 A：立即替换 `/api/project`

优点是 URL 不变。缺点是当前没有公开登录供应商，现有开发工作台不会发送真实 session 和 workspace header，替换后会立即失效；为了维持旧行为又会诱发 SQLite/PostgreSQL 条件回退。此方案不采用。

### 方案 B：新增 `/api/saas/projects`，推荐

新路径只访问 PostgreSQL，要求真实服务端会话与工作区；旧 `/api/project` 暂时保持现状，只服务冻结的本地/SQLite 路径。两者不双写，也不根据环境在同一个 repository 中切换数据库。当前前端不自动调用新路径；等真实登录和前端工作区选择完成后，再切换调用方并移除旧 Web 路径。

生产环境中 `/api/saas/projects` 仍被现有 Phase 0 gate 拦截。本切片只让 handler、repository 和数据库契约可测试，不宣称公开可用。

### 方案 C：只实现 schema 和 repository

风险最低，但不能稳定列表/创建的 HTTP 契约，也无法验证 request → auth → workspace → RLS → repository 的完整数据流，不满足本切片目标。此方案不采用。

## 3. 文件与组件边界

- `后端/saas/db/project-schema.ts`：PostgreSQL 项目表、枚举、约束和索引；不导入 SQLite schema。
- `后端/saas/db/workspace-transaction.ts`：开启事务并用 `set_config('app.workspace_id', workspaceId, true)` 设置 transaction-local 租户上下文。
- `服务器/projects/model.ts`：项目状态、内容类型和公开数据类型。
- `服务器/projects/repository.ts`：要求 `workspaceId` 的项目 repository port。
- `后端/saas/db/postgres-project-repository.ts`：参数化 SQL，显式 `workspace_id` 过滤；只在已设置 RLS 上下文的事务中运行。
- `服务器/projects/api-contracts.ts`：列表、创建、分页和错误响应类型。
- `服务器/projects/api-handlers.ts`：鉴权、输入验证、事务/RLS 调用和安全错误映射。
- `src/app/api/saas/projects/route.ts`：GET/POST 薄路由；不包含业务 SQL。
- `drizzle.saas.config.ts`：schema 输入增加 `project-schema.ts`；保持独立于 `drizzle.config.ts`。
- `后端/saas/db/migrations/0001_*.sql`：只新增项目对象和 RLS，不改写 `0000_phase_1a_auth_core.sql`。

## 4. PostgreSQL schema

`projects` 第一切片包含：

| 列 | 规则 |
|---|---|
| `id` | UUID 主键，服务端生成 |
| `workspace_id` | UUID 非空，外键到 `workspaces.id`，删除工作区时 `RESTRICT` |
| `name` | 非空，trim 后 1–120 字符 |
| `status` | `draft | scripting | assets | video | composing | done`，创建时固定 `draft` |
| `content_type` | `product | topic`，默认 `product` |
| `topic` | 可空文本 |
| `product_name` | 可空文本 |
| `product_category` | 可空文本 |
| `product_description` | 可空文本 |
| `created_at` | timestamptz，数据库默认当前时间 |
| `updated_at` | timestamptz，数据库默认当前时间，后续更新由 repository 显式维护 |

本切片不保存本机文件路径、商品图片数组、外部素材 URL、价格/分佣、clone 来源，以及尚未迁移的 product/brand/template/character 外键。这些字段若现在照搬，会在对象存储和关联表尚未存在时制造不可验证的半迁移状态。

约束与索引：

- 主键：`projects_pkey(id)`；
- 组合唯一约束：`projects_workspace_id_id_unique(workspace_id, id)`，供未来子表使用同租户组合外键；
- 列表索引：`projects_workspace_created_index(workspace_id, created_at DESC, id DESC)`；
- `workspace_id` 不允许由 API body 提供，只能来自已验证 `AuthContext`。

## 5. RLS 与事务边界

迁移执行：

```sql
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
CREATE POLICY projects_workspace_isolation ON projects
USING (
  workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
)
WITH CHECK (
  workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
);
```

策略使用 `TO PUBLIC` 的默认适用范围，不写死本地角色名。表由迁移角色拥有；应用角色不是 owner，因此受 RLS 约束。没有 transaction-local `app.workspace_id` 时，查询返回零行、写入被拒绝。

每次 repository 操作必须走 `withWorkspaceTransaction(pool, workspaceId, callback)`：

1. 从 pool 取得专用 client；
2. `BEGIN`；
3. 参数化执行 `SELECT set_config('app.workspace_id', $1, true)`；
4. callback 内的 SQL 仍显式带 `workspace_id = $n`；
5. 成功 `COMMIT`，失败 `ROLLBACK`，最后 release。

RLS 是第二层防护，不替代 repository 的 workspace 参数和 SQL 过滤。

## 6. Repository 契约

```ts
type CreateProjectInput = {
  name?: string;
  contentType?: "product" | "topic";
  topic?: string;
  productName?: string;
  productCategory?: string;
  productDescription?: string;
};

interface ProjectRepository {
  listProjects(
    workspaceId: string,
    options: { limit: number; cursor: ProjectCursor | null },
  ): Promise<{ projects: ProjectSummary[]; nextCursor: string | null }>;
  createProject(
    workspaceId: string,
    input: CreateProjectInput,
  ): Promise<ProjectSummary>;
}
```

任何未来单项目方法都必须使用 `(workspaceId, projectId)`，不存在裸 `projectId` 查询。属于其他 workspace 的 ID 与不存在的 ID 统一返回 `null`，API 统一映射为 404；第一切片暂不提供单项目读取路由。

列表使用 `(created_at DESC, id DESC)` keyset cursor，默认 50 条、最大 100 条。cursor 解码失败返回 400，不回退为第一页。创建时服务器决定 `workspaceId`、`id`、`status` 和时间戳。

## 7. HTTP 契约

### `GET /api/saas/projects`

- 要求有效 session 和 `x-clipforge-workspace-id`；
- query：`limit` 可选，1–100；`cursor` 可选；
- 200：`{ data: { projects, nextCursor }, requestId }`；
- 401：无有效 session；403：无该 workspace 的有效成员关系；503：PostgreSQL runtime 未配置。

### `POST /api/saas/projects`

- 与 GET 使用相同鉴权；
- body 只允许 `CreateProjectInput` 字段，出现 `workspaceId`、`id`、`status`、时间戳或未知字段返回 400；
- `name` 缺省时使用 `未命名项目`，非空时 trim 并限制 120 字符；
- `contentType=topic` 时可带 `topic`，但允许先建草稿后补内容；
- 201：`{ data: { project }, requestId }`。

所有响应 `Cache-Control: no-store`。数据库异常只返回稳定的 `PROJECT_INTERNAL_ERROR`，不得返回 SQL、连接串、token、stack 或原始驱动消息。

## 8. 数据流

```text
Request
  -> requireWorkspace(session cookie + workspace header)
  -> verified AuthContext.workspace.id
  -> withWorkspaceTransaction(SET LOCAL app.workspace_id)
  -> ProjectRepository(workspaceId + parameterized SQL)
  -> PostgreSQL RLS
  -> stable API envelope
```

API body 中即使出现伪造 workspace 字段也不会进入数据层。平台管理员身份也不自动跨 workspace；没有成员关系时仍为 403。

## 9. 测试与验收

1. 离线 schema 测试：字段、枚举、组合唯一约束、列表索引、RLS SQL 都存在。
2. 迁移测试：在本机专用 PostgreSQL 应用 `0001`，命令退出 0 后核表、约束、索引、owner 和 policy。
3. repository 集成测试：A/B 各创建项目；A 列表只返回 A；B 列表只返回 B；分页顺序稳定。
4. RLS 直测：A 事务中故意执行没有 workspace WHERE 的查询也看不到 B；未设置 workspace 时为零行；A 上下文插入 B 的 `workspace_id` 被拒绝。
5. API 测试：无 session 401、无成员 403、未知字段 400、成功创建 201、成功列表 200、runtime 未配置 503。
6. 生产 gate 回归：`/api/saas/projects` 和旧 `/api/project` 在生产环境仍返回现有 503 门禁；不添加任何例外。
7. 全量回归：真实 PostgreSQL integration、unit、typecheck、lint、build 全部通过后才可进入前端调用切换。

## 10. 明确不做

- 不修改 SQLite schema、SQLite migration、`drizzle.config.ts` 或旧 SQLite repository；
- 不让同一个请求同时写 SQLite 和 PostgreSQL；
- 不在 runtime 未配置时回退到内存或 SQLite；
- 不实现项目详情、更新、删除、脚本、素材、合成、对象存储或旧数据导入；
- 不接入伪登录、公开登录供应商或生产开发身份；
- 不放开任何生产 API gate。

## 11. 进入实现前的复核点

本设计选择“临时独立 SaaS 路径 + 首切片即启用 RLS”。实现前需要书面确认两点：

1. 接受第一切片只迁移项目核心元数据，不复制图片、价格、分佣和未落地关联表字段；
2. 接受 `/api/saas/projects` 作为过渡契约，前端切换后再移除旧 Web `/api/project`，期间绝不双写。
