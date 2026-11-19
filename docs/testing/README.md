# 测试记录（三轮测试制度）

| 轮次 | 目的 | 实现 |
|---|---|---|
| 第一轮 功能测试 | 新增、编辑、删除、搜索、详情、数据保存 | `tests/<模块>/*.r1-functional.test.ts`（Vitest，调用真实路由处理器 + 独立测试库） |
| 第二轮 集成测试 | 数据库关系、关联数据、异常输入、边界、组织隔离 | `tests/<模块>/*.r2-integration.test.ts` |
| 第三轮 回归测试 | 全量测试、前后端交互（Playwright E2E）、生产构建、静态导出、lint、typecheck | `scripts/regression.sh <模块>` |

- 测试库：`yonlink_mvp_test`（名称必须以 `_test` 结尾，否则测试拒绝运行）。
- 原始输出保存在 `results/`；每个模块的结论记录在 `<模块>.md`。

| 模块 | R1 | R2 | R3 | 记录 |
|---|---|---|---|---|
| 基础（认证/组织） | ✅ | ✅ | ✅ | 随 Leads 一起执行，见 [leads.md](leads.md) |
| Leads 线索 | ✅ | ✅ | ✅ | [leads.md](leads.md) |
| Accounts 客户（含联系人） | ✅ | ✅ | ✅ | [accounts.md](accounts.md) |
| Deals 商机 | ✅ | ✅ | ✅ | [deals.md](deals.md) |
| Activities 跟进 | ✅ | ✅ | ✅ | [activities.md](activities.md) |
| Dashboard 工作台（含全局搜索） | ✅ | ✅ | ✅ | [dashboard.md](dashboard.md) |
| 线索转化 | ✅ | ✅ | ✅ | [lead-conversion.md](lead-conversion.md) |
| 审计日志 | ✅ | ✅ | ✅ | [audit.md](audit.md) |
| 角色权限 + 演示账号一键登录 | ✅ | ✅ | ✅ | [rbac.md](rbac.md) |
| 修复：销售代表客户商机数 | ✅ | ✅ | ✅ | [account-deal-count.md](account-deal-count.md) |
| 商机销售漏斗看板 | ✅ | ✅ | ✅ | [deal-board.md](deal-board.md) |
| 演示数据：虚构涡轮增压器企业 | ✅ | ✅ | ✅ | [demo-data.md](demo-data.md) |
| CI 失败产物上传 + 登录页文字 | ✅ | ✅ | ✅ | [ci-artifacts.md](ci-artifacts.md) |
| 批量操作 | ✅ | ✅ | ✅ | [bulk.md](bulk.md) |
| 数据导入导出（CSV） | ✅ | ✅ | ✅ | [import-export.md](import-export.md) |
| 备注 | ✅ | ✅ | ✅ | [notes.md](notes.md) |
| 产品目录与商机产品明细 | ✅ | ✅ | ✅ | [products.md](products.md) |
| 报价单 | ✅ | ✅ | ✅ | [quotes.md](quotes.md) |
| 报表与图表 | ✅ | ✅ | ✅ | [reports.md](reports.md) |
| 跟进日历视图 | ✅ | ✅ | ✅ | [calendar.md](calendar.md) |
| 标签 | ✅ | ✅ | ✅ | [tags.md](tags.md) |
| 回收站 | ✅ | ✅ | ✅ | [recycle.md](recycle.md) |
| 保存自定义视图 | ✅ | ✅ | ✅ | [views.md](views.md) |
| 附件 | ✅ | ✅ | ✅ | [attachments.md](attachments.md) |
| 备份与恢复 | ✅ | ✅ | ✅ | [backup.md](backup.md) |
| 已知问题修复（标签与视图、E2E 下拉选择） | ✅ | ✅ | ✅ | [cleanup.md](cleanup.md) |
| 英文界面（中英文切换） | ✅ | ✅ | ✅ | [i18n.md](i18n.md) |
| 销售目标与预测 | ✅ | ✅ | ✅ | [forecasts.md](forecasts.md) |
| 重复记录检测与合并 | ✅ | ✅ | ✅ | [duplicates.md](duplicates.md) |
| 站内通知与提醒 | ✅ | ✅ | ✅ | [notifications.md](notifications.md) |
| 销售订单 | ✅ | ✅ | ✅ | [sales-orders.md](sales-orders.md) |
| 发票 | ✅ | ✅ | ✅ | [invoices.md](invoices.md) |
| 应收账款报表 | ✅ | ✅ | ✅ | [receivables.md](receivables.md) |
| 应收账款导出 CSV | ✅ | ✅ | ✅ | [receivables-export.md](receivables-export.md) |
| 销售报表与预测导出 CSV | ✅ | ✅ | ✅ | [report-exports.md](report-exports.md) |
| 联系人列表 | ✅ | ✅ | ✅ | [contacts-list.md](contacts-list.md) |
| 个人设置与修改密码 | ✅ | ✅ | ✅ | [profile.md](profile.md) |
| 汇率与本币汇总 | ✅ | ✅ | ✅ | [exchange-rates.md](exchange-rates.md) |
| 市场活动 | ✅ | ✅ | ✅ | [campaigns.md](campaigns.md) |
| 商机竞争对手与联系人角色 | ✅ | ✅ | ✅ | [deal-competitors.md](deal-competitors.md) |
| 工作台自定义 | ✅ | ✅ | ✅ | [dashboard-layout.md](dashboard-layout.md) |
| 服务工单 | ✅ | ✅ | ✅ | [tickets.md](tickets.md) |
| 工作台待处理工单卡片 | ✅ | ✅ | ✅ | [dashboard-tickets.md](dashboard-tickets.md) |
| 工单评论往来 | ✅ | ✅ | ✅ | [ticket-comments.md](ticket-comments.md) |
| 工单导出 CSV | ✅ | ✅ | ✅ | [ticket-export.md](ticket-export.md) |
| 工单 SLA 超时升级 | ✅ | ✅ | ✅ | [ticket-sla.md](ticket-sla.md) |
| SLA 定时任务 | ✅ | ✅ | ✅ | [sla-scheduler.md](sla-scheduler.md) |
| 知识库 | ✅ | ✅ | ✅ | [kb.md](kb.md) |
| 导航结构（Zoho 分组） | ✅ | ✅ | ✅ | [navigation.md](navigation.md) |
| 侧栏折叠与咨询方式 | ✅ | ✅ | ✅ | [sidebar-contact.md](sidebar-contact.md) |
| 供应商与采购单 | ✅ | ✅ | ✅ | [purchase-orders.md](purchase-orders.md) |
| 价格表 | ✅ | ✅ | ✅ | [price-books.md](price-books.md) |
| 网页表单收集线索 | ✅ | ✅ | ✅ | [web-forms.md](web-forms.md) |
| 线索评分 | ✅ | ✅ | ✅ | [lead-scoring.md](lead-scoring.md) |
| 客户与联系人评分 | ✅ | ✅ | ✅ | [account-contact-scoring.md](account-contact-scoring.md) |
| 报表导出 Excel | ✅ | ✅ | ✅ | [report-excel.md](report-excel.md) |
| 列表导出 Excel | ✅ | ✅ | ✅ | [list-excel.md](list-excel.md) |
| 商机评分 | ✅ | ✅ | ✅ | [deal-scoring.md](deal-scoring.md) |
| 线索分配规则 | ✅ | ✅ | ✅ | [assignment-rules.md](assignment-rules.md) |
| 商机阶段历史 | ✅ | ✅ | ✅ | [stage-history.md](stage-history.md) |
| 工作流规则 | ✅ | ✅ | ✅ | [workflows.md](workflows.md) |

## 整体回归（全部模块完成后）
命令：`scripts/regression.sh final-mvp` → **PASS**（lint、typecheck、11 文件 181/181、静态导出、生产构建、E2E 6/6）。原始输出：[results/final-mvp-r3-regression.txt](results/final-mvp-r3-regression.txt)
GitHub Pages 实际访问：https://ai001001.github.io/Yonlink-CRM/ 跳转至登录页，显示“静态前端预览，尚未接入真实后端”，直接访问业务页同样跳转登录，控制台无错误。
