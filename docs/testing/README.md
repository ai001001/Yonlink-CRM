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
| 线索转化 | ✅ | ✅ | ✅ | [lead-conversion.md](lead-conversion.md) |
| 审计日志 | ✅ | ✅ | ✅ | [audit.md](audit.md) |
| 角色权限 + 演示账号一键登录 | ✅ | ✅ | ✅ | [rbac.md](rbac.md) |
| 修复：销售代表客户商机数 | ✅ | ✅ | ✅ | [account-deal-count.md](account-deal-count.md) |
| 商机销售漏斗看板 | ✅ | ✅ | ✅ | [deal-board.md](deal-board.md) |

## 整体回归（全部模块完成后）
命令：`scripts/regression.sh final-mvp` → **PASS**（lint、typecheck、11 文件 181/181、静态导出、生产构建、E2E 6/6）。原始输出：[results/final-mvp-r3-regression.txt](results/final-mvp-r3-regression.txt)
GitHub Pages 实际访问：https://ai001001.github.io/Yonlink-CRM/ 跳转至登录页，显示“静态前端预览，尚未接入真实后端”，直接访问业务页同样跳转登录，控制台无错误。
