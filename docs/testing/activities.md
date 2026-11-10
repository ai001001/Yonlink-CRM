# Activities 跟进管理 — 三轮测试记录

日期：2026-11-10　环境：同 [leads.md](leads.md)

## 第一轮：功能测试
命令：`npx vitest run tests/activities/activities.r1-functional.test.ts --reporter=verbose`
结果：**12/12 通过**。原始输出：[results/activities-r1-functional.txt](results/activities-r1-functional.txt)（R2 修复后重新执行并保存）
覆盖：电话/会议/客户拜访/任务四类新增；同时关联客户、线索、商机并按各自查询；任务截止时间以 UTC 保存（+08:00 → Z）；完成/重新打开时完成时间同步，其他编辑不改动完成时间；新建即完成；部分更新保留其他字段、可清除关联；详情与删除；类型/完成状态筛选与主题/内容搜索；按截止时间排序（无截止排最后）。

## 第二轮：集成测试
命令：`npx vitest run tests/activities/activities.r2-integration.test.ts --reporter=verbose`
结果：**首次 30/30 → 补充用例后 30/31（1 失败）→ 修复后 31/31 通过**。原始输出：[results/activities-r2-integration.txt](results/activities-r2-integration.txt)
覆盖：关联不存在的客户/线索/商机 400 且返回全部字段错误；删除线索只级联其独有跟进；**共享跟进在删除线索/商机时保留并解除关联**；独立任务允许；数据库 CHECK 保证完成状态与完成时间一致；12 种非法输入、长度边界、更新时不可清空类型/主题、非法查询参数；跨组织列表隔离、IDOR 读/改/删 404 且数据不变、更新时挂到其他组织客户/线索/商机被拒、跨组织负责人被拒、复合外键阻止跨组织关联。

### 失败与修复
| 现象 | 原因 | 修复 |
|---|---|---|
| 复查发现一个 R2 用例标题声称覆盖“同时关联客户的跟进”，实际断言未覆盖；补充用例后失败：`expected [] to deeply equal [...]` | 外键 `ON DELETE CASCADE` 会把同时关联客户/商机的跟进一起删除，客户历史丢失 | 新增 `detachSharedActivities()`：删除客户/线索/商机时在同一事务内先对共享跟进只解除该关联，再删除记录；仅关联该记录的跟进仍级联删除。修正用例标题。全量 164 条测试通过 |

## 第三轮：回归测试
命令：`scripts/regression.sh activities`
结果：**PASS**。原始输出：[results/activities-r3-regression.txt](results/activities-r3-regression.txt)
| 步骤 | 结果 |
|---|---|
| lint / typecheck | exit 0 / exit 0 |
| 全量 Vitest | 9 文件 164/164 通过 |
| GitHub Pages 静态导出 / 生产构建 | exit 0 / exit 0 |
| Playwright E2E | 5/5 通过（新增：任务关联线索 → 截止时间与逾期标记 → 已完成电话记录 → 完成状态筛选 → 勾选完成 → 详情与编辑 → 线索详情时间线 → 删除 → 刷新持久化） |

### E2E 过程中的问题
| 现象 | 原因 | 处理 |
|---|---|---|
| Deals 提交的 GitHub Actions E2E 失败：`getByText('保存成功') resolved to 2 elements` | CI 速度更快，两条成功提示同时可见（测试写法问题） | 所有提示断言改为 `.first()` |
| `checkbox.check()` 报“状态未改变” | 完成复选框为受控组件，需服务端确认后刷新 | 改为 `click()` 后断言列表结果 |
| 抽屉入场动画期间按 Escape 未关闭 | 动画中键盘事件被忽略 | 统一改为点击抽屉“关闭”按钮 |

## 验收标准
- [x] 新增跟进记录：电话、会议、客户拜访、任务
- [x] 任务管理：截止时间、逾期标记、按截止时间排序
- [x] 完成状态（勾选完成/重新打开，记录完成时间）
- [x] 关联客户、线索和商机（可多重关联，详情页时间线可见）
- [x] 组织隔离
- [x] 三轮测试全部通过
