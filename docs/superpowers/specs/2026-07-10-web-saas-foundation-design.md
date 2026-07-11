# 绘卖 / ClipForge 多商户 Web SaaS 基础设计

日期：2026-07-10  
状态：方向已确认，等待书面设计复核  
依据：`audit/2026-07-10-product-readiness/report.md` 与当前实现

## 1. 目标

把当前 Next.js + SQLite + 本地文件系统的单机/单租户应用，演进为可以公开上线的多商户 Web SaaS。第一轮只建立可信的安全与数据底座，具体包括：

- 恢复可信测试与 CI；
- 后台认证 fail closed；
- 阻止未完成鉴权的业务 API 被误部署到公网；
- 建立用户、身份、会话、工作区、成员和角色模型；
- 建立统一的服务端鉴权与租户上下文；
- 明确 SQLite → PostgreSQL、localStorage → 云端数据、本地文件 → 对象存储、进程内任务 → 持久任务的迁移边界；
- 在账号和项目 API 契约稳定后，进入前端比例、导航和创作流程重构。

本设计不把“能在本机运行”误认为“可以公开上线”。公开上线必须同时满足本文第 13 节的发布门槛。

## 2. 已选择的实施路径

评估过三种顺序：

1. **前端优先**：先重做比例和点击开始后的页面。短期可见，但新页面仍会依赖伪登录、localStorage 和全局项目 API，接入真实账号后需要大面积返工，因此不采用。
2. **全部后端完成后再做前端**：安全性强，但会让界面问题长期得不到验证，也容易做出与实际操作流程脱节的数据模型，因此不采用。
3. **渐进式夹层方案**：先完成 Phase 0 和 Phase 1A 的安全、账号、工作区及 API 契约，再立即启动前端重构；随后继续对象存储、任务和成本系统。该方案已经确认采用。

原则是“先稳定身份和数据归属，再改依赖这些数据的界面”，而不是无限期推迟前端。

## 3. 产品与运行时边界

### 3.1 Web SaaS 主线

Web SaaS 是后续唯一新增功能主线：

- Next.js Web 进程保持无状态，不把 SQLite、上传文件或任务状态留在实例本地；
- PostgreSQL 保存业务数据、账号数据、配额账本和任务元数据；
- 私有对象存储保存上传素材、TTS 中间件和成片；
- 独立 Worker 执行 TTS、素材处理和 FFmpeg，不在 Route Handler 中使用 `void async` 执行后台任务；
- 所有普通用户请求必须具有服务端会话和工作区上下文。

### 3.2 Electron / SQLite 维护线

现有 Electron + SQLite 版本冻结为 0.8 系列维护线：

- 不为新 SaaS 功能维持 SQLite/PostgreSQL 双数据库兼容；
- 不在同一套 Drizzle schema 中通过条件分支支持两种方言；
- 如需修复桌面版严重问题，从冻结基线单独维护；
- SaaS 迁移脚本可以读取旧 SQLite，但 SaaS 运行时不再写 SQLite。

维持双数据库会让每张表、每个查询、每次迁移和每个测试都产生两套路径，并显著扩大租户隔离漏洞面，因此明确排除。

## 4. 阶段与交付边界

### Phase 0：安全止血与可信基线

目标是让当前代码库不再以“测试已坏、后台默认开放、公开 API 无门禁”的状态继续演进。

1. 修复三组已复现的测试失效：
   - `src/lib/__tests__/image-file.test.ts` 改用 `@backend/shared/image-file`；
   - `src/lib/stores/__tests__/stores.test.ts` 改用 `@frontend/stores/*` 与 `@backend/db/schema`；
   - `src/lib/__tests__/agent-generation-routes.test.ts` 把 provider mock 从 `@/lib/providers` 改为实际使用的 `@backend/providers`。
2. 后台 fail closed：
   - 生产环境缺少管理员口令或独立 session secret 时，后台页面和后台 API 返回明确的 503 配置错误；
   - 删除生产环境默认口令回退，不再向页面展示默认口令；
   - 管理员 Cookie 在生产环境强制 `secure`，继续使用 `httpOnly`、`sameSite=lax` 和有限有效期；
   - 管理员会话 token 改为带签发时间、过期时间和随机 nonce 的签名 token，不再使用由口令确定性计算的永久固定值；
   - 后台退出通过清 Cookie 生效；生产级跨实例撤销在 Phase 1 会话表完成。
3. 增加未完成 SaaS 的发布门禁：
   - 开发环境保持可调试；
   - Phase 0 的生产环境对业务写入、项目读取、文件读取和 AI 调用统一返回 503；
   - 门禁不提供环境变量旁路，Phase 1 只有在逐路由接入真实鉴权并通过路由清单测试后，才能用真实鉴权替换门禁；
   - 门禁只防止误公开，不被描述成最终鉴权方案。
4. 增加不易破坏 Next.js 的安全响应头：
   - `X-Content-Type-Options: nosniff`；
   - `X-Frame-Options: DENY`；
   - `Referrer-Policy: strict-origin-when-cross-origin`；
   - 收紧 `Permissions-Policy`；
   - HTTPS 生产环境启用 HSTS；
   - CSP 先以 Report-Only 验证，浏览器 E2E 证明无破坏后再强制，不直接粘贴一份可能阻断 Next.js hydration 的严格策略。
5. CI 基线：
   - lint 不得出现 error；现有 warning 单独收敛，不伪装成零 warning；
   - `vitest run` 必须 46/46 文件通过；
   - 增加 `tsc --noEmit`；
   - 生产 build 必须通过；
   - E2E 在前端契约稳定后更新并纳入 CI，不能继续运行过时断言。
6. 工程基线：当前目录来自 ZIP 且没有 `.git`。正式提交前必须恢复上游 Git 历史或建立新的受控仓库；在此之前只保留本地变更清单，不伪造 commit 结果。

### Phase 1A：账号、工作区与统一鉴权骨架

该阶段不绑定短信、邮件或 OAuth 供应商，但建立供应商无关的身份和会话核心。

1. 数据库目标为标准 PostgreSQL 协议，不绑定托管厂商。
2. 新建核心模型：
   - `users`：平台用户主体、状态和时间戳；
   - `auth_identities`：登录渠道、供应商、供应商主体 ID、已验证联系方式；
   - `sessions`：只保存会话 token 的 SHA-256 摘要、用户、有效期、撤销时间和最近使用时间；
   - `workspaces`：商户/店铺的租户边界；
   - `memberships`：用户与工作区关系，角色为 `owner | admin | member`；
   - `workspace_invitations`：只保存邀请状态和目标联系方式，发送动作等认证渠道确定后再接入。
3. 登录会话：
   - 浏览器只持有 256-bit 不透明随机 token；
   - Cookie 使用 `httpOnly`、生产 `secure`、`sameSite=lax`、固定 path 和明确过期时间；
   - 服务端查找 token 摘要并验证用户、会话与工作区状态；
   - 退出、改密、封禁或管理员操作可以撤销会话；
   - 不把用户资料或权限放进可篡改 localStorage。
4. 登录供应商接口：
   - 供应商适配器只负责把已验证外部身份转换成 `provider + providerSubject + verifiedContact`；
   - 用户、工作区、成员、会话由本系统管理；
   - 未配置适配器时公开登录入口保持关闭，不再保留任意手机号/验证码通过的演示逻辑；
   - 如提供开发身份注入，只能在 `NODE_ENV !== production` 且显式打开开发开关时使用；生产检测到该开关必须拒绝启动认证模块。
5. 统一鉴权接口：
   - `getOptionalAuthContext(request)`：读取可选会话；
   - `requireUser(request)`：无有效会话返回 401；
   - `requireWorkspace(request)`：无有效工作区或成员关系返回 403；
   - `requireWorkspaceRole(request, roles)`：执行成员管理等高权限操作；
   - `requirePlatformAdmin(request)`：平台后台权限，与商户 `owner` 明确分离。

### 前端重构启动点

Phase 1A 的会话响应、工作区响应、项目列表响应和错误格式稳定后，立即开始前端重构：

- 调整工作台整体比例、侧栏、内容区宽度和不同屏幕断点；
- 重做点击“开始”后的信息架构与功能优先级；
- 登录状态改读 `/api/auth/session`，不读 `clipforge_user_session`；
- 工作区、项目、人物、品牌、模板和认可/发布状态都读取服务端 API；
- 视觉改版不等待任务队列、计费和支付全部完成。

前端需求另建独立设计文档和验收截图，不混入本基础设计的代码任务。

### Phase 1B：租户业务数据与 PostgreSQL 切换

1. 所有租户拥有的数据必须有 `workspace_id`：
   - `projects`；
   - `scripts`；
   - `publish_metrics`；
   - `assets`；
   - `video_clips`；
   - `compositions`；
   - `products`；
   - `brand_settings`；
   - `script_templates`；
   - `characters`；
   - 工作区级设置和认可/发布状态。
2. 子表即使能够经 `project_id` 找到工作区，也保留 `workspace_id` 并建立组合约束，避免错误关联到另一个租户的父记录。
3. 现有 `settings` 中的 Agent 策略属于平台级配置，迁为 `platform_settings`，不能错误分配给某个商户。
4. Repository 方法把 `workspaceId` 作为必需参数；Route Handler 不再直接调用裸 `getDb()` 查询业务表。
5. 对外资源查询使用 `workspaceId + resourceId`，跨租户资源统一返回 404，避免泄露资源是否存在。
6. PostgreSQL 启用 RLS 作为第二层防护：
   - 请求在事务内设置 transaction-local `app.workspace_id`；
   - 租户表策略只允许当前 workspace；
   - 后台迁移和受控 Worker 使用独立数据库角色；
   - 应用查询过滤与 RLS 同时存在，不能互相替代。

## 5. SQLite 数据迁移边界

不采用长期双写。迁移采用一次性、可回滚切换：

1. 创建一个 `legacy-default` 工作区和明确的 owner 用户；
2. 停止旧版本写入并备份 `data/sqlite.db`、`data/uploads`、`data/output`；
3. 导入 PostgreSQL：所有旧业务记录映射到 `legacy-default`；
4. 保留旧 ID，避免素材和项目关系重写；
5. 按表核对行数、外键、空值、项目状态和文件引用；
6. 导出不可变迁移报告，包含源行数、目标行数、跳过记录和失败原因；
7. 切换 Web 运行时到 PostgreSQL；
8. 回滚只允许回到迁移前冻结快照，不允许让 SQLite 与 PostgreSQL 同时继续接受写入。

二进制文件在对象存储供应商确定后单独迁移。数据库先保存稳定的 `storage_key`，不把本机绝对路径写入 SaaS 数据。

## 6. API 边界

### 6.1 公开接口

仅保留真正不需要身份的内容，例如落地页数据、健康检查和已配置认证供应商的回调。公开接口不得返回项目、素材、模型密钥或后台策略。

### 6.2 用户业务接口

项目、脚本、素材、上传、文件、成片、商品、人物、品牌、模板、认可/发布、AI 生成和发布文案全部要求 `AuthContext + workspaceId`。

### 6.3 平台后台接口

`/api/admin/*` 使用平台管理员会话，不接受普通商户 owner 权限替代。Agent 密钥只在服务端解密和调用，不返回前端。

### 6.4 文件接口

`/api/files/*` 和 `/api/output/*` 不再根据可猜测路径直接读取文件：

- 先通过数据库记录验证 workspace 所有权；
- 下载使用短期签名 URL 或经鉴权的流式代理；
- 私有对象默认不允许公共永久缓存；
- 响应文件名需要安全编码，不能直接拼接未清洗输入。

## 7. 错误与审计约定

- 401：没有有效用户会话；
- 403：用户存在但不属于工作区，或角色不足；
- 404：资源不存在或属于其他工作区；
- 409：邀请、成员关系、幂等键或状态迁移冲突；
- 429：发送、登录、AI 调用、并发或配额限制；
- 503：认证、数据库、存储或发布门禁未完成配置。

每个请求生成 `requestId`。安全事件记录 actor、workspace、action、resource、result、IP 摘要、user-agent 摘要和时间；日志不得记录验证码、session token、API key 或完整敏感请求体。

## 8. 持久任务边界

Phase 0/1 不继续扩展 Route Handler 内的异步合成方式。持久任务阶段采用 PostgreSQL job 表作为首版队列，减少一个外部基础设施依赖：

- Web 在事务中创建 `jobs` 和业务记录后返回 202；
- Worker 使用 `FOR UPDATE SKIP LOCKED` 领取任务；
- job 包含 workspace、类型、状态、attempt、maxAttempts、幂等键、进度、错误摘要和时间戳；
- Worker 心跳与租约过期后可重新领取；
- 任务支持取消、重试和结构化日志；
- 规模证明 PostgreSQL 队列不足后才引入 Redis/专用队列，不提前绑定供应商。

## 9. AI 额度与成本边界

AI 调用必须位于统一网关后，不能由各 Route Handler 直接自由调用：

- 请求前检查工作区状态、套餐权益、并发和预估成本；
- 预留额度后才调用 provider；
- 成功后记录实际 tokens、图片/视频规格、供应商费用和内部计价；
- 失败按可计费结果释放或结算预留；
- 使用幂等键防止重试重复扣费；
- 套餐与支付供应商未确认前先实现不可透支的内部额度账本，不实现收款。

## 10. 外部服务决策点与最小凭据

以下决策不会在未经确认时写死到代码：

### PostgreSQL 托管

需要决定托管平台和区域。最小配置：

- `DATABASE_URL`：应用受限角色；
- `DATABASE_MIGRATION_URL`：仅 CI/CD 迁移使用的高权限角色；
- TLS 要求和连接池参数。

### 登录渠道

需要在手机号短信、邮箱验证码/魔法链接、企业 OAuth 中确定首发渠道。最小凭据取决于渠道：供应商 API key、sender/template 标识、回调 secret 和允许域名。没有这些凭据时，公开登录保持关闭。

### 对象存储

优先要求 S3-compatible 私有桶，避免业务层绑定品牌 SDK。最小配置：endpoint、region、bucket、access key、secret key、签名 URL 有效期和允许的 CORS origin。

### 支付

不属于 Phase 0/1。确定收费地区、币种、开票和退款要求后再选择供应商；在此之前不能展示可购买套餐或声称余额可充值。

## 11. 测试设计

1. 测试修复必须先验证当前失败，再只改导入/mock 路径，证明没有触碰生产逻辑。
2. 后台配置测试覆盖：
   - 生产缺密码；
   - 生产缺独立 secret；
   - 开发默认配置；
   - 错误密码；
   - token 过期与签名篡改；
   - Cookie 生产属性。
3. 会话测试覆盖：创建、读取、过期、撤销、用户封禁、工作区停用和角色变化。
4. 租户隔离集成测试至少创建 workspace A/B，并验证 A 无法列出、读取、更新、删除、下载或触发 B 的资源。
5. Route 清单测试保证新增业务路由没有绕开鉴权包装器。
6. 迁移测试使用 SQLite 快照导入临时 PostgreSQL，核对行数和关系；不对生产库做首次试跑。
7. 前端 E2E 在重构后覆盖登录、工作区选择、创建项目、上传、脚本确认、任务轮询、入库和退出登录。

## 12. 前端重构的输入清单

基础接口稳定后，前端独立设计需要逐项确认：

- 桌面主工作区的侧栏宽度、内容最大宽度、上传区占比和案例区占比；
- 16:9、9:16、1:1 预览在列表与编辑页中的展示方式；
- 点击“开始”后究竟先进入项目建档、脚本确认还是自动任务页；
- 哪些功能是首屏主操作，哪些进入高级设置；
- 桌面和移动端是否采用同一信息架构；
- 生成库存、待发布、历史项目和设置的导航关系；
- 真实任务状态、失败恢复和额度提示的位置。

这些属于产品交互决策，不能只通过调整 CSS 比例解决。

## 13. 公开上线门槛

同时满足以下条件前，不得把服务描述为“可公开上线”：

- 真实认证供应商已配置，伪登录和生产开发绕过已删除或强制关闭；
- 所有业务 API、文件和 AI 路由通过服务端鉴权与 workspace 过滤；
- PostgreSQL 租户约束和 RLS 隔离测试通过；
- 私有对象存储和受控下载通过；
- 长任务由持久 Worker 执行，重启不丢任务；
- AI 额度、并发、成本预留与账本生效；
- 管理员认证无默认口令，具备限流、审计和会话撤销；
- 协议、隐私、AI 使用说明、账号注销、导出和删除流程可用；
- unit、typecheck、lint、build 和关键 E2E 全部在 CI 运行；
- 完成迁移演练、备份恢复演练和跨租户渗透测试。

## 14. 本轮明确不做

- 不直接购买或绑定短信、邮件、OAuth、支付、存储厂商；
- 不维持 SQLite/PostgreSQL 双写；
- 不在 Route Handler 中继续增加后台异步任务；
- 不用 localStorage 作为账号、权限或业务事实来源；
- 不在数据契约未稳定前大面积重写创作页面；
- 不把内存限流、开发身份注入或本地文件适配器宣称为生产级能力。
