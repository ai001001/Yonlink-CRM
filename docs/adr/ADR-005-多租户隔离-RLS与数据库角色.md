# ADR-005 多租户隔离：RLS 与数据库角色

- 状态：提议中
- 日期：2026-11-08
- 关联：ADR-003、ADR-006、`docs/02-数据库ER设计.md` §4–§5、`docs/03-系统架构.md` §4–§5

## 1. 背景
- 采用共享 PostgreSQL schema + `tenant_id` + RLS（原架构已定）。
- 风险：Prisma 默认以表属主连接，**表属主绕过 RLS**；连接池复用可能导致租户上下文串用；关联表缺少 `tenant_id` 时无法用约束阻止跨租户引用。

## 2. 决策：七层纵深隔离

| 层 | 机制 |
|---|---|
| L1 身份 | 租户只来自已验证会话（ADR-003/004），绝不读取请求中的 `tenant_id` |
| L2 API | 全局 `ValidationPipe({ whitelist: true, forbidNonWhitelisted: true })`，DTO 不含 `tenant_id/owner_id/role`；路由参数 ID 一律带租户条件查询，查不到返回 **404**（不区分“不存在”与“无权”） |
| L3 应用 | `nestjs-cls` 保存请求上下文；唯一入口 `withTenantTx(ctx, fn)`；Repository 只接收事务句柄；ESLint 规则禁止在 `packages/database` 之外实例化/导入 PrismaClient |
| L4 数据库约束 | 所有租户表含 `tenant_id NOT NULL`；被引用表提供 `UNIQUE(tenant_id, id)`；所有租户内外键为复合外键 `(tenant_id, x_id)`；关联表（`user_roles`、`role_permissions`、`user_departments`）均含 `tenant_id` |
| L5 RLS | 所有租户表 `ENABLE` + `FORCE ROW LEVEL SECURITY`，策略见 §3；未设置上下文时 `current_setting(..., true)` 为 NULL → 0 行（失败即拒绝） |
| L6 异步任务 | Job payload 携带 `tenant_id`、`actor_id`、`idempotency_key`；Worker 校验租户状态后在 `withTenantTx` 中执行 |
| L7 文件/缓存 | 存储键 `t/{tenant_id}/…`（ADR-002）；Valkey 键前缀 `t:{tenant_id}:` |

## 3. 数据库角色

| 角色 | 权限 | 用途 |
|---|---|---|
| `yonlink_migrator` | 表属主，DDL | 仅迁移时使用（ADR-006），应用运行时不持有其凭据 |
| `yonlink_app` | 对业务表按需授予 SELECT/INSERT/DELETE，UPDATE 采用**列级最小授权**（§8）；`NOBYPASSRLS`；非属主 | API 与 Worker 运行时连接 |
| `yonlink_auth` | `SECURITY DEFINER` 登录查询函数属主，最小只读 | ADR-003 登录前查询 |
| `yonlink_backup` | 只读 + `pg_dump` 所需权限（`BYPASSRLS` 仅限此角色） | ADR-008 备份；凭据仅备份脚本持有 |

策略模板：
```sql
ALTER TABLE <t> ENABLE ROW LEVEL SECURITY;
ALTER TABLE <t> FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON <t> FOR ALL
  USING (tenant_id = (SELECT app.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()));
```
- `app.current_tenant_id()` 的定义与连接池规则见 §7.3（2026-11-08 修订：不再直接使用 `current_setting(...)::uuid`，以正确处理空字符串残留与格式错误）。
- 事务内设置：`SELECT set_config('app.tenant_id', $1, true)`（等价于 `SET LOCAL`，事务结束自动失效）。`app.tenant_id` 只是上下文传递，不是租户身份认证（§7.1）。
- `audit_logs` 允许 `tenant_id IS NULL` 的平台事件，平台事件仅平台运维可读（单独策略）。
- `permissions` 为全局目录表，无 `tenant_id`，对 `yonlink_app` 只读。

## 4. 资源考虑
- 不引入 PgBouncer（单机 2 核无必要）；Prisma 连接池上限：api 10、worker 5，PostgreSQL `max_connections = 50`（ADR-007）。

## 5. 验收（全部为必过项）
1. Tenant A 令牌访问 Tenant B 资源（GET/PATCH/DELETE `/:id`）→ 404。
2. 请求体注入 `tenant_id`/`owner_id`/`role` → 400。
3. 外键填入其他租户记录 ID → 约束拒绝。
4. 以 `yonlink_app` 直连且不设上下文 → 查询 0 行、写入失败。
5. 设置 A 上下文写入 B 的 `tenant_id` → `WITH CHECK` 拒绝。
6. 连接池复用：A/B 交替并发 500 次请求，零串租户。
7. Worker 篡改 payload 中的 `tenant_id` → 拒绝并告警。
8. 迁移测试断言：所有含 `tenant_id` 的表均已启用并强制 RLS（防止遗漏新表）。

测试执行方式（独立测试库、模板复制、强制以 `yonlink_app` 连接、守卫测试、R1–R11 矩阵）见 **ADR-009 §3**。授权缓存与版本机制见 **ADR-004 §2.3**。

## 6. 租户表上的约束触发器规则（2026-11-08，随决策 6-1 补充）
- 用于维护业务约束的触发器（校验、加锁、延迟约束检查），其函数必须为 **`SECURITY INVOKER`**，以 `yonlink_app` 身份执行并受 RLS 与列级权限约束，且只访问与 `NEW/OLD.tenant_id` 相同租户的行；**不得**用 `SECURITY DEFINER` 实现业务约束，避免形成绕过 RLS 的通道。
- 例外仅限已批准的授权版本递增触发器（ER §3.9 第 6 条：`SECURITY DEFINER`、固定 `search_path`、只更新版本列/版本行）。
- 延迟约束触发器在提交阶段执行时依赖事务级 `app.tenant_id`（`set_config(..., true)` 作用域至事务结束），因此必须在 `withTenantTx` 内完成全部写入与提交。
- 约束触发器函数必须为 **`VOLATILE`**，**不得**改为 `STABLE/IMMUTABLE`：`VOLATILE` 函数在 `READ COMMITTED` 下每条语句取新快照，能看到并发事务已提交的行。
- 约束触发器必须执行**公共检查**（fail-closed）：
  1. **租户上下文**：经 `app.current_tenant_id()` 读取（§7.3），覆盖缺失（含空字符串残留）、格式错误、与 `NEW/OLD.tenant_id` 不一致；可检测“写入 A 行后切换到 B 并提交”。该检查**不是**租户身份认证（§7.1），也**不能**单独保证“一个事务只设置一次上下文”（§7.2）。
  2. **隔离级别**：需要并发正确性论证的约束（如 `user_departments`、部门状态）要求 `transaction_isolation = 'read committed'`，其他隔离级别直接报错。`REPEATABLE READ` 的旧快照会漏看并发提交的行，这是快照语义问题，**不能**用“提高隔离级别后重试”替代正确的快照与锁设计。
  3. ADR-004 §2.3.3 中权限缓存未命中时的**只读** `REPEATABLE READ` 事务不写入受约束表、不触发上述触发器，与本规则是不同路径。
- 首个落地实例：`user_departments` 主部门约束与部门状态规则（ER §3.10：D1 部分唯一索引、D2 保护触发器、D3 延迟约束触发器、D4 部门状态触发器；`departments.status NOT NULL` 与组合 CHECK；`deleted` 为终态），`user_departments` 为租户表，`ENABLE` + `FORCE ROW LEVEL SECURITY`，用户与部门复合外键共享同一 `tenant_id`。

## 7. 租户上下文的可信边界（2026-11-08，随决策 6-1 补充）

### 7.1 安全责任划分
| 层 | 责任 | 不承担的责任 |
|---|---|---|
| 应用层（NestJS） | 身份认证（ADR-003/004，会话每请求由 PostgreSQL 权威判定）；确定当前用户可访问的租户（0.1 中即会话所属租户）；RBAC/记录级授权；在 `withTenantTx` 中把该租户写入事务上下文 | 不能替代数据库对跨租户数据的结构性隔离 |
| 数据库层（RLS + 约束触发器） | 依据事务上下文过滤与限制行；复合外键阻止跨租户引用；公共检查确保写入行与上下文一致 | **不能**证明调用者有权使用该租户：所有请求共用 `yonlink_app`，PostgreSQL 允许任何会话设置自定义参数，普通 GUC 不是可信身份凭证 |

- 客户端提交的租户 ID（URL、请求体、请求头）**不是**可信授权结果，只能用于与会话租户比对后拒绝不一致的请求。
- 数据库上下文一致性检查不得被描述为租户身份认证。
- 若要求数据库独立验证租户授权，必须采用 §7.2 中的可信机制并完成专项评审；不得假设普通 `set_config` 自动具备该能力。

### 7.2 “一个事务只设置一次租户上下文”——⏳ 待专项技术评审
现状说明（不得夸大）：
- `withTenantTx` 封装在事务开始后设置一次上下文，属于**应用层规范**；
- 一个普通 `SECURITY INVOKER` 设置函数**不能**阻止调用者再次直接调用 `set_config`，用另一个 GUC 记录“已设置”标志同样可被调用者改写；
- D3 的提交时检查能发现“写入 A 行后切换到 B 并提交”，但**不能**发现 “A → B → A” 的中途切换。

候选机制（待评审，**未批准**）：
| 方案 | 机制 | 能力 | 代价与风险 |
|---|---|---|---|
| M0 | 维持现状：普通 GUC + `withTenantTx` + 公共检查 | 检测缺失、格式错误、不一致、部分中途切换 | 无法在数据库层强制“只设置一次”；依赖应用层 |
| M1 | 事务上下文登记表：`yonlink_app` 只能通过 `SECURITY DEFINER` 函数 `app.begin_tenant_tx(tenant_id)` 写入一张它无直接权限的表，主键为（后端进程号、当前事务 ID）；同一事务第二次调用即失败；`app.current_tenant_id()` 与 RLS 只从该表读取 | 数据库层强制“一事务一租户”，不受直接 `set_config` 影响；按事务 ID 隔离，不会被下一个事务继承 | 每个事务一次写入（需分配事务 ID）、需清理与 VACUUM；RLS 策略需以子查询形式只求值一次以控制开销；需评估对只读请求与 Worker 的影响 |
| M2 | 在 M1 基础上，以会话令牌哈希（请求路径）或作业令牌（Worker 路径）调用登记函数，由数据库根据已验证的会话/作业推导租户 | 数据库独立验证租户授权，而非接受调用者选择 | 复杂度最高；需为 Worker、平台运维、迁移等路径分别设计可信入口 |

在评审完成前：不得宣称数据库已强制“一个事务只设置一次”；D2–D4 公共检查按 §6 执行；该事项列入 T0-A 待办。

### 7.3 上下文读取函数与连接池
- 统一通过 `app.current_tenant_id()` 读取上下文：`NULLIF(current_setting('app.tenant_id', true), '')` 后做 UUID 格式校验；缺失返回 `NULL`（RLS 下结果为 0 行、写入被 `WITH CHECK` 拒绝），格式错误直接报错。RLS 策略与约束触发器不得直接使用 `current_setting(...)::uuid`（空字符串残留会导致不可控的类型转换错误）。
- 只允许事务级设置（`set_config('app.tenant_id', ..., true)`，等价 `SET LOCAL`）；**禁止**会话级 `SET`/`set_config(..., false)`（代码评审 + 测试断言）。
- 事务提交、回滚或出错后，事务级参数自动失效（在会话中残留为空字符串，由 `app.current_tenant_id()` 视为缺失）。
- 连接归还连接池前，事务封装必须确认事务已结束（无未提交/失败事务残留）；下一个事务不得继承上一个事务的上下文。
- 集成测试覆盖：提交、回滚、异常中止后同一物理连接上的下一个事务读取不到上下文；会话级误设置被检测（ADR-009 R7、U34）。

## 8. 列级权限与行级锁（2026-11-08，随决策 6-1 补充）
- PostgreSQL 要求 `SELECT ... FOR UPDATE / FOR NO KEY UPDATE / FOR SHARE / FOR KEY SHARE` 除 `SELECT` 外还需对被锁表**至少一列**有 `UPDATE` 权限；启用 RLS 时加锁查询同时受 `SELECT` 与 `UPDATE` 策略的 `USING` 约束（租户策略为 `FOR ALL`，满足该要求）。
- `yonlink_app` 采用**表级与列级最小授权**，不授予不受限制的全表 UPDATE；不得为满足加锁而授予与业务无关列的 UPDATE 权限。
- 首个落地范围（决策 6-1，ER §3.10.10）：
  - `users`：① 应用可直接更新——`display_name`、`locale`、`timezone`（列级 UPDATE）；② 受控业务操作——`status`、`deleted_at`、`email`、`username` 及认证相关列，只能经指定应用服务完成；经重置链接重置密码时由 `auth.consume_password_reset`（`SECURITY DEFINER`）更新（决策 6-2，§9），其余场景的数据库授权方式（列级授予或 `SECURITY DEFINER` 函数）⏳ 随 6-10 决定；③ 永不授予——`id`、`tenant_id`、`authz_version`、`created_at`。
  - `departments`：UPDATE 仅 `name`、`manager_user_id`、`parent_id`、`status`、`deleted_at`。
  - `user_departments`：`SELECT`、`INSERT`、`DELETE`，UPDATE 仅 `is_primary`。
  - `tenants`：不授予 UPDATE（版本递增由 `SECURITY DEFINER` 触发器完成）。
- 若某表只需加锁而无业务可更新列，须另行评审（如受控的 `SECURITY DEFINER` 加锁函数）并修订本节。
- 集成测试必须以真实 `yonlink_app` 及上述授权执行（ADR-009 U31–U33）。

## 9. 密码重置令牌与邮件 Outbox 的访问模型（2026-11-09，随决策 6-2 补充）
本节不新增数据库角色，沿用 §3 的角色体系；数据设计见 ER §3.11。

### 9.1 `password_reset_tokens`（租户表）
- `ENABLE` + `FORCE ROW LEVEL SECURITY`，租户隔离策略模板；复合外键保证目标用户、发起管理员与令牌同租户。
- **`yonlink_app` 不授予任何直接表权限**；读写只经 `auth.request_password_reset`、`auth.issue_admin_password_reset`、`auth.consume_password_reset`、`auth.purge_password_reset_tokens`（`SECURITY DEFINER`、固定 `search_path`，`yonlink_app` 仅有 `EXECUTE`）。因此任何租户用户、租户管理员或应用查询都不能读取令牌记录（含哈希），原始令牌从不入库。
- 管理员发起：调用前由应用层完成身份认证与 RBAC 授权（本租户相应管理权限）；函数在当前事务租户内校验目标用户，跨租户目标返回与“不存在”相同的结果。`requested_by_user_id` 来自应用层已认证上下文，数据库无法独立证明（与 §7.1 的信任边界一致）。
- ⏳ 自助申请与重置确认发生在租户上下文建立之前，需要按租户 slug 或令牌哈希跨租户查找；这些函数的属主角色及其跨租户读取方式**依赖决策 6-10**（`yonlink_auth` 权限模型：按角色定向 RLS 策略 + 列级授权，或 `BYPASSRLS`），本节不作决定。
- 函数内部为重置确认事务设置租户上下文，同样受 §7.2（“一个事务只设置一次”机制，待专项评审）约束。

### 9.2 `email_outbox`（含 `tenant_id` 的跨租户投递表）
- `ENABLE` + `FORCE ROW LEVEL SECURITY`（满足“含 `tenant_id` 的表均启用并强制 RLS”的守卫断言）。
- **不为 `yonlink_app` 定义任何策略，也不授予任何表权限**；即使误授权，`yonlink_app` 也读不到任何行。
- 访问只经 `outbox.*` 受控函数（`SECURITY DEFINER`，属主 `yonlink_migrator`，与 ER §3.9 版本触发器的属主做法一致；运行时进程不持有迁移角色凭据）。由于 FORCE RLS 对属主同样生效，为属主定义唯一的定向策略 `outbox_owner_access FOR ALL TO yonlink_migrator USING (true) WITH CHECK (true)`。
- 入队：0.1 只在 `auth.*` 密码重置函数内部入队（与令牌写入同一事务）；未来通用入队函数必须校验 `tenant_id` 等于当前事务租户。
- Worker：只能通过 `outbox.claim_email_batch` 取得自己领取的到期任务，不能按任意条件查询 Outbox；状态变更函数带围栏条件；载荷 AAD 绑定 `tenant_id`，密文无法挪用到其他行或租户。Worker 按单个任务处理，不在任务之间共享解密数据。
- 这样 Worker 既**无需绕过 RLS**，`yonlink_app` 也**不需要 `BYPASSRLS`**；RLS 不会阻止合法领取（领取经函数属主的定向策略完成）。
- 已知边界：API 与 Worker 共用 `yonlink_app`，API 进程在技术上也能执行 `outbox.*` 函数；这依赖代码边界与审计约束。⏳ 是否新增独立的 `yonlink_worker` 数据库角色（只拥有 `outbox.*` 的 `EXECUTE`，API 角色不再拥有）属于角色体系变更，**待用户决策**。

### 9.3 审计
- 申请（仅账号存在时按租户记录；不存在的账号只计入指标，不逐条落审计）、管理员发起（发起人、目标用户、租户、时间）、邮件 `sent/failed/cancelled`（以系统身份记录）、重置完成与失败（失败只记录原因类别）均写入 `audit_logs`；不记录令牌、密码、密文或完整收件人地址。
