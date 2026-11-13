# 已知问题修复（标签与视图、E2E 下拉选择）— 三轮测试记录

日期：2026-11-13　环境：同 [leads.md](leads.md)
迁移：无

## 问题与修复
### 1. 标签删除后，按标签筛选的视图筛出空列表
- 原因：视图只保存标签 ID。标签被删除（手动删除，或演示数据重置时删除重建、ID 改变）后，视图仍按旧 ID 筛选，结果为空。
- 修复：
  - 删除标签时，在同一事务内从本组织所有视图（私有与共享）中去掉该标签筛选，其他条件保留；`tag.delete` 审计记录受影响的视图数量。
  - 演示标签改用由“组织 ID + 标签 key”推导的固定 ID（UUID v5 格式），重置后不变，按演示标签筛选的视图持续有效。
  - 演示重置时，去掉仍指向已不存在标签的视图筛选（例如用户在演示中自建、重置后被清除的标签）。

### 2. 4 个 E2E 用例（客户、跟进、工作台、商机）的下拉选择可能偶发失败
- 原因：这些用例直接点击下拉选项，展开动画期间的点击可能被忽略。上次尝试改用 `selectOption` 全部失败并撤回；本次复现查明根因：
  `selectOption` 每次重试前按 Esc 关闭残留下拉，但 **Esc 同时关闭了所在的新建弹窗**（截图确认“新增客户”弹窗已被关闭），之后找不到字段。
- 修复：`selectOption` 不再按 Esc，改为“目标选项不在已展开的下拉中时点击字段展开”，再选择并确认已选中，未生效自动重试；4 个用例共 6 处改用该函数。
  使用该函数的 7 个 E2E 文件（9 个用例）单独运行全部通过。

## 第一轮：功能测试
命令：`npx vitest run tests/maintenance/cleanup.r1-functional.test.ts --reporter=verbose`
结果：**4/4 通过（首次即通过）**。原始输出：[results/cleanup-r1-functional.txt](results/cleanup-r1-functional.txt)
覆盖：删除标签后所有用户的私有与共享视图只去掉该标签筛选、其他视图不变、审计记录数量；清理后的视图套用返回正常结果；演示标签 ID 两次重置后不变且视图仍有效；重置只清理失效的标签筛选。

## 第二轮：集成测试
命令：`npx vitest run tests/maintenance/cleanup.r2-integration.test.ts --reporter=verbose`
结果：**4/4 通过（首次即通过）**。原始输出：[results/cleanup-r2-integration.txt](results/cleanup-r2-integration.txt)
覆盖：不改动其他组织的视图（即使筛选值相同）；无权限删除失败时视图不变；视图与默认视图设置保留；固定 ID 为合法 UUID、可重复计算、按组织与标签区分。

## 第三轮：回归测试
命令：`scripts/regression.sh cleanup`（后台运行，逐阶段汇报）
结果：**PASS（首次即通过）**——lint 13s、typecheck 8s、Vitest **676/676**（158s）、静态导出 63s、生产构建 49s、E2E **35/35**（327s）。原始输出：[results/cleanup-r3-regression.txt](results/cleanup-r3-regression.txt)

### 过程记录
| 现象 | 原因 | 处理 |
|---|---|---|
| 修改演示数据文件的脚本中止 | 操作失误：假设文件中已有 import 语句，实际为纯数据文件 | 检查后在文件头注释之后加入 import，重新应用修改 |
