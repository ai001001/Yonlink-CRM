# 永联CRM（Yonlink-CRM）

企业 CRM 最小化 MVP：工作台、线索、客户（含联系人）、商机、跟进管理。
技术栈：Next.js 16 · TypeScript (strict) · Ant Design 6 · PostgreSQL 18 · Prisma 7 · Vitest 5 · Playwright。

- 演示（静态前端预览，**尚未接入真实后端**）：https://ai001001.github.io/Yonlink-CRM/
- 测试记录：[docs/testing/](docs/testing/README.md)
- 设计文档：[Zoho 模块研究](docs/mvp/01-Zoho核心模块快速研究.md) · [数据库设计](docs/mvp/02-数据库设计.md) · [ADR-010 MVP 架构](docs/adr/ADR-010-MVP轻量化单体.md)

## 本地开发（Linux ARM64 / x64，无需 Docker 与 sudo）

```bash
npm install
npm run db:start          # 启动本地 PostgreSQL（首次自动生成 .env 与随机密码，保持运行）
npm run db:migrate        # 另开终端：执行数据库迁移
npm run db:seed           # 创建组织与管理员（读取 .env 中的 SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD）
npm run dev               # http://localhost:3000
```

`.env` 不入库；变量说明见 [.env.example](.env.example)。

## 测试

```bash
npm run lint && npm run typecheck
npm test                  # Vitest：API 级集成测试，使用独立测试库 yonlink_mvp_test
npm run build && npm run test:e2e   # Playwright E2E（生产构建 + 测试库）
scripts/regression.sh <名称>        # 第三轮回归：全部检查并保存结果到 docs/testing/results/
```

## 目录

```text
prisma/                 schema 与 migration
src/app/(crm)/          业务页面（工作台、线索、客户、商机、跟进、搜索）
src/app/api/            REST API（Route Handlers）
src/server/             认证、校验、模块应用服务（按组织隔离）
src/components, lib     共享 UI 组件、API 客户端、Hooks
src/i18n/               界面文案（zh-CN）
tests/                  Vitest（每模块 r1-functional / r2-integration）
e2e/                    Playwright 端到端测试
```

## 安全要点
- 每个请求都由服务端校验会话；`organization_id` 只来自会话，请求体中的 `organizationId`/`id` 被拒绝。
- 所有引用使用 `(organization_id, id)` 复合外键，数据库层面禁止跨组织关联。
- 密码 Argon2id；会话令牌只存 SHA-256 哈希；登录失败限流。

品牌声明：永联CRM 为自主品牌与自主代码，仅参考 Zoho CRM 的公开业务设计，与 Zoho 无任何关联。
