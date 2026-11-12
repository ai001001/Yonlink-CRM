# 保存自定义视图 — 三轮测试记录

日期：2026-11-12　环境：同 [leads.md](leads.md)　参考：Zoho CRM Custom Views
迁移：`20261112230730_saved_views`（saved_views、user_view_defaults 表与 view_entity 枚举；同一人同一列表视图名唯一；创建者、默认视图复合外键保证同组织，视图或用户删除时级联；名称非空、筛选必须为 JSON 对象的 CHECK）

## 功能
- 线索、客户、商机（列表模式）、跟进（列表模式）的筛选栏前新增视图选择：“全部记录 / 我的视图 / 共享视图”，选择即套用筛选条件。
- “另存为视图”：保存当前搜索词与筛选（线索：状态、来源、标签；客户：行业、标签；商机：阶段、标签；跟进：类型、完成状态），可同时设为默认、共享。
- 当前视图被修改筛选后出现“更新视图”；“视图操作”菜单：设为/取消默认、重命名、共享/取消共享、删除视图。
- 默认视图按用户保存，打开列表时自动套用；搜索框改为受控组件，套用视图时同步显示搜索词。
- 权限：所有登录用户（含只读）可建私有视图；共享给全组织需新权限 `view.share`（管理员、销售经理）；只有创建者能修改；共享视图也可由管理员/经理删除；
  视图只保存条件，查看者仍按自己的数据权限看到记录——共享不会扩大可见范围。
- 校验：筛选按各列表白名单校验（与列表查询参数一致，如标签 ID 必须是 UUID）；每人每个列表最多 50 个视图；名称 1–50 字。
- 默认视图只能设为自己可见、且属于同一列表的视图；取消共享时移除他人对该视图的默认设置。
- 审计：共享视图的新建、修改、删除（view.create / update / delete）；私有视图属于个人偏好不写审计。
- 无障碍：各列表的筛选下拉补充了 aria-label（此前只有占位文字）。
- 接口：`GET/POST /api/views`、`PATCH/DELETE /api/views/:id`、`PUT /api/views/default`。

## 第一轮：功能测试
命令：`npx vitest run tests/views/views.r1-functional.test.ts --reporter=verbose`
结果：**7/7 通过**（修正一处断言后重新执行）。原始输出：[results/views-r1-functional.txt](results/views-r1-functional.txt)；首次失败输出：[results/views-r1-functional-first-run-failed.txt](results/views-r1-functional-first-run-failed.txt)
覆盖：新建规范化（去空格、去空值、默认私有）；四个列表白名单与非法字段/取值；列表与同名 409（跨列表可同名）；更新筛选、重命名、删除；默认视图设置/替换/取消、删除视图时清除、跨列表 400；共享、取消共享移除他人默认、共享视图审计、私有视图不审计；套用视图与直接查询结果一致。

## 第二轮：集成测试
命令：`npx vitest run tests/views/views.r2-integration.test.ts --reporter=verbose`
结果：**19/19 通过（首次即通过）**。原始输出：[results/views-r2-integration.txt](results/views-r2-integration.txt)
覆盖：私有人人可建、共享仅管理员与经理；只有创建者能修改、他人私有不可见；删除规则；默认视图只能设为可见视图；共享视图不扩大可见范围（销售套用含他人负责人的视图仍为空）；跨组织隔离；每人每列表 50 个上限；10 类非法视图输入（含客户端提交 ownerId、organizationId、分页参数）；非法查询/默认/修改参数与未登录；数据库约束。

## 第三轮：回归测试
命令：`scripts/regression.sh views`（后台运行，逐阶段汇报）
结果：**PASS（首次即通过）**——lint 13s、typecheck 15s、Vitest **631/631**（133s）、静态导出 49s、生产构建 58s、E2E **33/33**（314s）。原始输出：[results/views-r3-regression.txt](results/views-r3-regression.txt)

### 失败与修复
| 现象 | 原因 | 修复 |
|---|---|---|
| R1：筛选字段顺序断言失败 | 测试代码：PostgreSQL jsonb 不保留键顺序 | 改为比较排序后的键集合 |
| 开发阶段 E2E：按“线索状态”“行业”定位到两个元素 | 测试脚本：预渲染的新建/编辑弹窗中有同名字段 | 限定在页面主体（main）内定位 |
| 开发阶段：列表筛选下拉无法按名称定位 | 筛选下拉只有占位文字，没有可访问名称 | 为线索、客户、商机、跟进的筛选下拉补充 aria-label |
