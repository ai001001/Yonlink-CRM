# 应收账款导出 CSV — 三轮测试记录

日期：2026-11-14　环境：同 [leads.md](leads.md)　参考：Zoho 报表导出
迁移：无

## 功能
- 应收账款报表页的“导出”按钮：按当前币种与负责人筛选导出未收发票明细 CSV（文件名 `receivables-币种-日期.csv`）。
- 列：发票号、客户、负责人、币种、开票日期、到期日、发票金额、已收金额、未付余额、逾期天数、账龄；按到期日升序；与页面报表同一统计口径（直接复用报表计算）。
- 金额为不带货币符号的两位小数，便于在表格软件中计算；UTF-8 BOM + CRLF，Excel 可直接打开中文；表头与账龄文字随界面语言（中文 / 英文）。
- 公式注入防护：以 `= + - @` 等开头的单元格加前导单引号（沿用现有 CSV 工具）。
- 最多 10000 行，超出时截断并在提示中说明（沿用现有导出规则）。
- 权限：需导出权限（管理员、经理）；销售代表与只读用户没有按钮，接口返回 403；按组织隔离并遵循可见范围。
- 审计：`invoice.export`，只记录报表名、筛选（币种、负责人）、行数与是否截断；审计日志中显示“应收账款报表导出：币种，N 行”。
- 不做：Excel 格式、按客户汇总的单独导出、定时邮件发送。

## 第一轮：功能测试
命令：`npx vitest run tests/receivables/receivables-export.r1-functional.test.ts`
结果：**6/6 通过（修正测试代码后重新执行）**。原始输出：[results/receivables-export-r1-functional.txt](results/receivables-export-r1-functional.txt)；首次失败输出：[results/receivables-export-r1-functional-first-run-failed.txt](results/receivables-export-r1-functional-first-run-failed.txt)
覆盖：内容与报表一致（表头、金额、逾期天数、账龄、排序，合计等于页面未收金额）；文件名与响应头；英文表头与账龄文字；公式注入防护；币种与负责人筛选、无数据时只有表头；截断；审计内容。

## 第二轮：集成测试
命令：`npx vitest run tests/receivables/receivables-export.r2-integration.test.ts`
结果：**4/4 通过（首次即通过）**。原始输出：[results/receivables-export-r2-integration.txt](results/receivables-export-r2-integration.txt)
覆盖：销售与只读 403（带自己的负责人参数也一样）且不写审计、管理员与经理可导出全部；跨组织只导出本组织、用对方负责人筛选得到空表；4 类非法参数（币种、负责人、语言、未知参数）与未登录，均不写审计；跨域时可读取文件名与导出行数响应头、预检允许 GET。

## 第三轮：回归测试
命令：`scripts/regression.sh receivables-export`（后台运行，逐阶段汇报）
结果：**PASS（第二次运行通过，首次失败见下表）**——lint 19s、typecheck 8s、Vitest **830/830**（254s）、静态导出 63s、生产构建 84s、E2E **49/49**（478s）。原始输出：[results/receivables-export-r3-regression.txt](results/receivables-export-r3-regression.txt)

### 失败与修复
| 现象 | 原因 | 修复 |
|---|---|---|
| R1 首次 1 项失败：表头不符 | 测试代码写成“未收余额”，导出沿用发票页面已有的“未付余额” | 修正测试期望（保持与页面一致） |
| E2E 首次 1 项失败：找不到导出按钮 | 测试选择器加了首尾锚点，而按钮名称包含下载图标的名称 | 去掉锚点，与现有导出 E2E 写法一致 |
| R3 首次：既有“工作台”E2E 1 项失败（[首次失败输出](results/receivables-export-r3-regression-first-run-failed.txt)；其余 48/49 通过，Vitest 830/830） | 截图显示新增商机时“关联客户”未选上：与标签 E2E 相同，Ant Design 下拉展开动画期间的点击被忽略（该处为直接点击，无重试）。与本功能及运行期间日期跨过 UTC 零点无关 | 按结果重试（与标签 E2E 相同、已在 CI 验证的写法）：客户已显示在选择框中则结束，否则重新打开、搜索并点击；单独运行 3 次通过后完整重跑第三轮 |
