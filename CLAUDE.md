# CLAUDE.md — Yonlink-CRM 项目开发规范

## 项目目标
Yonlink-CRM 是企业级、私有化部署、中文优先并支持英文及后续多语言/多币种的 CRM 平台。以 Zoho CRM Enterprise 的公开能力作为功能对标，不复制其源代码、商标、专有文案或受保护的设计。

## 开发前必读
每次任务开始前阅读：
- `docs/01-PRD.md`
- `docs/02-数据库ER设计.md`
- `docs/03-系统架构.md`
- `docs/04-第一阶段开发任务书.md`
- `docs/10-development-plan.md`（如已建立）

## 不可违反的规则
1. 模块化单体优先；未经 ADR 和负责人批准不得改为微服务。
2. TypeScript strict；所有 API 输入必须 DTO 校验。
3. 所有租户业务数据必须有 tenant scope；tenant_id 由服务端身份上下文决定。
4. 每个请求执行服务端认证和授权；前端控制不构成安全边界。
5. 不得信任客户端提交的 owner_id、role、tenant_id 或权限声明。
6. 所有 schema 变更必须通过 migration；不得手工修改生产数据库。
7. 不提交 `.env`、密钥、token、生产数据或真实客户数据。
8. 重要写操作写审计日志；日志必须脱敏。
9. 金额使用 Decimal/Numeric；时间使用 UTC timestamptz；多币种保留汇率快照。
10. UI 文案使用 i18n key；禁止把中文文案散落硬编码在组件中。
11. 不用 mock 数据冒充生产功能；演示 seed 必须清楚标注。
12. 每个功能必须有测试、文档和验收标准。
13. 不在未完成当前阶段验收时擅自开始下一阶段。
14. 不访问或修改生产服务器，除非负责人明确授权。

## 每次任务工作流
1. 说明目标、范围和不做事项。
2. 阅读相关模块和文档。
3. 提出数据/API/UI/权限影响。
4. 实施最小可审查变更。
5. 运行 lint、typecheck、相关测试和 build。
6. 汇报真实命令与结果，不得编造测试通过。
7. 更新文档和开发进度。
8. 列出剩余风险和下一步。

## 安全重点
- 认证、租户隔离、RBAC、记录权限、字段权限均在服务端执行。
- PostgreSQL RLS 作为纵深防御；连接池必须采用事务级 tenant context。
- 防止 IDOR、跨租户外键引用、SQL 注入、XSS、CSRF、暴力登录。
- 浏览器会话采用纯服务端会话（ADR-004）：Session Token 仅保存 SHA-256 哈希，不使用 JWT/Refresh Token；密码使用 Argon2id。
- PostgreSQL 是会话有效性的唯一权威来源：每个新请求必须向 PostgreSQL 验证会话、用户和租户状态；禁止用 Valkey 缓存的会话有效状态放行请求。
- Valkey 在授权路径中只缓存权限集合，缓存键必须包含 `cache_epoch`、全局/租户/用户授权版本；授权版本只能由数据库触发器在权限变更的同一事务中递增；撤权生效不得依赖缓存删除。
- CSRF 防护使用会话绑定的双提交 Token + Origin 校验，不得仅依赖 SameSite。
- 审计日志 append-only。
- 密码重置令牌只保存 SHA-256 哈希；原始令牌、密码、Outbox 明文载荷不得写入日志、追踪、异常、BullMQ 任务数据或普通数据库字段（决策 6-2，ER §3.11）。
- 邮件必须经 PostgreSQL 事务性 Outbox（`email_outbox`）投递；BullMQ/Valkey 只作唤醒，不得作为任务的唯一持久化来源；Outbox 载荷必须加密，密钥不得存入数据库。
- 测试统一使用 Vitest 5（E2E 使用 Playwright，ADR-009）；未经批准的 ADR 不得切换测试框架。
- RLS 集成测试必须在 `yonlink-crm-test` 的独立测试库中、以正式运行时角色 `yonlink_app` 连接执行，并通过守卫测试（非超级用户、无 `BYPASSRLS`、非表属主）；禁止以提高权限、mock 数据库或跳过测试的方式让测试通过。
- 文件下载必须鉴权，存储 key 按租户隔离。
- Webhook 必须签名、重放保护和幂等处理。

## 代码组织
遵守 `docs/03-系统架构.md` 的模块边界。跨模块调用应用服务接口或领域事件，不直接访问其他模块内部 Repository。

## 完成定义
“完成”意味着实现、权限、异常处理、测试、文档和验收全部完成；仅生成代码或页面不算完成。
