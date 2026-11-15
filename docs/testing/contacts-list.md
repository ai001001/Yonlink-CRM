# 联系人列表 — 三轮测试记录

日期：2026-11-15　环境：同 [leads.md](leads.md)　参考：Zoho CRM Contacts
迁移：无（复用已有 `contacts` 表）

## 功能
- 左侧导航新增“联系人”（位于“客户”之后）：全部可见联系人（跨客户），最新在前，分页。
- 搜索：姓名、职位、电话、邮箱、所属客户名称（不区分大小写，`%`、`_` 按字面匹配）。
- 筛选：所属客户、负责人（即所属客户的负责人；仅能查看全部数据的角色显示）、主要联系人 / 非主要联系人。
- 列表显示姓名（主要联系人带星标）、职位、电话、邮箱、所属客户（点击打开客户详情）、负责人、创建时间。
- 详情抽屉：联系人资料、所属客户（可跳转）、负责人；可编辑。
- 新建：选择所属客户后填写资料（沿用 `POST /api/accounts/:id/contacts`，设为主要联系人时自动取消该客户其他主要联系人）；编辑时所属客户不可更改。
- 导出 CSV（管理员、经理）：姓名、职位、电话、邮箱、主要联系人、所属客户、负责人、创建时间，与当前搜索和筛选一致；审计 `contact.export`。
- 权限：联系人属于客户——可见与编辑权限跟随所属客户（销售代表只看、只改自己负责客户下的联系人；只读用户只看）；按组织隔离；删除客户时联系人随之删除。
- 新接口：`GET /api/contacts`（列表）、`GET /api/contacts/:id`（详情）、`GET /api/contacts/export`（导出）。
- 不做：没有所属客户的独立联系人、联系人导入、标签、保存视图、批量操作、全局搜索中的联系人分组。

## 第一轮：功能测试
命令：`npx vitest run tests/contacts/contacts-list.r1-functional.test.ts`
结果：**5/5 通过（修正测试数据后重新执行）**。原始输出：[results/contacts-list-r1-functional.txt](results/contacts-list-r1-functional.txt)；首次失败输出：[results/contacts-list-r1-functional-first-run-failed.txt](results/contacts-list-r1-functional-first-run-failed.txt)
覆盖：跨客户列表、排序、所属客户与负责人；按姓名、职位、电话、邮箱（不区分大小写）、客户名称搜索，`%` 与 `_` 按字面匹配；客户、负责人、主要联系人筛选与组合、分页；详情与编辑后同步（设为主要联系人）；导出内容、表头、与筛选一致、审计。

## 第二轮：集成测试
命令：`npx vitest run tests/contacts/contacts-list.r2-integration.test.ts`
结果：**6/6 通过（首次即通过）**。原始输出：[results/contacts-list-r2-integration.txt](results/contacts-list-r2-integration.txt)
覆盖：销售只看自己负责客户的联系人（负责人、客户、搜索参数都不能越权，他人联系人详情 404）、管理员与只读看全部；只读不能改、销售不能改或在他人客户下新建（且不产生数据）；导出权限；跨组织隔离（列表、详情、在对方客户下新建）；6 类非法参数、未登录 401、非法 ID 404；删除客户后联系人从列表与详情消失。

## 第三轮：回归测试
命令：`scripts/regression.sh contacts-list`（后台运行，逐阶段汇报）
结果：**PASS（首次运行即通过）**——lint 18s、typecheck 20s、Vitest **850/850**（248s）、静态导出 97s、生产构建 73s、E2E **53/53**（549s）。原始输出：[results/contacts-list-r3-regression.txt](results/contacts-list-r3-regression.txt)

### 失败与修复
| 现象 | 原因 | 修复 |
|---|---|---|
| R1 首次 5 项全部失败：准备数据时新建联系人 400 | 测试数据问题：为测试通配符给联系人填了含 `%` 的邮箱，不是合法邮箱，被正常的邮箱校验拒绝 | 改为在职位中放 `100%_专员`；同时把导出用例中一行恒为真的表头断言改为如实检查 |
| 编辑联系人时“所属客户”会显示客户 ID（开发中自查发现，未进入测试） | 不可编辑的显示框放在了带字段名的表单项里，表单把客户 ID 填了进去 | 新建时用客户选择框，编辑时用不绑定字段的只读显示框展示客户名称 |
