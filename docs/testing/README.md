# 测试记录（三轮测试制度）

| 轮次 | 目的 | 实现 |
|---|---|---|
| 第一轮 功能测试 | 新增、编辑、删除、搜索、详情、数据保存 | `tests/<模块>/*.r1-functional.test.ts`（Vitest，调用真实路由处理器 + 独立测试库） |
| 第二轮 集成测试 | 数据库关系、关联数据、异常输入、边界、组织隔离 | `tests/<模块>/*.r2-integration.test.ts` |
| 第三轮 回归测试 | 全量测试、前后端交互（Playwright E2E）、生产构建、静态导出、lint、typecheck | `scripts/regression.sh <模块>` |

- 测试库：`yonlink_mvp_test`（名称必须以 `_test` 结尾，否则测试拒绝运行）。
- 原始输出保存在 `results/`；每个模块的结论记录在 `<模块>.md`。

| 模块 | R1 | R2 | R3 | 记录 |
|---|---|---|---|---|
| 基础（认证/组织） | ✅ | ✅ | ✅ | 随 Leads 一起执行，见 [leads.md](leads.md) |
| Leads 线索 | ✅ | ✅ | ✅ | [leads.md](leads.md) |
| Accounts 客户（含联系人） | ✅ | ✅ | ✅ | [accounts.md](accounts.md) |
| Deals 商机 | ✅ | ✅ | ✅ | [deals.md](deals.md) |
| Activities 跟进 | ✅ | ✅ | ✅ | [activities.md](activities.md) |
| Dashboard 工作台（含全局搜索） | ✅ | ✅ | ✅ | [dashboard.md](dashboard.md) |
