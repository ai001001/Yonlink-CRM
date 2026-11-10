# Accounts 客户管理（含联系人、客户跟进记录）— 三轮测试记录

日期：2026-11-10　环境：同 [leads.md](leads.md)

## 第一轮：功能测试
命令：`npx vitest run tests/accounts --reporter=verbose`（当时仅含 R1 文件）
结果：**9/9 通过**。原始输出：[results/accounts-r1-functional.txt](results/accounts-r1-functional.txt)
覆盖：新增客户全部基本资料、详情含联系人、编辑与清空字段、删除（级联联系人与跟进）、按名称/电话/地址/联系人姓名搜索、行业筛选+分页、联系人增删改、主要联系人唯一且排序靠前、客户跟进记录新增与按客户查询。

## 第二轮：集成测试
命令：`npx vitest run tests/accounts/accounts.r2-integration.test.ts --reporter=verbose`
结果：**29/29 通过（首次即通过）**。原始输出：[results/accounts-r2-integration.txt](results/accounts-r2-integration.txt)
覆盖：有商机的客户删除返回 409 且数据保留、数据库 RESTRICT 外键兜底、`_count` 统计、联系人必须挂在已存在客户下、跟进记录引用不存在客户 400；客户/联系人非法输入与长度边界、禁止通过更新改挂联系人、非法查询参数；跨组织列表/搜索隔离、客户与联系人 IDOR 读/改/删 404 且数据不变、主要联系人设置不影响其他组织、不能为其他组织客户建跟进、复合外键阻止跨组织联系人。

## 第三轮：回归测试
命令：`scripts/regression.sh accounts`
结果：**PASS**。原始输出：[results/accounts-r3-regression.txt](results/accounts-r3-regression.txt)
| 步骤 | 结果 |
|---|---|
| lint / typecheck | exit 0 / exit 0 |
| 全量 Vitest（认证 + 线索 + 客户） | 5 文件 81/81 通过 |
| GitHub Pages 静态导出 / 生产构建 | exit 0 / exit 0 |
| Playwright E2E | 3/3 通过（新增：客户 → 联系人新增/编辑/主要联系人 → 跟进记录 → 按联系人搜索 → 编辑 → 刷新持久化 → 删除；线索流程回归） |

### 失败与修复
| 现象 | 原因 | 修复 |
|---|---|---|
| E2E：联系人弹窗中“姓名”输入框无法通过标签定位 | 同一页面多个 antd 表单都有 `name` 字段，生成重复 DOM id，`<label for="name">` 指向了客户表单 | 所有表单设置唯一 `name`（lead/account/contact/activity），字段 id 带前缀；重新构建后 E2E 通过 |

### 已知风险
- Prisma 7.10 `adapter-pg` 内部在同一事务连接上并发发出查询，触发 `pg` 弃用警告（pg@9 将报错）。当前 `pg` 锁定 `^8`，行为正确；升级 pg 9 前需确认 Prisma 已修复。

## 验收标准
- [x] 新增/编辑/删除/详情/搜索客户，客户基本资料
- [x] 联系人关联（增删改、主要联系人）
- [x] 客户跟进记录（新增、按客户查看）
- [x] 组织隔离（API + 复合外键）
- [x] 三轮测试全部通过
