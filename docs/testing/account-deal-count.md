# 修复：销售代表看到的客户商机数 — 三轮测试记录

日期：2026-11-11　环境：同 [leads.md](leads.md)

## 问题
客户列表“商机数”列、客户详情“商机数”和“商机 (n)”页签使用 `_count.deals`，统计的是该客户下**全部**商机，未按可见范围过滤。销售代表会看到包含他人负责商机的数量（商机列表本身已正确过滤，两者不一致）。来源：[rbac.md](rbac.md) 剩余风险第 1 条。

## 修复
- `src/server/modules/accounts.ts`：客户返回内容改为 `listInclude(ctx)`，商机数使用与商机列表相同的可见范围（无 `record.read.all` 权限时只统计 `ownerId = 当前用户`）。
- “存在商机不能删除客户”的判断改为单独查询**真实总数**，不受显示计数过滤影响（返回的数量也为真实总数）。
- 无数据库变更。

## 第一轮：功能测试
命令：`npx vitest run tests/rbac/account-deal-count.r1-functional.test.ts --reporter=verbose`
结果：**3/3 通过**。原始输出：[results/account-deal-count-r1-functional.txt](results/account-deal-count-r1-functional.txt)
覆盖：销售代表在列表与详情只统计自己的商机；管理员/经理/只读用户统计全部；各角色计数与该客户商机列表条数一致。
**有效性验证**：将 `accounts.ts` 临时换回修复前版本执行同一测试，结果 2 失败 / 1 通过（销售代表计数为 3 而非 1），恢复修复后 3/3 通过——测试确实能发现该问题。

## 第二轮：集成测试
命令：`npx vitest run tests/rbac/account-deal-count.r2-integration.test.ts --reporter=verbose`
结果：**5/5 通过（首次即通过）**。原始输出：[results/account-deal-count-r2-integration.txt](results/account-deal-count-r2-integration.txt)
覆盖：经理改派商机给/离开销售代表时计数随之增减；他人负责与未分配的商机仍阻止删除客户，返回真实数量 2；联系人数不受影响；多客户时列表中每个客户的计数都等于可见商机数；其他组织商机不计入。

## 第三轮：回归测试
命令：`scripts/regression.sh account-deal-count`
结果：**PASS**。原始输出：[results/account-deal-count-r3-regression.txt](results/account-deal-count-r3-regression.txt)
| 步骤 | 结果 |
|---|---|
| lint / typecheck | exit 0 / exit 0 |
| 全量 Vitest | 19 文件 294/294 通过 |
| GitHub Pages 静态导出 / 生产构建 | exit 0 / exit 0 |
| Playwright E2E | 10/10 通过（RBAC 用例新增：经理经 API 在王芳的客户下加一个陈静负责的商机 → 王芳的客户列表商机数为 1、详情页签“商机 (1)”且不含该商机 → 经理看到 2） |

本次三轮均首次通过，无失败记录。
