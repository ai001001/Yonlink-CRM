# 销售报表与销售预测导出 CSV — 三轮测试记录

日期：2026-11-15　环境：同 [leads.md](leads.md)　参考：Zoho 报表导出
迁移：无

## 功能
- 销售报表页、销售预测页新增“导出”按钮（与页面当前筛选一致）；直接复用报表计算，导出数字与页面一致。
- 销售报表 CSV（`sales-report-币种-开始-结束.csv`）：开头为报表名、币种、时间段、负责人；之后按板块分段——概览、销售漏斗、按月赢单、负责人排行、线索来源转化、报价单状态，每段一行标题，段间空一行。
- 销售预测 CSV（`forecast-币种-期间.csv`，期间为月或季度）：每位负责人一行（目标、已赢单、赢单数、完成率、距离目标、在手商机、在手商机数、加权预测、预测、预测完成率、最好情况），最后一行为团队合计。
- 金额为不带货币符号的两位小数；比率为数字（表头带 %），无数据时留空；表头、阶段、来源、状态文字随界面语言；公式注入防护。
- 权限：需导出权限（管理员、经理）；销售代表、只读用户没有按钮，接口 403；遵循可见范围并按组织隔离。
- 审计：新增审计对象“报表”，操作 `report.export`，只记报表名、筛选与行数；审计日志显示“销售报表导出：币种，时间段”。
- 下载文件名改为优先使用服务器给出的文件名（只接受安全字符）；已有的线索、客户、商机、跟进、应收账款导出文件名格式不变。
- 不做：Excel 格式、图表导出、定时邮件发送。

## 第一轮：功能测试
命令：`npx vitest run tests/report-exports/report-exports.r1-functional.test.ts`
结果：**5/5 通过（修正测试代码后重新执行）**。原始输出：[results/report-exports-r1-functional.txt](results/report-exports-r1-functional.txt)；首次失败输出：[results/report-exports-r1-functional-first-run-failed.txt](results/report-exports-r1-functional-first-run-failed.txt)
覆盖：销售报表各板块与接口逐项一致（概览指标、漏斗、按月、负责人排行、线索来源、报价单状态）、筛选说明、文件名与响应头；英文表头、按负责人筛选显示姓名、公式注入防护；预测各行与团队合计与接口一致；季度期间与无目标时留空；两类导出的审计内容。

## 第二轮：集成测试
命令：`npx vitest run tests/report-exports/report-exports.r2-integration.test.ts`
结果：**4/4 通过（首次即通过）**。原始输出：[results/report-exports-r2-integration.txt](results/report-exports-r2-integration.txt)
覆盖：两类导出的权限（销售、只读 403；管理员、经理 200）；经理导出含全体负责人、跨组织只含本组织、用对方负责人筛选不泄露；8 类非法参数（币种、时间段颠倒、超过 24 个月、语言、未知参数、非法期间、预测不支持的参数）与未登录，均不写审计；跨域响应头。

## 第三轮：回归测试
命令：`scripts/regression.sh report-exports`（后台运行，逐阶段汇报）
结果：**PASS（首次运行即通过）**——lint 17s、typecheck 8s、Vitest **839/839**（247s）、静态导出 161s、生产构建 75s、E2E **51/51**（531s）。原始输出：[results/report-exports-r3-regression.txt](results/report-exports-r3-regression.txt)

### 失败与修复
| 现象 | 原因 | 修复 |
|---|---|---|
| R1 首次 1 项失败：漏斗段取出 20 行 | 导出文件中段间空行正确；测试用的 `parseCsv` 为导入而写，会去掉所有空行，测试无法分段 | 测试先按原始文本中的空行切分再逐段解析；同时把英文用例中一行恒为真的断言改为断言实际标题 |
| E2E 首次 1 项失败：预测文件名为 `forecast-CNY-2026-11-20261115.csv` | 实际问题：浏览器端下载函数总用前端拼出的文件名（再加一段当天日期），忽略服务器给出的文件名，报表文件名也丢了时间段 | 下载时优先使用服务器给出的安全文件名；已有导出的文件名格式不变（相关导出 E2E 7/7 通过）；E2E 期望销售报表文件名带时间段 |
