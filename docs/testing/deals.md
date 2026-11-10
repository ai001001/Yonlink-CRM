# Deals 商机管理 — 三轮测试记录

日期：2026-11-10　环境：同 [leads.md](leads.md)

## 第一轮：功能测试
命令：`npx vitest run tests/deals --reporter=verbose`（当时仅含 R1 文件）
结果：**9/9 通过**。原始输出：[results/deals-r1-functional.txt](results/deals-r1-functional.txt)
覆盖：新增（金额、阶段、预计成交日期、关联客户、负责人默认当前用户）、默认值、数字金额精确保存、详情、编辑（推进阶段/改金额/清空日期/改关联客户）、删除、按商机名与客户名搜索、按阶段与客户筛选、按币种的十进制精确金额合计（0.10+0.20+999.99 = 1000.29）、分页。

## 第二轮：集成测试
命令：`npx vitest run tests/deals/deals.r2-integration.test.ts --reporter=verbose`
结果：**31/31 通过（首次即通过）**。原始输出：[results/deals-r2-integration.txt](results/deals-r2-integration.txt)
覆盖：必须关联客户、关联不存在客户 400、有商机时客户不可删/删商机后可删、删除商机只级联其自身跟进；8 种非法金额（负数、3 位小数、17 位整数、科学计数、浮点误差等）、金额上限与 0、数据库 CHECK 拒绝负金额、5 种非法日期与闰日、非法阶段/币种/名称、更新时不可清空必填字段；跨组织挂客户（新建/更新）被拒、IDOR 读/改/删 404 且数据不变、列表/搜索/金额合计隔离、不能为其他组织商机建跟进、复合外键阻止跨组织客户。

## 第三轮：回归测试
命令：`scripts/regression.sh deals`
结果：**PASS**。原始输出：[results/deals-r3-regression.txt](results/deals-r3-regression.txt)
| 步骤 | 结果 |
|---|---|
| lint / typecheck | exit 0 / exit 0 |
| 全量 Vitest（认证 + 线索 + 客户 + 商机） | 7 文件 121/121 通过 |
| GitHub Pages 静态导出 / 生产构建 | exit 0 / exit 0 |
| Playwright E2E | 4/4 通过（新增：必填校验 → 远程搜索选择客户 → 金额/阶段/日期 → 金额合计 → 推进到赢单 → 商机跟进 → 按客户名搜索 → 客户详情“商机”页签 → 有商机时删除客户被阻止并提示 → 删商机后删客户；线索、客户流程回归） |

### 失败与修复
本模块三轮测试均首次通过，无失败记录。

## 验收标准
- [x] 新增/编辑/删除/详情/搜索商机
- [x] 商机金额（numeric(18,2)，十进制字符串传输，精确合计）、销售阶段、预计成交日期、关联客户
- [x] 客户详情中查看商机；有商机的客户不能删除
- [x] 组织隔离（API + 复合外键 + CHECK 约束）
- [x] 三轮测试全部通过
