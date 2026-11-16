# SLA 定时任务（服务器每 5 分钟检查超时工单）— 三轮测试记录

日期：2026-11-16　环境：同 [leads.md](leads.md)　依赖：[工单 SLA 超时升级](ticket-sla.md)　运维说明：[定时任务](../deploy/定时任务.md)
迁移：无

## 功能
- **新增全量检查**：服务端新增 `sweepAllEscalations`，检查全部已启用 SLA 的组织（未配置或已停用的组织跳过）。
  - 每个组织单独一个事务；一个组织出错不影响其他组织，出错信息汇总返回。
- **命令行脚本** `scripts/sla-sweep.ts`：
  - 执行一次全量检查，输出一行统计（组织数、升级数、出错数、用时）。
  - 有组织出错时退出码为 1；缺少 `DATABASE_URL` 时提示并以退出码 2 结束。
- **systemd 用户定时器**：`yonlink-sla.service`（一次性任务，依赖数据库服务，超时 2 分钟）和 `yonlink-sla.timer`（每 5 分钟）。写法与备份定时器一致，不需要 sudo。
- **保留按需检查**：页面上顺带触发的检查仍然保留，作为两次定时检查之间的补充。条件更新保证两者同时运行也只升级、只通知一次。
- **效果**：超时工单最晚约 5 分钟内升级，不再依赖有人在线。
- **不做**：按工作日和工作时间计算、在界面上显示“上次检查时间”、告警外发（邮件、短信）。

## 第一轮：功能测试
命令：`npx vitest run tests/sla-scheduler/sla-scheduler.r1-functional.test.ts`
结果：**3/3 通过（第二次运行通过，首次失败见下表）**。原始输出：[results/sla-scheduler-r1-functional.txt](results/sla-scheduler-r1-functional.txt)

覆盖：
- 全量检查：4 个组织（2 个启用、1 个停用、1 个未配置）只处理启用的，共升级 3 张；重复运行升级 0 张；通知 3 条。
- 命令行脚本对真实测试库运行：输出统计，实际升级 2 张，写入 2 条系统审计；再次运行升级 0 张；缺少 `DATABASE_URL` 时退出码 2 并给出提示。
- systemd 单元：运行仓库中实际存在的脚本；一次性任务；依赖数据库服务；读取 `app.env`；有超时设置；每 5 分钟触发；挂在 `timers.target` 上。

## 第二轮：集成测试
命令：`npx vitest run tests/sla-scheduler/sla-scheduler.r2-integration.test.ts`
结果：**3/3 通过（首次即通过）**。原始输出：[results/sla-scheduler-r2-integration.txt](results/sla-scheduler-r2-integration.txt)

覆盖：
- 2 个定时检查、1 个单组织检查、2 次未读数刷新、1 次工单列表读取同时进行：3 张超时工单各只升级一次；负责人和接收人各收到 3 条通知；审计 3 条。
- 一个组织出错（注入故障）：其他组织照常升级，失败信息正确报告；下一次运行把出错组织补上。
- 按传入的时刻判断超时（3 小时后只有 2 小时到期的那张超时）；未超时、无期限、已解决的工单不受影响；停用 SLA 后即使更晚也不处理。

## 第三轮：回归测试
命令：`scripts/regression.sh sla-scheduler`（后台运行）
结果：**PASS（首次即通过）**——lint 21s、typecheck 8s、Vitest **971/971**（316s）、静态导出 112s、生产构建 83s、E2E **72/72**（693s）。原始输出：[results/sla-scheduler-r3-regression.txt](results/sla-scheduler-r3-regression.txt)

部署后在演示服务器上的实际验证：（待填写）

### 失败与修复
| 现象 | 原因 | 修复 |
|---|---|---|
| R1 首次 1 项失败（[首次输出](results/sla-scheduler-r1-functional-first-run-failed.txt)）：缺少 `DATABASE_URL` 时退出码为 1，而不是预期的 2 | **脚本缺陷**：ES 模块的静态 `import` 会先于脚本中的环境变量检查执行，数据库模块加载时就因为缺少连接串而报错，提示信息不会输出 | 先检查环境变量，再动态 `import` 数据库与 SLA 模块；重新运行 3/3 通过 |
