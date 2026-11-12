# 备注（线索 / 客户 / 商机）— 三轮测试记录

日期：2026-11-12　环境：同 [leads.md](leads.md)　参考：Zoho CRM Notes
迁移：`20261112110254_notes`（notes 表、恰好一个所属记录与内容非空的 CHECK、复合外键）、`20261112110919_notes_edited_at`（edited_at）

## 功能
- 线索详情“备注”区块、客户与商机详情“备注”页签：时间线（最新在前）、作者与时间、“已编辑 + 编辑时间”标记；Ctrl+Enter 提交；内容按纯文本显示（HTML 不执行）。
- 接口：`GET /api/notes?leadId|accountId|dealId`（恰好一个）、`POST /api/notes`、`PATCH/DELETE /api/notes/:id`。
- 权限：所属记录可见即可查看；新增需能编辑所属记录（只读不能新增）；修改仅作者本人；删除为作者本人或有删除权限的角色。
- 每条备注恰好属于一条记录（数据库 CHECK）；随所属记录级联删除；线索转化后保留在线索上。
- 审计：note.create / update / delete，正文脱敏（[redacted]），未改内容的保存不写审计、不标记已编辑。
- 演示数据新增 50 条备注（40 条商机、10 条客户，作者为记录负责人）。
- 审计日志页筛选新增“备注”，并补充导入/导出动作。

## 第一轮：功能测试
命令：`npx vitest run tests/notes/notes.r1-functional.test.ts --reporter=verbose`
结果：**8/8 通过**（加入编辑时间断言后重新执行）。原始输出：[results/notes-r1-functional.txt](results/notes-r1-functional.txt)
覆盖：三类记录新增并返回作者；列表只含该记录且最新在前；作者修改且保留换行、编辑时间；删除；审计三类事件且正文脱敏；未改内容不写审计、不标记已编辑；删除客户级联删除备注；演示数据备注作者为负责人。

## 第二轮：集成测试
命令：`npx vitest run tests/notes/notes.r2-integration.test.ts --reporter=verbose`
结果：**21/21 通过（首次即通过）**。原始输出：[results/notes-r2-integration.txt](results/notes-r2-integration.txt)
覆盖：销售代表只能给自己的记录加备注；只读可看不可加；只有作者能修改（管理员也不行）；删除规则；改派后原负责人看不到；转化后保留；组织隔离；7 类非法新增；5000 字边界；3 类非法列表查询；未登录 401；HTML 原样保存；数据库约束（缺少/多个所属记录、空白内容、跨组织作者与所属记录）。

## 第三轮：回归测试
命令：`scripts/regression.sh notes`（后台运行，逐阶段汇报）
结果：**PASS**——lint 12s、typecheck 6s、Vitest **435/435**（82s）、静态导出 50s、生产构建 39s、E2E **18/18**（185s）。原始输出：[results/notes-r3-regression.txt](results/notes-r3-regression.txt)

### 失败与修复
| 现象 | 原因 | 修复 |
|---|---|---|
| E2E：编辑后的备注未显示“已编辑” | **真实缺陷**：以“更新时间 − 创建时间 > 1 秒”判断是否编辑过（两个时间分别由数据库和程序生成，存在毫秒误差），创建后 1 秒内的编辑无法识别 | 新增 `edited_at` 字段（迁移），仅在内容真正改变时写入；界面显示“已编辑 + 时间”；R1 增加断言（修复前的 R1 输出保存为 [notes-r1-functional-before-editedAt.txt](results/notes-r1-functional-before-editedAt.txt)） |
| E2E：点击左侧“审计日志”被遮罩拦截 | 测试脚本未关闭详情抽屉就导航 | 先关闭抽屉并等待隐藏 |
