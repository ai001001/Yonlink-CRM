# ADR-004 会话与 Web 安全

- 状态：**负责人已决策**（方案 B：纯服务端会话，决策 3/9；缓存方案 Y，2026-11-08 批准）；正式文本待 T0-A 最终决策清单统一批准
- 日期：2026-11-08
- 原文件：`ADR-004-会话与令牌.md`（已由本文件取代，其中 JWT + Refresh Token 方案已废弃）
- 关联：ADR-003、ADR-005、ADR-007、ADR-009、`docs/02-数据库ER设计.md` §3.1/§3.8、`docs/03-系统架构.md` §4、`docs/04-第一阶段开发任务书.md` T3/T4/T6

## 1. 背景
- 浏览器访问通过 Nginx 与 Web 同源，后端为单机模块化单体（ADR-001），不存在跨服务无状态验证需求。
- 企业级 CRM 要求禁用员工、修改密码、变更角色、停用租户后**立即**拒绝访问。
- 原提议的 “JWT + 轮换 Refresh Token” 为实现立即撤销需每请求回查会话，实际退化为“服务端会话 + JWT 额外复杂度”，故被否决。
- 原批准的 “Valkey 缓存会话有效状态 60 秒 + 撤销时主动删除” 经复核存在 F1–F5 失效路径（§2.2.1），已由**方案 Y** 取代。

## 2. 正式决策

### 2.1 会话架构
1. Session Token 为 **256 位密码学安全随机值**（`crypto.randomBytes(32)`，base64url 编码），不含任何可解析信息。
2. 浏览器 Cookie 属性：`HttpOnly; Secure; SameSite=Lax; Path=/`，不设置 `Domain`。
   - 生产 Cookie 名使用 `__Host-` 前缀：租户会话 `__Host-yl_sid`，平台运维会话 `__Host-yl_psid`。
   - 开发环境（`http://localhost`）浏览器允许 `Secure` Cookie；如个别工具不支持，仅允许通过显式开发配置关闭 `Secure`，生产启动时检测到该配置必须拒绝启动。
3. **PostgreSQL 是会话有效性的唯一权威来源**（`auth_sessions`、`platform_sessions`）。
4. 数据库只保存 Session Token 的 **SHA-256 哈希**，绝不保存明文；明文只在签发响应中出现一次。
5. **每个新请求必须向 PostgreSQL 验证**：会话存在、未撤销、未过期（空闲/绝对）、用户状态有效、租户状态有效。
6. **不允许使用 Valkey 缓存的会话有效状态直接放行请求**；Valkey 中不存储任何会话有效性数据。
7. 在会话与授权路径中，**Valkey 只用于缓存权限集合**（§2.3）。
8. PostgreSQL 不可用时返回 503；Valkey 不可用时回源 PostgreSQL，认证与授权要求不降低。
9. **不得把“缓存删除成功”作为会话撤销或权限撤销生效的必要条件。**

> Valkey 的其他独立用途（BullMQ 队列、登录限速计数，ADR-003）不参与会话有效性与授权判定。登录限速计数在 Valkey 不可用时，由数据库层账号锁定（`failed_login_count`/`locked_until`）继续生效。

### 2.2 立即撤销：语义与实现

#### 2.2.1 原方案复核结论（已废弃的“60 秒有效性缓存”）
| # | 场景 | 原方案结果 |
|---|---|---|
| F1 | 撤销 PG 提交成功，但删除 Valkey 键失败，读取方仍能读到 Valkey | 被撤销会话在 TTL 内仍被放行 |
| F2 | Worker 发起撤销且与 Valkey 失联，API 无从得知需降级 | 同上 |
| F3 | 并发竞态：请求读到“有效”→ 撤销并删缓存 → 请求回填旧“有效”值 | 删除后又被回填 |
| F4 | Valkey 重启从 AOF 恢复删除前的旧键 | 旧状态复活 |
| F5 | 部分故障（慢、丢包、单向失联）未被检测，降级模式不触发 | 无法证明 fail-closed |

方案 Y 通过“Valkey 不承载会话有效性 + 权限缓存按版本不可变寻址”在构造上闭合 F1–F5。

#### 2.2.2 “立即撤销”的正式语义
- **撤销事务提交后开始的新请求必须被拒绝**（会话撤销、用户禁用、租户停用、权限变更均适用）。
- 已经通过请求入口认证、正在执行的并发请求**不保证自动中断**。
- 若将来需要中断执行中的请求（如长事务、导出、流式响应），必须单独设计并评审“请求中途撤销检查”机制（新 ADR）。

#### 2.2.3 会话校验流程（每个受保护请求）
1. 读取 Cookie → 计算 SHA-256。
2. 调用 `auth.resolve_session(token_hash)`（`SECURITY DEFINER`，固定 `search_path`，应用角色仅有 `EXECUTE`，只返回必要字段）——**单条 SQL 语句**完成唯一索引点查与 `users`、`tenants`、`system_settings` 联读，返回：
   `session_id, tenant_id, user_id, 有效性判定所需字段, user.status, tenant.status, users.authz_version, tenants.authz_version, global_authz_version, authz_cache_epoch`。
   - 版本号与会话状态来自**同一语句快照**，不存在“旧版本组合”。
3. 依次校验：未撤销 → 未超过 `absolute_expires_at` → 未超过空闲期限（§2.5）→ 用户有效 → 租户有效。任一失败 → 401（租户停用可返回专用错误码）。
4. 校验通过后建立租户上下文（ADR-005），后续查询在 `withTenantTx` 中执行。
5. 节流写入 `last_used_at`/`idle_expires_at`（§2.5）。

### 2.3 权限缓存与授权版本（方案 Y）

#### 2.3.1 版本号
| 版本 | 存储位置 | 触发递增的变更 |
|---|---|---|
| 用户级 `users.authz_version` | `users` 列，`bigint NOT NULL DEFAULT 0 CHECK (authz_version >= 0)` | 用户角色分配增删（`user_roles`）；用户部门归属变化（`user_departments`，影响数据范围）；未来用户级直接授权/字段权限覆盖 |
| 租户级 `tenants.authz_version` | `tenants` 列，同上 | 租户内角色的权限集合变化（`role_permissions`）；角色增删、角色层级变化（`roles.parent_role_id`）；部门树结构与部门状态变化（`departments.parent_id`、`status`、`deleted_at`，见 ER §3.10.6）；租户级权限策略变化 |
| 全局 `authz.global_version` | `system_settings` 行（key = `authz.global_version`，值为非负整数） | 权限目录变化（`permissions` 增删改）；系统预置角色模板定义变化；任何跨租户批量修改 `role_permissions` 的迁移或 seed |
| 缓存纪元 `authz.cache_epoch` | `system_settings` 行（key = `authz.cache_epoch`，值为 UUID） | 数据库从备份恢复后（ADR-008 恢复 Runbook 必做步骤）；平台运维手动废弃全部权限缓存 |

#### 2.3.2 递增规则与事务要求
1. 版本号**只增不减**，每次递增 1；触发器拒绝任何使版本号变小的 UPDATE。数据库从备份恢复导致的版本回退由缓存纪元处理（§2.3.3）。
2. 版本递增与权限变更**必须在同一数据库事务中提交**。实现方式为**数据库触发器**（`AFTER INSERT/UPDATE/DELETE`，语句级），确保应用代码不可能遗漏：
   - `user_roles`、`user_departments` → 递增受影响用户的 `users.authz_version`；
   - `role_permissions`、`roles`（层级/删除）、`departments`（父级、状态、软删除变化）→ 递增对应 `tenants.authz_version`；
   - `permissions` → 递增 `authz.global_version`。
3. 迁移检查（ADR-006）断言上述触发器存在；任何修改 `permissions`/`role_permissions` 的迁移必须在同一迁移事务中递增 `authz.global_version`（迁移检查脚本校验）。
4. 用户状态（禁用）、租户状态（停用）、会话撤销**不依赖版本号**——它们在 §2.2.3 每请求由 PG 直接判定。

#### 2.3.3 缓存键与读取规则
- 键：`perm:{cache_epoch}:{global_version}:{tenant_id}:{tenant_authz_version}:{user_id}:{user_authz_version}`。
- 值：该版本组合下用户的有效权限集合（resource、action、scope 授权），**同一键对应的内容不可变**。
- 只缓存授权规则本身；具体记录可见范围（部门成员、下级部门）在查询时由 PG 计算，或其输入已纳入版本号。
- 读取规则：
  1. 版本组合**只能**取自本请求 §2.2.3 第 2 步的同一语句结果；
  2. 缓存命中 → 使用；
  3. 缓存未命中 / Valkey 异常 → 在**单个 `REPEATABLE READ` 只读事务**（仅用于取得版本组合与权限集合的一致快照；不写入任何受约束表，与 ER §3.10 / ADR-005 §6 要求 `READ COMMITTED` 的写入路径不同，不得混用）中重新读取版本组合与权限集合；仅当该事务读到的版本组合与请求版本组合一致时才写入缓存，否则只用于本请求（以更新者为准，不写缓存）；
  4. Valkey 写入失败忽略，不影响请求。
- TTL（默认 15 分钟）仅用于内存回收，**与正确性无关**。
- 旧版本键永远不会再被读取，因此无需删除；Valkey 重启、恢复旧数据或被写入伪造数据，都只可能命中“不再使用的旧键”或与当前版本组合不匹配。
- 数据库恢复导致版本号回退的场景，由 `authz.cache_epoch` 轮换 + 恢复 Runbook 清空 `perm:` 命名空间双重保障。

### 2.4 会话策略

| 项 | 默认值 | 可配置范围 | 配置层级 |
|---|---|---|---|
| 空闲超时 | 120 分钟 | 15–480 分钟 | 平台设定上下限，租户在范围内设置 |
| 绝对超时 | 12 小时 | 1–72 小时 | 同上 |
| 记住我 | 关闭 | 租户允许后，绝对超时最长 7 天 | 租户 |
| 每用户并发会话上限 | 5 | 平台设定上限 | 租户 |

- 超过并发上限时**淘汰最旧会话**（`revoked_reason = 'evicted'`）。
- **登录成功**和**权限提升**（含未来 MFA 验证通过、管理员模式切换）后重新生成 Session Token，旧令牌立即撤销（`revoked_reason = 'rotated'`）。
- 密码相关的会话处理（决策 6-2，2026-11-09 批准；取代原“修改/重置密码……可保留当前会话并轮换”的合并表述）：

  | 操作 | 会话处理 | `revoked_reason` |
  |---|---|---|
  | 通过密码重置链接重置密码（自助或管理员发起） | 在重置事务内撤销该用户**全部** `auth_sessions`；不签发新会话，用户须重新登录 | `password_reset` |
  | 用户已登录后主动修改密码 | 撤销该用户**其他**会话；当前会话按既有策略保留并轮换（旧令牌撤销为 `rotated`） | `password_changed` |
  | 租户管理员为用户发起密码重置 | 发起时不撤销会话；**用户完成重置**时撤销该用户全部 `auth_sessions` | `password_reset` |
  | 平台运维账号密码处理 | 使用独立 `platform_sessions` 规则（§2.8），撤销该运维账号全部平台会话，不涉及 `auth_sessions` | 平台会话表自身取值 |

  - 重置事务与会话撤销在同一 PostgreSQL 事务内提交（ER §3.11.6）；提交后开始的新请求即拒绝被撤销的会话；Valkey 不缓存会话有效状态。
  - 密码变化不影响授权版本（`authz_version`），授权缓存机制不变。
- 其他撤销事件：禁用/删除用户、重大角色变更（该用户全部会话）、租户停用（该租户全部会话）、管理员远程登出。
- 用户可查看自己的活动会话并远程登出单个会话。

### 2.5 空闲超时精度与写库节流
- `last_used_at` / `idle_expires_at` 最多**每 5 分钟**写库一次（由 §2.2.3 第 5 步按条件更新：仅当库中 `last_used_at` 早于 5 分钟前）。
- 为保证空闲超时精度，**API 进程内存**维护“会话最近活动时间”（有界 LRU，默认 10,000 条，约 1 MB）；判定时取 `max(库中 last_used_at, 进程内记录)`。
  - 进程内记录只来自本进程真实处理过的请求，不会凭空延长空闲期限。
  - API 进程重启后仅以库中值判断：只可能**提前**最多 5 分钟过期，**绝不会延后**。
  - Valkey 不参与空闲时间记录（遵守 §2.1 第 7 条）。
- 本设计假设 **API 为单进程**（ADR-001/007）；若未来运行多个 API 进程，须另立 ADR 重新设计空闲精度机制。
- 写库节流不影响撤销、绝对超时的判断。

### 2.6 CSRF 与来源校验（不依赖 SameSite 作为唯一防护）
1. **会话绑定的双提交 CSRF Token**：
   - 会话创建/轮换时生成 CSRF Token：`HMAC-SHA256(CSRF_SECRET, session_id || csrf_nonce)`，`csrf_nonce` 随会话保存；
   - 以非 HttpOnly Cookie `__Host-yl_csrf` 下发，前端在写请求头 `X-CSRF-Token` 回传；
   - 服务端校验：Header 与 Cookie 一致，且 HMAC 能用当前会话重新计算得到（常数时间比较）；会话轮换后旧 CSRF Token 失效。
2. **Origin 校验**：所有状态变更请求（POST/PUT/PATCH/DELETE）必须携带与配置的允许来源完全一致的 `Origin`；缺失时检查 `Referer` 的来源；两者均缺失或不匹配 → 403。
3. 辅助：校验 `Sec-Fetch-Site`（存在时必须为 `same-origin`）。
4. `SameSite=Lax` 仅作为纵深防御的一层。
5. GET/HEAD 请求不得产生状态变更（规范 + 测试）。

### 2.7 敏感信息
- Session Token、CSRF Token、Cookie 头、`Set-Cookie` 头、密码、密码哈希不得写入应用日志、Nginx 日志、审计日志、错误追踪与异常消息。
- 日志器配置字段级脱敏（`authorization`、`cookie`、`set-cookie`、`password`、`token` 等），并有自动化测试断言。
- 审计仅记录会话 ID（主键 UUID），不记录令牌或其哈希。
- 密码重置令牌、重置链接、Outbox 明文载荷适用同样的脱敏要求；重置页面的 `Referrer-Policy: no-referrer`、无第三方资源等要求见 ER §3.11.12。

### 2.8 平台运维会话
- 独立会话表 `platform_sessions`、独立 Cookie 名 `__Host-yl_psid`、独立认证入口 `/api/v1/platform/auth/*`、独立解析函数 `auth.resolve_platform_session(token_hash)`（ADR-003 第 6 条）。
- 每请求同样由 PostgreSQL 权威判定；平台运维授权不使用 Valkey 缓存。
- 租户会话不能访问平台 API，平台会话不能访问租户业务 API。
- 平台运维会话默认参数（**负责人 2026-11-08 已确认**）：
  - 空闲超时 **30 分钟**；
  - 绝对超时 **8 小时**；
  - **不支持“记住我”**；
  - 使用独立 `platform_sessions` 表；
  - Cookie（`__Host-yl_psid`）与认证域和租户用户完全分离。

### 2.9 资源影响（ADR-007）
- 每请求一次 PG 函数调用（唯一索引点查 + 主键联读，预计 < 0.5 ms）；私有部署典型负载（数十请求/秒）对 2 OCPU 可忽略；T10 压测记录 P95。
- Valkey 仅存权限集合（每个活跃用户版本组合约 1–5 KB），远低于 256 MB 预算。
- API 进程内活动时间 LRU 约 1 MB。
- 过期与已撤销会话由 Worker 每日分批清理（保留 30 天用于审计关联后物理删除）。
- 不新增任何服务或容器；ARM64 无差异。

## 3. 数据模型（同步至 `docs/02-数据库ER设计.md`）

`auth_sessions`（租户会话，含 `tenant_id`，受 RLS 保护；解析经 `SECURITY DEFINER` 函数）
| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | uuid（v7） | 会话主键，可出现在审计中 |
| `tenant_id` | uuid | 复合外键 `(tenant_id, user_id)` → `users` |
| `user_id` | uuid | |
| `session_token_hash` | bytea(32) | SHA-256；唯一索引 |
| `csrf_nonce` | bytea(16) | CSRF Token 派生用 |
| `created_at` | timestamptz | |
| `last_used_at` | timestamptz | 节流写入 |
| `idle_expires_at` | timestamptz | `last_used_at + idle_timeout` |
| `absolute_expires_at` | timestamptz | 创建时确定，不可延长 |
| `remember_me` | boolean | |
| `ip_address` | inet | 个人信息，按保留策略处理 |
| `user_agent` | text | 截断至 512 字符 |
| `auth_method` | text | `password`；预留 `sso`、`mfa` |
| `mfa_verified_at` | timestamptz null | 预留，Foundation 0.1 不使用 |
| `rotated_from_id` | uuid null | 轮换来源会话 |
| `revoked_at` | timestamptz null | |
| `revoked_reason` | text（CHECK） | `logout`、`rotated`、`evicted`、`password_changed`、`password_reset`（6-2 新增）、`user_disabled`、`role_changed`、`tenant_suspended`、`admin_revoked`、`expired_cleanup` |

索引：`UNIQUE(session_token_hash)`；`(tenant_id, user_id) WHERE revoked_at IS NULL`；`(absolute_expires_at)`。

`platform_sessions`：字段同上，以 `operator_id` 替代 `tenant_id/user_id`，不受租户 RLS 约束，仅平台认证角色可访问。

授权版本：`users.authz_version`、`tenants.authz_version`、`system_settings`（`authz.global_version`、`authz.cache_epoch`），详见 §2.3 与 ER §3.1/§3.8。

会话策略配置：平台上下限存 `system_settings`，租户值存 `tenant_settings`（`tenant_settings` 表是否在 0.1 建立由决策 6 确定）。

## 4. 已否决方案
| 方案 | 否决原因 |
|---|---|
| JWT 访问令牌 + 轮换 Refresh Token | 立即撤销需回查会话，失去无状态优势；增加签名密钥管理、算法混淆、刷新竞态等攻击面与复杂度 |
| JWT 不回查（15 分钟撤销延迟） | 不满足立即撤销要求 |
| Valkey 缓存会话有效状态 60 秒 + 主动删除 + 降级模式 | 存在 F1–F5 失效路径，无法证明 fail-closed（§2.2.1） |
| Valkey 记录最近活动时间用于空闲判定 | 违反“Valkey 只缓存权限集合”；改为 API 进程内记录（§2.5） |
| 令牌存 `localStorage` + Bearer | XSS 可直接窃取 |
| 外部 IdP（Keycloak 等） | 0.5–1 GB 内存，不符合单机预算；未来 SSO 以 OIDC/SAML 协议对接，另立 ADR |

外部系统集成（Platform 0.5 的 OAuth 2.0 / API Key）与浏览器会话分离，另立 ADR，不复用本会话机制。

## 5. 安全测试要求（T4/T6/T10 必过项）
故障注入方式：客户端故障注入包装（超时、错误、延迟、返回伪造数据）+ 停止/重启/恢复测试 Valkey 容器（`yonlink-crm-test`，ADR-009）。不引入额外代理容器。

| # | 测试 |
|---|---|
| S1 | 登录成功签发新令牌；库中仅存哈希，明文不可从库中恢复 |
| S2 | 篡改、随机、截断、已过期（空闲/绝对）、已撤销令牌均被拒绝（401） |
| S3 | **会话固定**：攻击者预置的 Cookie 在登录后失效，登录后令牌与登录前不同 |
| S4 | 权限提升后旧令牌立即失效 |
| S5 | 登出后同一令牌立即不可用 |
| S6 | 改密码、禁用用户、角色重大变更、租户停用后，相关全部会话失效 |
| S6a | 经重置链接重置成功（自助与管理员发起两种）后，该用户全部 `auth_sessions` 被撤销（`password_reset`）；提交后开始的新请求被拒绝；重置未自动登录 |
| S6b | 已登录用户主动修改密码后，其他会话被撤销（`password_changed`），当前会话轮换后可继续使用，旧令牌失效 |
| S6c | 重置事务任一步失败时整体回滚：密码不变、会话不被撤销、令牌未被消费 |
| S6d | 平台运维密码处理只撤销 `platform_sessions`，不影响任何 `auth_sessions`；租户密码重置不影响 `platform_sessions` |
| S7 | **撤销提交即拒绝**：撤销事务提交后开始的第一个新请求即被拒绝（会话撤销、用户禁用、租户停用三类，各循环 1,000 次，零放行） |
| S8 | **Valkey 不可用**（停止、超时、返回错误、高延迟）时：认证完全由 PG 正确判定——有效会话可用、已撤销会话被拒；授权回源 PG 计算，结果与缓存可用时一致 |
| S9 | **Valkey 重启 / 恢复旧数据 / 被写入伪造数据**：不会使已撤销会话重新有效（Valkey 中不存在会话有效性数据）；不会使旧权限或伪造权限被使用（键与当前版本组合不匹配） |
| S10 | **权限版本**：版本变化后的首个请求即使用新权限；旧版本缓存键存在时也不被读取 |
| S11 | **版本触发覆盖**：用户级（`user_roles`、`user_departments` 增删改）、租户级（`role_permissions`、`roles` 层级/删除、`departments` 父级/状态/软删除变化）、全局（`permissions` 变化）均在同一事务中递增对应版本；事务回滚时版本不变；版本不可递减 |
| S12 | **并发竞态**：权限变更与缓存读取并发（1,000 次循环），撤权提交后开始的请求零次使用旧权限；`REPEATABLE READ` 回填规则下不会把新内容写入旧键或旧内容写入新键 |
| S13 | **数据库恢复场景**：模拟版本号回退 + 轮换 `authz.cache_epoch` 后，恢复前的缓存不被使用 |
| S14 | 空闲超时精度：持续活动不提前过期；API 重启后最多提前 5 分钟、不延后 |
| S15 | 绝对超时不可被持续活动延长；“记住我”在租户未允许时无效，允许时 ≤ 7 天 |
| S16 | 并发会话超过上限时最旧会话被淘汰 |
| S17 | CSRF：缺失/不匹配/来自其他会话/轮换前的 CSRF Token 均被拒绝 |
| S18 | Origin：缺失、`null`、跨站 Origin 的写请求被拒绝；Referer 回退逻辑正确 |
| S19 | GET 请求不产生状态变更 |
| S20 | 租户会话访问平台 API、平台会话访问租户 API 均被拒绝 |
| S21 | Tenant A 的会话在任何接口中无法读取 Tenant B 数据（与 ADR-005 矩阵联动） |
| S22 | 日志扫描：应用/Nginx/审计输出中不出现 Session Token、CSRF Token、Cookie、密码 |
| S23 | Cookie 属性断言：`HttpOnly`、`Secure`、`SameSite=Lax`、`Path=/`、无 `Domain`、`__Host-` 前缀；生产配置关闭 `Secure` 时拒绝启动 |
| S24 | 时序：存在/不存在的令牌校验耗时无显著差异 |
| S25 | PostgreSQL 不可用时所有受保护请求返回 503，无任何放行 |

## 6. 遗留风险与待定事项
- 执行中的请求不随撤销自动中断（§2.2.2 正式语义）；如需中途撤销检查，另立 ADR。
- 空闲精度依赖 API 单进程假设（§2.5）；多进程部署需另立 ADR。
- `tenant_settings` 是否在 0.1 建表取决于决策 6；若推迟，0.1 的会话策略仅支持平台级全局配置。
- `authz.global_version` 以 `system_settings` 行存储，递增需行锁；变更频率极低，无性能风险。
