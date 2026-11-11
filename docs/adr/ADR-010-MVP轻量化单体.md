# ADR-010：最小化 MVP 采用轻量化 Next.js 单体

- 状态：已批准（2026-11-10，负责人在《Yonlink-CRM 最小化 MVP 开发指令》中明确指定）
- 取代范围：在 MVP 阶段替代 ADR-001/004/005/009 中与本 ADR 冲突的部分；原企业级蓝图保留为后续版本目标。

## 背景
原蓝图（docs/01–04、ADR-001~009）规划 NestJS + Monorepo + Valkey + RLS + 复杂 RBAC。负责人要求尽快交付真正可用的最小化 MVP，并明确禁止第一阶段引入不必要的 Redis、消息队列和微服务。

## 决策
| 项 | MVP 方案 | 原蓝图 |
|---|---|---|
| 应用 | 单个 Next.js 16（App Router），API 为 Route Handlers | Next.js + NestJS 分离 |
| UI | Ant Design 6，中文界面，文案走 `src/i18n` | 同 |
| 数据库 | PostgreSQL 18 + Prisma 7（migration 管理） | 同 |
| 本地数据库 | `embedded-postgres`（linux-arm64，无需 sudo/Docker） | Docker Compose |
| 认证 | Argon2id 密码 + 不透明会话令牌（DB 只存 SHA-256），`Authorization: Bearer` 传递 | Cookie 会话 + CSRF 双提交 |
| 租户隔离 | 所有业务表 `organization_id`；服务层按会话组织过滤；**复合外键 (organization_id, id)** 防跨组织引用 | + PostgreSQL RLS |
| 权限 | 固定四种角色（管理员/经理/销售/只读）+ 记录负责人可见范围（2026-11-11 实现，见 docs/testing/rbac.md） | RBAC + 记录/字段权限 |
| 缓存/队列 | 无 | Valkey + BullMQ |
| 测试 | Vitest 5（API 级集成测试，独立测试库）+ Playwright（系统 Chromium） | 同 |
| 演示 | GitHub Pages 静态前端（`BUILD_TARGET=pages`）+ Oracle 服务器 API | — |

Bearer 令牌的取舍：GitHub Pages 前端与 API 跨域，第三方 Cookie 会被浏览器拦截；Bearer 头不受 CSRF 影响。代价是令牌存于 localStorage，XSS 时可被读取——React 默认转义输出且不使用 `dangerouslySetInnerHTML`，后续版本可改回同站 Cookie。

## 后果
- 交付快、运维简单（单进程 + PostgreSQL）。
- RLS、自定义角色/字段权限、Valkey 权限缓存留到后续版本；审计日志已于 2026-11-10 实现（只追加、脱敏、与业务同事务，见 docs/testing/audit.md）；当前隔离依赖服务层过滤 + 复合外键 + 测试覆盖。
- 根目录 CLAUDE.md 中与本 ADR 冲突的安全条目（Valkey、CSRF 双提交、RLS 测试角色等）在 MVP 阶段不适用。
