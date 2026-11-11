# 演示数据：虚构涡轮增压器企业 — 三轮测试记录

日期：2026-11-11　环境：同 [leads.md](leads.md)

## 内容
- 参考公开的涡轮增压器售后市场行业信息（整机增压器、中间体/CHRA、核心部件、配件、维修工具；AAPEX / SEMA / 上海法兰克福汽配展），由负责人选择**同行业虚构公司与客户**：不使用真实企业名称，不把真实企业写成客户。
- 演示组织：“演示涡轮增压器有限公司（演示数据）”；5 个演示账号与角色不变。
- 数据量：30 客户（北美/欧洲/东南亚/中东/南美/非洲/国内的分销商、再制造厂、车队与维修连锁）、64 联系人、48 线索、48 商机（6 个阶段各 8 个，USD/EUR/CNY）、172 跟进（已完成、待办、已逾期）。
- 王芳负责北美/欧洲，陈静负责东南亚/中东/南美/非洲，郑经理负责国内重点客户，便于演示角色可见范围。
- 所有名称带【演示】；网站与邮箱使用保留域名 `.example`，电话使用 555 号段；日期以当天为基准，演示数据不会“过期”。
- 数据定义 `prisma/demo-data.ts`（纯数据、确定性生成）；写入 `prisma/seed-demo.ts`；`--reset` 只清空并重建演示组织的业务数据（账号与只追加的审计日志保留，旧演示组织改名复用）。
- E2E 用例从数据文件读取样本名称，并在断言前先搜索（数据增多后列表分页）。

## 第一轮：功能测试
命令：`npx vitest run tests/demo/demo-data.r1-functional.test.ts --reporter=verbose`
结果：**9/9 通过**。原始输出：[results/demo-data-r1-functional.txt](results/demo-data-r1-functional.txt)
覆盖：写入数量与数据集一致且数量充足；5 个演示账号角色；所有名称带【演示】；6 阶段/3 币种/3 负责人；进行中商机预计成交在未来、已结束在过去；每个客户恰 1 位主要联系人；跟进含已完成/待办/逾期且关联正确；线索来源与状态分布；生成确定性。

## 第二轮：集成测试
命令：`npx vitest run tests/demo/demo-data.r2-integration.test.ts --reporter=verbose`
结果：**8/8 通过（首次即通过）**。原始输出：[results/demo-data-r2-integration.txt](results/demo-data-r2-integration.txt)
覆盖：不带 --reset 重复执行不重复写入；--reset 重建（数量不变、记录为新、账号保留）；旧演示组织改名复用且账号与审计保留；重建不影响其他组织；各角色可见数量符合负责人分配；看板各列合计与数据集金额按币种精确一致；销售代表工作台有待办与逾期；只使用保留域名且不含真实企业名称。

## 第三轮：回归测试
命令：`scripts/regression.sh demo-data`（后台运行，逐阶段汇报）
结果：**PASS**。原始输出：[results/demo-data-r3-regression.txt](results/demo-data-r3-regression.txt)
| 步骤 | 结果 |
|---|---|
| lint / typecheck | exit 0（10s）/ exit 0（6s） |
| 全量 Vitest | 23 文件 333/333 通过（61s） |
| 静态导出 / 生产构建 | exit 0（48s）/ exit 0（50s） |
| Playwright E2E（使用新演示数据） | 12/12 通过（151s） |

本次三轮均首次通过。开发中自行修正：商机名称中的客户简称原为截取前 4 个字（如“北湖商用”），改为每个客户的明确简称。
