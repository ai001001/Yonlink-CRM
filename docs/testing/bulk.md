# 批量操作 — 三轮测试记录

日期：2026-11-11　环境：同 [leads.md](leads.md)　参考：Zoho CRM Mass Update / Mass Delete

## 功能
| 模块 | 批量动作 | 接口 |
|---|---|---|
| 线索 | 指派负责人、修改状态（不含“已转化”）、删除 | `POST /api/leads/bulk` |
| 客户 | 指派负责人、删除 | `POST /api/accounts/bulk` |
| 商机 | 指派负责人、修改阶段、删除 | `POST /api/deals/bulk` |
| 跟进 | 标记完成/重新打开、指派负责人、删除 | `POST /api/activities/bulk` |

- 每条记录调用单条操作的应用服务，权限、可见范围、业务规则（已转化线索状态锁定、有商机的客户不可删）与审计日志完全一致；每条独立事务，**允许部分成功**，失败逐条返回原因（NOT_FOUND / FORBIDDEN / CONFLICT 等）。
- 整批前置检查：删除需删除权限（否则 403）；指派需可指派给目标负责人且负责人为本组织启用用户（否则 403 / 400）。
- 每批 1–200 条，ID 自动去重。
- 前端：列表勾选后出现批量操作栏，按权限显示按钮；只读用户无勾选框；有失败时弹窗列出记录名称与原因；翻页/刷新自动清除不在当前页的选择。

## 第一轮：功能测试
命令：`npx vitest run tests/bulk/bulk.r1-functional.test.ts --reporter=verbose`
结果：**9/9 通过**。原始输出：[results/bulk-r1-functional.txt](results/bulk-r1-functional.txt)
覆盖：线索批量指派、取消分配、改状态、删除；重复 ID 去重；每条一条审计；客户指派与删除；商机改阶段、指派、删除；跟进完成、重新打开、删除。

## 第二轮：集成测试
命令：`npx vitest run tests/bulk/bulk.r2-integration.test.ts --reporter=verbose`
结果：**19/19 通过（首次即通过）**。原始输出：[results/bulk-r2-integration.txt](results/bulk-r2-integration.txt)
覆盖：销售代表对自己的成功、他人的 NOT_FOUND 且不变；销售代表批量删除与指派他人/取消分配整批 403；只读用户逐条 FORBIDDEN、删除 403；经理可改派任意记录；已转化线索 CONFLICT 其余照常；有商机客户 CONFLICT 其余删除；不存在/已删除 ID 为 NOT_FOUND 且重复删除幂等；只有成功的记录写审计；其他组织记录 NOT_FOUND 且不受影响；不能指派给其他组织或停用用户；7 类非法输入 400；200 条上限；四个接口未登录 401。

## 第三轮：回归测试
命令：`scripts/regression.sh bulk`（后台运行，逐阶段汇报）
结果：**第 1 次 FAIL（E2E 1 项）→ 修复后第 2 次 PASS**。最终输出：[results/bulk-r3-regression.txt](results/bulk-r3-regression.txt)；失败输出：[results/bulk-r3-regression-first-run-failed.txt](results/bulk-r3-regression-first-run-failed.txt)
| 步骤 | 结果（第 2 次） |
|---|---|
| lint / typecheck | exit 0（10s）/ exit 0（6s） |
| 全量 Vitest | 27 文件 361/361 通过（65s） |
| 静态导出 / 生产构建 | exit 0（42s）/ exit 0（38s） |
| Playwright E2E | 14/14 通过（177s）；新增：勾选 → 批量改状态 → 批量取消分配 → 客户批量删除部分失败并列出原因 → 跟进批量完成；只读用户无勾选框与批量栏 |

### 失败与修复
| 现象 | 原因 | 修复 |
|---|---|---|
| 回归中 RBAC E2E 失败：客户“商机数”期望 1，实际 3 | 测试按列位置（第 5 列）读取；本功能在表格左侧新增勾选列后列整体右移，第 5 列变为“联系人数”。功能本身正确；开发时只单独运行了批量用例，未同时运行 RBAC 用例 | 新增 `cellByHeader()`，按列标题“商机数”定位单元格，不再依赖列位置；重跑全量回归通过 |
| 批量 E2E 开发中：确认框标题匹配到 2 个元素 / `.first()` 命中隐藏元素 | antd 确认框包含一个隐藏的无障碍标题与一个可见标题 | 改为定位可见标题 `.ant-modal-confirm-title`（借助新增的失败截图确认界面正确） |
