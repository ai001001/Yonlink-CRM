# 备份与恢复 — 三轮测试记录

日期：2026-11-13　环境：同 [leads.md](leads.md)　运维文档：[备份与恢复](../deploy/备份与恢复.md)
迁移：无（脚本 `scripts/backup-lib.ts`、`scripts/backup.ts`、`scripts/restore.ts`；systemd 模板 `deploy/systemd/yonlink-backup.{service,timer}`）

## 功能
- 应用级逻辑备份：一致性快照内逐表导出 gzip NDJSON；记录迁移清单；不备份会话；附件只复制被引用的文件（含回收站快照中的）；清单记录 SHA-256；目录 700、文件 600；锁文件防并发；失败清理；保留最近 N 份。
- 恢复：校验 SHA-256 与迁移一致后，在一个事务内（仅本事务 replica 模式）按列名写回并恢复序列；目标必须显式指定；非空目标需 `--replace`；任何检查失败都不改动目标。
- 命令行：`backup.ts`（环境变量配置）、`restore.ts`（`--verify-only` / `--target-url --attachments-dir [--replace]`）。
- 定时：每天北京时间 03:30 的 systemd 用户定时器。

## 第一轮：功能测试
命令：`npx vitest run tests/backup/backup.r1-functional.test.ts --reporter=verbose`
结果：**7/7 通过**（首次即通过；修正测试代码类型后重新执行，结果相同）。原始输出：[results/backup-r1-functional.txt](results/backup-r1-functional.txt)
覆盖：清单包含全部业务表（排除会话与迁移表）且行数与源库一致、迁移清单、权限 700/600；在用与回收站中的附件都备份且校验和正确；校验通过、不含会话；**恢复到全新目标库后每张表逐行与源库一致**、会话为空、附件文件一致且权限 600；金额、折扣、时间、JSON 快照、文本数组、枚举精度不变；恢复后追加型审计触发器仍生效；保留份数清理只处理完整且命名合规的目录。

## 第二轮：集成测试
命令：`npx vitest run tests/backup/backup.r2-integration.test.ts --reporter=verbose`
结果：**8/8 通过（首次即通过）**。原始输出：[results/backup-r2-integration.txt](results/backup-r2-integration.txt)
覆盖：磁盘缺失的附件列入清单且备份仍完成；数据文件被篡改时校验失败、恢复中止且目标库未改动；附件被篡改与清单缺失被发现；目标库迁移不一致时拒绝；非空目标不加 replace 拒绝、加 replace 后清空（含会话）并与备份一致；锁文件存在时第二个备份失败且不留目录；数据库不可用时失败并清理；命令行退出码（缺参数 2、仅校验 0、篡改 1、未指定恢复目标 2、正常备份 0）。

## 第三轮：回归测试
命令：`scripts/regression.sh backup`（后台运行，逐阶段汇报）
结果：**PASS（首次即通过）**——lint 14s、typecheck 7s、Vitest **668/668**（154s）、静态导出 70s、生产构建 54s、E2E **35/35**（331s）。原始输出：[results/backup-r3-regression.txt](results/backup-r3-regression.txt)

## 公网环境实测（2026-11-13，发布 9f64eed）
- 安装 `yonlink-backup.timer`：已启用，首次触发 2026-11-13 19:33 UTC（北京时间 03:33，含随机延迟）。
- 立即备份：`yonlink_mvp_demo` 21 张表、726 行、迁移 14 个、附件 11 个，用时 0.2s；`backups/` 与备份目录权限 700。
- `--verify-only` 校验通过。
- 恢复演练：新建临时库 `yonlink_restore_drill` → `prisma migrate deploy` → 恢复（21 张表、726 行、11 个附件）→ 与演示库逐表比较行数 **0 处差异** → 删除临时库与临时附件目录。

### 失败与修复
| 现象 | 原因 | 修复 |
|---|---|---|
| 类型检查报错 | 测试代码：解构可能为空的查询结果 | 改为显式取第一行；重新执行 R1 |
| 公网恢复演练第一次：逐表比较脚本未运行 | 操作失误：比较脚本放在项目外的临时目录，找不到 pg 依赖（恢复本身已成功并按清单核对行数） | 在发布目录内运行比较脚本，重新完整演练一次，0 处差异 |
