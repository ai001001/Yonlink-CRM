# 商机销售漏斗看板 — 三轮测试记录

日期：2026-11-11　环境：同 [leads.md](leads.md)　参考：Zoho CRM Deals Kanban View

## 功能
- 商机页“列表 / 看板”切换；看板按 6 个销售阶段分列，列头显示数量与按币种金额合计。
- 卡片：商机名（点击打开详情）、客户、金额、预计成交日期、负责人；按预计成交日期升序（无日期排后）。
- 拖动卡片到其他列即更新阶段；卡片上的“移动到”下拉框提供无需鼠标的同等操作。界面先移动，服务端失败则恢复原位并提示。
- `GET /api/deals/board`（q / accountId / ownerId / limit 1–200，默认每列 50 张）；改阶段复用 `PATCH /api/deals/:id`，权限与审计不变。
- 可见范围与列表一致（销售代表只看、只能拖动自己负责的商机；只读用户不可拖动、无“移动到”）。

## 第一轮：功能测试
命令：`npx vitest run tests/deals/deal-board.r1-functional.test.ts --reporter=verbose`
结果：**7/7 通过**。原始输出：[results/deal-board-r1-functional.txt](results/deal-board-r1-functional.txt)
覆盖：6 列固定顺序；分列、数量、按币种精确合计；卡片排序；卡片展示字段；搜索；改阶段后列与合计变化并写审计；每列上限与 hasMore。

## 第二轮：集成测试
命令：`npx vitest run tests/deals/deal-board.r2-integration.test.ts --reporter=verbose`
结果：**15/15 通过（首次即通过）**。原始输出：[results/deal-board-r2-integration.txt](results/deal-board-r2-integration.txt)
覆盖：销售代表只见并只合计自己的商机；ownerId 筛选无法绕过可见范围；改阶段权限（只读 403、销售改他人 404、销售改自己与经理改任意 200）；非法阶段 400 且数据不变；未登录 401；其他组织不可见；6 种非法参数 400；limit 边界 1 与 200；通配符按字面处理；按客户筛选。

## 第三轮：回归测试
命令：`scripts/regression.sh deal-board`（后台运行，逐阶段汇报）
结果：**PASS**。原始输出：[results/deal-board-r3-regression.txt](results/deal-board-r3-regression.txt)
| 步骤 | 结果 |
|---|---|
| lint / typecheck | exit 0（9s）/ exit 0（6s） |
| 全量 Vitest | 21 文件 316/316 通过（56s） |
| GitHub Pages 静态导出 / 生产构建 | exit 0（45s）/ exit 0（40s） |
| Playwright E2E | 12/12 通过（162s）；新增：切换看板 → 列头数量与合计 → 拖动卡片改阶段 → “移动到”改阶段 → 刷新后保持 → 列表一致 → 卡片打开详情且操作记录含阶段变更；只读用户卡片不可拖动、无“移动到” |

### E2E 过程中的问题
| 现象 | 原因 | 处理 |
|---|---|---|
| 定位器匹配到 2 个元素 | 测试写法过宽，同时匹配卡片和“移动到 …”下拉框 | 改为整名精确匹配 |
| 卡片上的商机名无法按链接/按钮定位 | **真实可访问性缺陷**：使用了无 href 的链接，无链接角色、无法键盘操作 | 改为链接样式按钮，与其他页面一致 |
| 第一次回归在 E2E 阶段被中断 | 未提前告知耗时、输出到最后才写入，看起来像卡住（实际进行正常） | 改为后台运行、逐阶段汇报 |
