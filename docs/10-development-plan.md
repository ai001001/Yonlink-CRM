# Yonlink-CRM 开发总进度与版本计划

## 当前状态
- [x] 产品方向确认：Enterprise / Private / China + Global
- [x] 中文优先、英文及后续多语言
- [x] 多币种架构要求
- [ ] PRD 评审通过
- [ ] ER 设计评审通过
- [x] 第一轮环境检查、ARM64 兼容性核查与蓝图审核（2026-11-08）
- [x] 单服务器基础设施强制约束纳入 ADR（2026-11-08）
- [ ] 架构 ADR 批准（ADR-001 ~ ADR-008 已起草，状态：提议中，见 `docs/adr/README.md`）
- [ ] 负责人系统准备操作完成（见下文“T0 负责人操作清单”）
- [ ] Foundation 0.1 开发启动

## 版本计划

| 版本 | 交付范围 | 状态 |
|---|---|---|
| Foundation 0.1 | 工程、认证、租户、组织、RBAC、审计、部署 | 待开始 |
| CRM MVP 0.2 | 线索、客户、联系人、商机、活动、导入导出 | 待开始 |
| Sales 0.3 | 产品、报价、合同、订单、回款 | 待开始 |
| Enterprise 0.4 | 工作流、审批、Blueprint、自定义模块/字段 | 待开始 |
| Platform 0.5 | 报表、仪表盘、API、Webhook、集成 | 待开始 |
| Advanced 1.0 | 营销、客服、Cadences、门户、AI、Sandbox | 待开始 |

## 基础设施强制约束（2026-11-08 负责人指定）
1. **唯一服务器**：现有 Oracle Cloud ARM64 Ubuntu 26.04（2 OCPU / 12 GB RAM / 100 GB 磁盘 / aarch64 / 用户 `ai` / 目录 `/home/ai/Desktop/CRM/Yonlink-CRM/`）。禁止购买、租用或依赖其他云服务器、云数据库、云缓存、云对象存储、付费 CDN、付费 CI/CD。
2. **部署**：PostgreSQL、Valkey、Next.js、NestJS、Nginx、Worker 全部部署于该服务器；Docker Compose + 模块化单体；不使用 Kubernetes，不拆分微服务。
3. **存储**：第一阶段本地磁盘 + 统一存储接口；后续仅可扩展为本机自托管 S3 兼容服务。
4. **备份**：PostgreSQL、上传文件、配置均需备份与恢复流程；有容量告警、保留周期和离线副本；同盘备份不是唯一灾备。
5. **资源**：所有服务遵守内存/CPU/磁盘预算、日志轮转、容器资源限制与容量监控。

## 架构决策（ADR）

| 编号 | 决策摘要 | 状态 |
|---|---|---|
| ADR-001 | 技术栈与单服务器部署基线：Node 26 LTS（已决策）、pnpm、NestJS 12、Next.js 16、Ant Design v6 + `@yonlink-crm/ui`（已决策）、Prisma 7.x（锁定）、PostgreSQL 18、Valkey 8、Nginx、Docker Compose；仅 127.0.0.1 绑定；本机 CI | 提议中（§0、§0A 已决策） |
| ADR-002 | 文件存储：本地磁盘 + `StorageProvider` 接口，取代 MinIO；租户隔离存储键；鉴权下载 | 提议中 |
| ADR-003 | 登录与租户识别：租户 slug + 邮箱 + 密码；默认租户配置；`SECURITY DEFINER` 登录查询；平台运维独立认证域 | 已决策（待最终批准） |
| ADR-004 | 会话与 Web 安全：纯服务端会话（256 位 Opaque Token，仅存 SHA-256 哈希）；方案 Y——PG 每请求权威判定会话有效性，Valkey 仅缓存按 `cache_epoch`/全局/租户/用户授权版本寻址的权限集合；会话绑定 CSRF + Origin 校验；平台运维独立会话域 | 已决策（待最终批准） |
| ADR-005 | 多租户隔离：七层纵深；`FORCE RLS`；四个数据库角色；复合外键 | 提议中 |
| ADR-006 | 数据库迁移：只前进 + 手写 `rollback.sql` + expand/contract + 迁移前强制备份 | 提议中 |
| ADR-007 | 单服务器资源预算与容量监控：内存/CPU/磁盘预算、日志轮转、cron 容量检查与告警 | 提议中 |
| ADR-008 | 备份恢复与离线灾备：restic 加密备份、20 GB 本地上限、负责人电脑每周拉取 + 移动硬盘每月离线、每月恢复演练；恢复后轮换权限缓存纪元 | 提议中 |
| ADR-009 | 测试框架与数据库集成测试：Vitest 5 全仓统一 + Playwright E2E；`yonlink-crm-test` 独立测试库、模板复制、`yonlink_app` 连接、守卫测试、R1–R11 RLS 矩阵 | 已决策（待最终批准） |

## 服务器资源预算摘要（详见 ADR-007）

### 内存（实测物理 11.6 GiB；桌面与开发工具常驻约 5.0 GB）
| 场景 | 预算 |
|---|---|
| 部署栈 6 个容器内存上限合计 | ≈ 4.2 GB（postgres 2.0 / valkey 0.384 / api 0.768 / worker 0.512 / web 0.512 / nginx 0.064） |
| 开发栈（容器 + 主机 dev 进程） | ≈ 3.7–4.2 GB |
| 单项峰值（next build / E2E / 备份，串行执行） | ≤ 2.5 GB |
| 测试环境 `yonlink-crm-test`（按需） | PostgreSQL 768 MB + Valkey 128 MB；运行集成/E2E 时停止 `next dev` 与 API/Worker 开发进程，核算 ≈ 8.8 GB |
| 缓冲 | 4 GB Swap 文件（负责人执行） |

### 磁盘（文件系统 96 GB）
| 类别 | 预算 |
|---|---|
| 系统与桌面 | 15 GB |
| Swap | 4 GB |
| Docker 镜像与缓存 | 10 GB |
| 源码与依赖 | 8 GB |
| PostgreSQL | 10 GB |
| 上传文件 | 10 GB |
| 本地备份 | 20 GB（硬上限） |
| 日志 | 2 GB |
| 临时空间（恢复演练 / 测试数据库，串行使用） | 5 GB |
| 保底空闲 | ≥ 12 GB |

告警：文件系统 70% 警告 / 80% 严重 / 90% 拒绝新上传；最近备份 > 26 小时警告；离线副本 > 8 天提示。

## Foundation 0.1 执行顺序（已纳入基础设施约束）

| 顺序 | 任务 | 基础设施相关调整 |
|---|---|---|
| T0 | 决策确认与系统准备 | ADR 批准；负责人执行下方系统操作 |
| T1 | 仓库与工具链 | `turbo --concurrency=1`；`pnpm ci:local`；gitleaks 提交检查 |
| T2 | 基础设施 | Compose：postgres + valkey（无 MinIO）；全部资源限制与日志轮转；数据目录在项目外；`capacity-check.sh`；restic 备份/恢复脚本与 Runbook；首次恢复演练 |
| T3 | 数据库基础 | 四个数据库角色；复合外键；RLS；`rollback.sql`；迁移前备份钩子 |
| T5a | 租户上下文 | `withTenantTx` + 连接池串租户测试 |
| T4 | 认证 | ADR-003/004 |
| T5b | 组织与用户 | 部门层级、多部门主部门 |
| T6 | RBAC | 权限矩阵测试 |
| T7 | 审计 | append-only + 哈希链 + 按月分区 |
| T9 | API 规范 | `/api/v1`、OpenAPI、统一错误码 |
| T8 | 前端基础壳 | 仪表盘展示真实系统状态（容量、备份时效）；字体与静态资源自托管、无外部 CDN |
| T10 | 测试与本机 CI | 全程并行推进；E2E `workers=1` |

## T0 负责人操作清单（需 sudo，Claude Code 不执行）
- [ ] 安装 Docker Engine 与 Compose v2（Ubuntu `docker.io` / `docker-compose-v2` 或 Docker 官方源），将 `ai` 加入 `docker` 组
- [ ] 创建 4 GB Swap 文件并设置 `vm.swappiness=10`
- [ ] 设置 journald `SystemMaxUse=500M`
- [ ] 批准后安装 restic（Ubuntu 仓库）
- [ ] 安装 pnpm（npm 安装至用户目录，或负责人指定方式）
- [ ] 核对 OCI 安全列表：Xvnc `8484`、rpcbind `111` 是否对公网开放
- [ ] 离线保管 restic 仓库密码与 `.env` 主密钥的方案

## 待负责人确认的决策
1. ✅ **已决策（2026-11-08）**：登录模型采用 A——租户 slug + 邮箱 + 密码；支持单租户默认租户配置、记住上次租户、`/login/{slug}`；多租户不得按邮箱猜测租户；平台运维独立认证域；为未来全局 identity 预留升级空间但 0.1 不实现（详见 ADR-003 §0）
2. ✅ **已决策（2026-11-08）**：Node.js 26 LTS（开发与容器统一，`.nvmrc`=`26`，`engines >=26.13 <27`）；基础镜像 `node:26-trixie-slim`（Debian 13 glibc，多阶段构建，验证 arm64）；生产镜像固定 digest、每月安全检查、更新前全量构建测试、保留上一已验证版本；2029-04-30 前完成升级，2028-10 评估 Node 28；回退 Node 24 须单独 ADR（详见 ADR-001 §0）
3. ✅ **已决策（2026-11-08）**：纯服务端会话（Opaque Session Token）。256 位随机令牌，Cookie `HttpOnly; Secure; SameSite=Lax; Path=/`；PG `auth_sessions` 权威存储、仅存 SHA-256 哈希；~~Valkey 缓存会话有效状态 60 秒~~（已由方案 Y 取代，见第 4 项附注）；空闲 120 分钟（15–480）、绝对 12 小时（1–72）、记住我默认关闭（≤ 7 天）、并发 5 淘汰最旧；登录与提权后轮换令牌；会话绑定双提交 CSRF + Origin 校验；平台运维独立 Cookie/会话表/认证域；ER、T4、CLAUDE.md 已同步（详见 ADR-004-会话与Web安全.md）
4. ✅ **已决策（2026-11-08）**：Ant Design v6.x + `@ant-design/nextjs-registry` + `@ant-design/icons`；不引入 ProComponents（待 v3 稳定兼容 v6 后另立 ADR）与 Tailwind；Theme Token + CSS Modules；业务文案 next-intl，组件内置文字用 ConfigProvider 语言包 + dayjs；建立 `@yonlink-crm/ui` 封装层，ESLint 禁止业务代码直接 import antd；前端权限隐藏不构成安全控制；T8 交付自有视觉规范（不使用 Zoho 配色、图标或专有界面表达）（详见 ADR-001 §0A）
   - 附：第 3 项遗留已确认——平台运维会话空闲 30 分钟、绝对 8 小时、不支持记住我、独立 `platform_sessions` 与 Cookie/认证域（ADR-004 §2.8）
   - 附：✅ **已决策（2026-11-08）**——ADR-004 缓存方案 Y：PostgreSQL 为会话有效性唯一权威来源，每个新请求向 PG 验证；Valkey 只缓存权限集合，键含 `cache_epoch` + 全局/租户/用户授权版本；版本由触发器在同一事务递增、只增不减；撤权不依赖缓存删除；“立即撤销”= 撤销提交后开始的新请求被拒绝，执行中请求不保证中断（ADR-004 §2.2–§2.3、ER §3.9）
5. ✅ **已决策（2026-11-08）**：Vitest 5 全仓统一（`apps/api`、`apps/worker`、`apps/web`、`packages/*`）；后端 `unplugin-swc` + `@nestjs/testing` + supertest；前端 jsdom + Testing Library，antd 所需浏览器接口统一补齐；覆盖率 `@vitest/coverage-v8`；E2E 继续 Playwright；T1 完成 PoC（DI、Guard、Pipe、Prisma 7 ESM、峰值内存）；后端回退 Jest 30 + `@swc/jest` 须独立 ADR 批准；不放松覆盖率/安全/RLS 要求（详见 ADR-009 §2）
   - 附：✅ **RLS 集成测试方案已批准**：`yonlink-crm-test`（PG 768 MB）；模板库执行迁移一次、无活动连接；每进程 `CREATE DATABASE ... TEMPLATE`（非事务执行）；专用 `yonlink_test_admin` 管理库；RLS 测试一律 `yonlink_app` 连接且权限与生产一致；守卫测试（非超级用户、无 BYPASSRLS、非表属主）；覆盖跨租户读写、无上下文、错误上下文与隔离；单元 ≤ 2、集成 1–2、E2E 1 进程且串行；完整的创建/清理/失败恢复流程（详见 ADR-009 §3）
6. 第一阶段数据库表与数据模型范围（分析报告已提交，逐项确认中）
   - ✅ **6-1 已决策（2026-11-08）**：`user_departments` 纳入 0.1，方案 A——用户可以没有部门；最多一个主部门；有部门时恰好一个主部门（只有一个部门时即为主部门）；数据库层以部分唯一索引 + 保护触发器（锁用户行、校验部门有效）+ 延迟约束触发器 + 部门停用触发器实现，触发器为 `SECURITY INVOKER`；并发控制为“先锁用户行再读写”；测试 U1–U37（详见 ER §3.10、ADR-005 §6、ADR-009 §3.5A）
   - ✅ **新增决定 A（2026-11-08）**：`departments` 增加 `status`（`NOT NULL`，`active`/`inactive`/`deleted`）与 `deleted_at`，组合 CHECK `(status = 'deleted') = (deleted_at IS NOT NULL)`；有效部门 = `status = 'active' AND deleted_at IS NULL`
   - ✅ **新增决定 B（2026-11-08）**：部门存在任何成员关联（不区分用户状态）时，数据库禁止停用或软删除；不自动迁移成员、不自动指定主部门；移除成员仍遵守主部门规则
   - ✅ **新增决定 C（2026-11-08）**：`deleted` 为终态，禁止 `deleted → active/inactive` 与修改已删除部门的 `deleted_at`；0.1 不提供部门恢复；未来恢复须另行架构决策
   - 最终修订要点：`departments.status NOT NULL`（CHECK 对 NULL 放行）；D1–D4 明确（D4 含终态与成员前置条件）；D2/D3/D4 为 `SECURITY INVOKER` + `VOLATILE`，强制上下文一致与 `READ COMMITTED`；锁模式为用户行 `FOR NO KEY UPDATE`、新增成员时部门行 `FOR SHARE`、部门停用 `FOR NO KEY UPDATE`；全局顺序 `users → departments → tenants`，区分数据库强制规则与调用方编排规则；`yonlink_app` 列级最小授权满足加锁要求（ER §3.10.10、ADR-005 §8）；租户上下文可信边界与连接池清理（ADR-005 §7）；测试 U1–U37
   - ⏳ 6-1 相关待专项评审/待决：① 数据库级“一个事务只设置一次租户上下文”机制（ADR-005 §7.2，候选 M0/M1/M2，未批准）；② `users` 受控业务列的数据库授权方式（重置路径已由 6-2 确定，其余随 6-10）；③ 部门上下级停用与部门树遍历语义（属于 6-8，6-1 不作规定）
   - ✅ **6-2 已批准（2026-11-09，方案 A）：密码重置机制**——租户管理员可为本租户用户发起重置；普通用户邮箱自助重置；平台运维账号由其他平台管理员或服务器命令行处理、与租户流程隔离；开发环境本地邮件替身、生产需 SMTP；256 位随机令牌、库中只存 SHA-256；自助 30 分钟、管理员 24 小时；一次性消费并防并发；URL fragment + `Referrer-Policy: no-referrer` + 前端清理 fragment + 日志不泄露；申请一律 HTTP 202；账号每小时 3 次、IP 每小时 10 次，Valkey 故障安全降级；重置成功同一事务更新密码、撤销全部 `auth_sessions` 与其他未使用令牌
   - ✅ **6-2 附带正式决定：PostgreSQL 事务性 Outbox + Worker 投递 + 失败重试 + 幂等处理**——`email_outbox` 为唯一邮件 Outbox；载荷 AES-256-GCM 加密、密钥不入库；BullMQ 只作唤醒；至少一次投递语义（详见 ER §3.11、ADR-004 §2.4、ADR-005 §9、ADR-006、ADR-009 §3.5B）
   - 📝 6-2 文档修订（2026-11-09）**待负责人审核**
   - ⏳ 6-2 相关待确认/待专项评审：① 新申请是否使旧的未使用令牌失效（文档暂按“取代”设计，ER §3.11.2）；② 生产环境未配置 SMTP 时的处理（当前设计为邮件重置功能视为未启用，管理员与用户均无法通过邮件重置；是否允许其他替代方式需决策）；③ 管理员每小时 20 次发起上限等限速细节；④ 是否新增独立 `yonlink_worker` 数据库角色（ADR-005 §9.2，属角色体系变更）；⑤ 是否改用非对称密封加密使 API 无法解密 Outbox（ER §3.11.4）；⑥ `auth.*` 函数的属主与跨租户读取方式依赖 6-10
   - ⏳ 6-3 ～ 6-11 待确认：平台运维角色模型、`tenant_settings` 结构、`login_attempts`、`teams`、`role_permissions` 结构、scope 取值与 subordinates 语义、系统预置角色可编辑性、`yonlink_auth` 权限模型（ADR-005）、备份恢复后会话处理（ADR-008）
7. 审计日志默认保留期（建议 365 天）与合规要求
8. 界面使用自主功能命名，不使用 Zoho 专有功能名（如 Blueprint、Cadences）
9. 批准后同步修订 `docs/03-系统架构.md`、`docs/04-第一阶段开发任务书.md` 中 MinIO/Redis 表述
10. ⏳ **待决策（新增，2026-11-08）**：TypeScript 版本选择
    - 当前提议：TypeScript 6.0.x（**暂不批准，非最终决定**）。
    - 原因：当前生态对 TypeScript 7（npm `latest` 已为 7.0.2）的兼容尚不成熟；初步核查 `typescript-eslint` 8.72 的 peer 范围为 `>=4.8.4 <6.1.0`，`ts-jest` 为 `<7`，需进一步核查工具链兼容范围。
    - 后续单独提交：版本、生态兼容性、ARM64、升级策略分析。
    - 与已批准的 Node.js 26 LTS 决策相互独立，不改变 Node.js 决策。

## 变更管理
任何影响数据库主键、租户隔离、权限模型、模块边界、API 兼容性和货币精度的变更，必须新增 ADR，并由项目负责人批准。
自 2026-11-08 起，任何引入新服务、新容器、外部依赖或改变资源预算的变更，同样必须新增或修订 ADR（尤其是 ADR-001、ADR-007），并确认不依赖额外付费云资源。

## 每周汇报模板
- 本周完成：
- 变更文件：
- 数据库迁移：
- 自动化测试结果：
- 安全检查：
- 未解决问题：
- 下周计划：
- 是否满足阶段验收：
