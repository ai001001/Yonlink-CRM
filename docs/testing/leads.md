# Leads 线索管理 — 三轮测试记录

日期：2026-11-10　环境：Oracle Cloud ARM64 / Ubuntu 26.04 / Node 26.13 / PostgreSQL 18.6（embedded）/ Chromium 154

## 第一轮：功能测试
命令：`npx vitest run tests/leads/leads.r1-functional.test.ts tests/auth --reporter=verbose`
结果：**16/16 通过**（线索 9 + 认证 7）。原始输出：[results/leads-r1-functional.txt](results/leads-r1-functional.txt)
覆盖：全字段新增与持久化、只填姓名、详情、部分更新/清空字段/改状态、改派与取消负责人、删除、多字段不区分大小写搜索、状态/来源筛选、分页与排序；登录/注销/过期/停用/限流/用户枚举防护。

## 第二轮：集成测试
命令：`npx vitest run tests/leads/leads.r2-integration.test.ts --reporter=verbose`
结果：**首次 25/26（1 失败）→ 修复后 27/27 通过**。原始输出：[results/leads-r2-integration.txt](results/leads-r2-integration.txt)
覆盖：8 类非法输入、非 JSON、长度边界与去空白、字段级错误、非法分页参数、越界页、SQL/LIKE 特殊字符、非法 ID、删除级联跟进记录；未登录 401、列表隔离、跨组织 IDOR 读/改/删均 404 且数据不变、跨组织负责人拒绝、请求体注入 organizationId/id 被拒绝、数据库复合外键阻止跨组织引用。

### 失败与修复
| 现象 | 原因 | 修复 |
|---|---|---|
| 搜索 `%` 或 `_` 返回全部线索（`expected 1 to be +0`） | Prisma `contains` 不转义 LIKE 通配符 | 新增 `containsText()`（`src/server/validation.ts`）转义 `\ % _`；新增回归用例“包含 % 的名字仍可搜索” |

## 第三轮：回归测试
命令：`scripts/regression.sh leads`
结果：**PASS**。原始输出：[results/leads-r3-regression.txt](results/leads-r3-regression.txt)
| 步骤 | 结果 |
|---|---|
| lint (eslint) | exit 0 |
| typecheck (tsc strict) | exit 0 |
| 全量 Vitest | 3 文件 43/43 通过 |
| GitHub Pages 静态导出构建 | exit 0 |
| 生产构建 | exit 0 |
| Playwright E2E（生产构建 + 测试库） | 2/2 通过：登录 → 新增 → 必填校验 → 搜索 → 详情 → 编辑 → 刷新持久化 → 删除；未登录跳转登录 |

### E2E 过程中发现并修复的缺陷
| 现象 | 原因 | 修复 |
|---|---|---|
| 表格中姓名/编辑/删除不可通过键盘或读屏访问 | 使用了无 href 的 `<a onClick>` | 改为 `Button type="link"` |
| 从详情抽屉点“编辑”，编辑弹窗被抽屉遮罩挡住无法操作 | 弹窗 `forceRender` 先挂载，层级低于抽屉 | 弹窗 `zIndex=1100` |
（其余 E2E 调整为选择器问题：antd 在两个汉字按钮中插入空格、antd 6 类名变化。）

## 验收标准
- [x] 新增/编辑/删除/详情/搜索/分页/负责人/来源/联系方式/状态
- [x] 数据来自 PostgreSQL，刷新后保持
- [x] 组织隔离（API + 数据库外键）
- [x] 三轮测试全部通过
