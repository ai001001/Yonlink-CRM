# 工作台自定义 — 三轮测试记录

日期：2026-11-15　环境：同 [leads.md](leads.md)　参考：Zoho CRM Home Page 自定义
迁移：`20261115180000_dashboard_layouts`（新表 `user_dashboard_layouts`：每个用户一行，按顺序保存显示的卡片键；组织内复合外键随用户删除；CHECK：卡片列表必须是 JSON 数组）

## 功能
- 工作台右上角“自定义工作台”：勾选要显示的卡片，用上移/下移调整顺序（不用拖拽：可用键盘操作，也更稳定），保存或“恢复默认”（显示全部卡片）；至少保留一张卡片。
- 卡片：客户/线索/商机数量、商机金额汇总、我的待办、最近跟进记录、**即将成交（新增）**、销售阶段分布。
- 即将成交：预计成交日期在今天起 30 天内、尚未关闭的商机，已过预计成交日期的也列出并标红；按日期排序，最多列 10 条并显示总数；点击跳转商机详情；遵循可见范围（销售只看自己的）。
- 布局保存在服务端，按用户隔离，换设备一致；不能替他人或他组织保存（用户与组织由会话决定，请求带这些字段返回 400）。只读用户也可自定义自己的工作台。
- 服务端只计算显示的卡片，隐藏卡片返回 null；已下线的卡片键在读取时忽略，全部失效时回到默认布局。
- 布局属于个人显示偏好，不写审计。
- 演示数据重建时清空演示组织的布局（回到默认）。
- 不做：管理员为全员或按角色设置默认布局、拖拽排序、卡片尺寸与自定义图表。

## 第一轮：功能测试
命令：`npx vitest run tests/dashboard-layout/dashboard-layout.r1-functional.test.ts`
结果：**6/6 通过（首次即通过）**。原始输出：[results/dashboard-layout-r1-functional.txt](results/dashboard-layout-r1-functional.txt)
覆盖：默认布局与各卡片初值；保存顺序与隐藏、隐藏卡片返回 null、再次保存覆盖且只有一行、恢复默认删除记录；已下线键与重复键被忽略、全部失效回到默认；6 类非法布局（空、重复、未知键、非数组、null、超长）与缺字段 400；即将成交含逾期与当天、第 30 天，排除第 40 天、已赢单、已输单、无日期，按日期排序，最多 10 条但总数照常；演示重置清空布局。

## 第二轮：集成测试
命令：`npx vitest run tests/dashboard-layout/dashboard-layout.r2-integration.test.ts`
结果：**5/5 通过（首次即通过）**。原始输出：[results/dashboard-layout-r2-integration.txt](results/dashboard-layout-r2-integration.txt)
覆盖：布局按用户与组织隔离、恢复默认只影响自己；请求带 userId / organizationId 400 且不写入；只读用户可保存；GET/PUT/DELETE 未登录 401；不写审计；同一用户 5 个并发保存只留一行且结果为其中之一；即将成交遵循可见范围（销售只看自己的、其他组织看不到）；跨域预检。

## 第三轮：回归测试
命令：`scripts/regression.sh dashboard-layout`（后台运行）
结果：**PASS（首次即通过）**——lint 17s、typecheck 7s、Vitest **915/915**（268s）、静态导出 54s、生产构建 56s、E2E **62/62**（606s）。原始输出：[results/dashboard-layout-r3-regression.txt](results/dashboard-layout-r3-regression.txt)

### 失败与修复
| 现象 | 原因 | 修复 |
|---|---|---|
| E2E 首次 1 项失败：保存后“最近跟进记录”仍显示，但“即将成交”已移到最前 | **功能缺陷**：自定义面板在打开动画结束后（afterOpenChange）把编辑状态重置为当前布局，动画期间的修改（取消勾选）被冲掉，之后的“上移”保留；用户操作快时同样会丢失修改 | 去掉动画结束后的重置，改为每次打开时用新的 key 重新挂载面板、从当前布局初始化；重新构建后新用例与原工作台用例 2/2 通过 |
