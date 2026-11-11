# 数据导入导出（CSV）— 三轮测试记录

日期：2026-11-11　环境：同 [leads.md](leads.md)　参考：Zoho CRM Import / Export

## 功能
| | 范围 | 说明 |
|---|---|---|
| 导出 | 线索、客户、商机、跟进 | `GET /api/{module}/export`，参数与列表相同（筛选 + 搜索，全部页），上限 10000 条（超出时标记截断）；UTF-8 BOM + CRLF，中文表头与枚举，时间为北京时间；防公式注入；写审计（数量与筛选，不记搜索词） |
| 导入 | 线索、客户 | `POST /api/{leads,accounts}/import`（`dryRun` 预检 / 确认写入，`duplicates: skip|create`），模板 `GET /api/{leads,accounts}/import/template`；表头可用中文标签或英文字段名，枚举可填中文或代码；逐行复用新建校验；有效行一个事务写入并逐条审计，另写一条导入汇总审计；最多 2000 行、1MB |

- 权限：导出仅系统管理员、销售经理（新权限 `data.export`）；导入需新建权限，销售代表导入的记录负责人只能是自己。
- 查重：线索按邮箱、客户按名称（不区分大小写，本组织范围，含文件内重复）。
- 客户导入可同时创建主要联系人。
- 重构：各模块列表查询条件抽为 `xxxWhere()`，列表与导出共用。

## 第一轮：功能测试
命令：`npx vitest run tests/import-export/import-export.r1-functional.test.ts --reporter=verbose`
结果：**15/15 通过**（修复后重新执行并保存）。原始输出：[results/import-export-r1-functional.txt](results/import-export-r1-functional.txt)
覆盖：CSV 解析（引号、转义、换行、CRLF、BOM、空行）与未闭合引号；生成与往返；防公式注入；线索导出（表头、枚举、负责人邮箱、时间格式）；导出遵循筛选与搜索；客户/商机/跟进导出；导出审计不记搜索词；预检不写入；导入线索（中文/代码枚举、默认负责人、逐条与汇总审计）；英文表头与未知列提示；查重跳过/仍然创建；客户导入并建主要联系人；导出再导入往返；模板可被导入识别。

## 第二轮：集成测试
命令：`npx vitest run tests/import-export/import-export.r2-integration.test.ts --reporter=verbose`
结果：**首次 22/23（1 失败）→ 修复后 23/23 通过**。原始输出：[results/import-export-r2-integration.txt](results/import-export-r2-integration.txt)；首次失败：[results/import-export-r2-integration-first-run-failed.txt](results/import-export-r2-integration-first-run-failed.txt)
覆盖：导出仅管理员与经理；只读不能导入、销售代表负责人只能是自己；经理可指派；未登录 401；其他组织/停用用户邮箱不能作负责人；查重只在本组织；导出不含其他组织；逐行错误与行号；错误行不写入；4 类文件级错误；2000 行边界；5 类非法请求；导出公式注入转义且数据库保存原值；10000 条截断；导入审计不含原文；预检零写入。

### 失败与修复
| 现象 | 原因 | 修复 |
|---|---|---|
| 必填“姓名”为空时原因为“格式不正确”，期望“必填项为空” | **真实缺陷**：空单元格统一转为 null，必填字段因此报类型错误 | 必填列保留空串，校验报告“必填” |

## 第三轮：回归测试
命令：`scripts/regression.sh import-export`（后台运行，逐阶段汇报）
结果：**第 1 次 FAIL（E2E 1 项）→ 修复后第 2 次 PASS**。最终输出：[results/import-export-r3-regression.txt](results/import-export-r3-regression.txt)；失败输出：[results/import-export-r3-regression-first-run-failed.txt](results/import-export-r3-regression-first-run-failed.txt)
| 步骤 | 结果（第 2 次） |
|---|---|
| lint / typecheck | exit 0（10s）/ exit 0（7s） |
| 全量 Vitest | 29 文件 399/399 通过（75s） |
| 静态导出 / 生产构建 | exit 0（39s）/ exit 0（43s） |
| Playwright E2E | 16/16 通过（185s）；新增：上传 CSV 预检（错误行显示“客户名称：必填项为空”）→ 确认导入 → 列表可见 → 导出下载并校验文件（BOM、表头、行数、内容）；销售代表有导入、无导出 |

### 失败与修复
| 现象 | 原因 | 修复 |
|---|---|---|
| 导入导出 E2E：客户导入错误行字段显示“姓名” | **真实界面缺陷**：导入弹窗字段名称表与线索共用 | 客户导入使用“客户名称”“电话”等客户字段名 |
| 回归中“商机完整业务流程”失败：搜索后合计未变化（此前 CI 偶发失败的同一用例） | 失败截图显示保存后又出现空白“新增商机”弹窗：antd 关闭弹窗时把焦点还给“新增商机”按钮，测试在关闭动画期间按下回车，回车落在该按钮上重新打开弹窗、搜索未发出；负载高时更容易出现。应用行为正确，测试时序问题 | 新增 `searchList()`，搜索前等待所有弹窗完全关闭；8 处同类搜索全部改用；受影响用例连续 3 次通过，全量回归通过 |
