# Zoho CRM 核心模块快速研究（MVP 用）

> 时间盒：半天以内。只查阅 Zoho 官方帮助文档，目标是理解模块关系与业务流程，不复制其文案、商标或界面素材。

## 参考来源（官方）
- Working With Leads：https://help.zoho.com/portal/en/kb/crm/sales-force-automation/leads/articles/leads-26-4-2026
- FAQs: Leads Management：https://help.zoho.com/portal/en/kb/crm/faqs/sales-force-automation/lead-management/articles/faqs-on-leads-management
- Convert Lead API v8：https://www.zoho.com/crm/developer/docs/api/v8/convert-lead.html
- Working with Deals：https://help.zoho.com/portal/en/kb/crm/sales-force-automation/deal-management/articles/deals-overview
- Creating Deals：https://help.zoho.com/portal/en/kb/crm/sales-force-automation/deal-management/articles/create-deals

## 模块与关系（结论）
| 模块 | 含义 | 关键关系 |
|---|---|---|
| Leads 线索 | 尚未确认的潜在客户（个人 + 公司名） | 可“转化”为 客户 + 联系人 +（可选）商机；转化后不可撤销 |
| Accounts 客户 | 有业务往来的公司/组织 | 1 客户 : N 联系人；1 客户 : N 商机 |
| Contacts 联系人 | 客户中的具体对接人 | 属于一个客户 |
| Deals 商机 | 能带来收入的销售机会 | 属于一个客户；有金额、阶段、预计成交日期、负责人 |
| Activities 活动 | 任务、会议（Events）、电话（Calls） | 关联到线索/客户/联系人/商机；区分未完成与已完成 |
| Home 工作台 | 个人/团队概览 | 汇总待办、商机金额、最近活动 |

## 业务流程（MVP 采纳）
1. 市场/销售录入线索（来源、状态、联系方式、负责人）。
2. 跟进线索（电话、会议、拜访），线索状态推进：新线索 → 已联系 → 已确认 / 无效。
3. 确认后建立客户（及联系人），在客户下建立商机。
4. 商机按阶段推进：资格确认 → 需求分析 → 方案报价 → 商务谈判 → 赢单 / 输单；记录金额与预计成交日期。
5. 所有跟进记录与任务挂在线索/客户/商机上，工作台汇总客户数、线索数、商机数与金额、最近跟进、待办任务。

## MVP 取舍
- 采纳：上述 5 个模块的基本 CRUD、搜索、分页、关联与工作台统计。
- 联系人作为客户的子数据实现，不单独做联系人模块。
- 线索一键转化（Lead Conversion）是 Zoho 核心流程，但不在本次 MVP 必选清单内，列为下一版本首选功能。
- 不做：多 Pipeline、Blueprint、Workflow、自定义字段/模块、评分、邮件集成、高级报表。
