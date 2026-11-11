# CI 失败产物上传与登录页说明文字 — 三轮测试记录

日期：2026-11-11　环境：同 [leads.md](leads.md)

## 背景
- 商机看板提交 `41c7203` 的 CI 中，E2E“商机完整业务流程”偶发失败（保存后弹窗遮罩仍覆盖页面导致点击超时）；同一用例本地 3 次、后续 CI 均通过，原因未能确认，因为 CI 不保留失败现场。
- 登录页说明仍写“演示企业”，与新演示组织名称不一致。

## 变更
- `.github/workflows/ci.yml`：E2E 失败时（`if: failure()`）上传 `test-results/`（截图、操作轨迹 trace.zip、页面快照 error-context.md），保留 14 天。
- `playwright.config.ts`：失败时保留截图（`screenshot: 'only-on-failure'`；trace 原已为 retain-on-failure）。
- `src/i18n/zh-CN.ts`：登录页说明改为“演示环境：演示账号属于独立的演示组织，所有客户与业务数据均为虚构的演示数据，可随意操作。”

## 第一轮：功能测试（失败产物生成）
方法：临时添加一个故意失败的 E2E 用例并执行，检查 `test-results/`，随后删除该用例（未提交）。
结果：**PASS**——生成 `test-failed-1.png`、`trace.zip`、`error-context.md`。记录：[results/ci-artifacts-r1-functional.txt](results/ci-artifacts-r1-functional.txt)；CI 配置经 YAML 解析校验，上传步骤为最后一步且仅在失败时执行。

## 第二轮：集成测试（界面文字与通过时无产物）
命令：`npx playwright test e2e/rbac.spec.ts`（新增断言：登录页显示新说明文字、不再出现“演示企业”）
结果：**2/2 通过**；通过时 `test-results/` 中无失败产物（0 个）。记录：[results/ci-artifacts-r2-integration.txt](results/ci-artifacts-r2-integration.txt)

## 第三轮：回归测试
命令：`scripts/regression.sh ci-artifacts`（后台运行，逐阶段汇报）
结果：**PASS**——lint 11s、typecheck 7s、Vitest 333/333（60s）、静态导出 38s、生产构建 50s、E2E 12/12（156s）。原始输出：[results/ci-artifacts-r3-regression.txt](results/ci-artifacts-r3-regression.txt)

## 后续
若 E2E 在 CI 再次偶发失败，到 Actions 运行页面下载 `playwright-test-results` 产物，用 `npx playwright show-trace trace.zip` 查看失败现场后再修复根因。
