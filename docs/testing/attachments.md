# 附件 — 三轮测试记录

日期：2026-11-13　环境：同 [leads.md](leads.md)　参考：Zoho CRM Attachments
迁移：`20261113142825_attachments`（attachments 表；恰好一个所属记录、大小 1 B–10 MB、SHA-256 十六进制、文件名非空的 CHECK；所属记录与上传人复合外键保证同组织，所属记录删除时级联）

## 设计
- 文件存放在本地磁盘附件目录 `<组织 ID>/<附件 ID>`，两段都必须是 UUID（不使用原文件名，杜绝路径注入），按组织隔离；目录 700、文件 600；先写临时文件再原子重命名。
- 附件目录由 `ATTACHMENTS_DIR` 配置：生产环境未配置时直接报错；开发默认 `.data/attachments`（已被 .gitignore 忽略）；Vitest 使用系统临时目录，E2E 使用 `.data/e2e-attachments`。
  公网环境为 `~/yonlink-deploy/shared/attachments`（发布目录之外，见 [公网部署](../deploy/公网部署.md)）。
- 权限：查看与下载需所属记录可见；上传需能编辑所属记录；删除为上传人（仍能编辑所属记录）或有删除权限的角色（管理员、经理）。
- 类型白名单：pdf、doc/docx、xls/xlsx、ppt/pptx、txt、csv、png、jpg/jpeg、gif、webp、zip；按文件头特征校验（扩展名与内容不符拒绝；文本不得含 NUL 字节）；不接受 HTML、SVG、脚本、可执行文件。
- 单个文件 ≤ 10 MB（按 Content-Length 提前拒绝过大的请求，不读入内存），每条记录 ≤ 50 个；文件名去除路径与控制字符、≤ 200 字（保留扩展名）。
- 下载：始终 `Content-Disposition: attachment`（含 UTF-8 文件名），内容类型取自白名单而非客户端，`X-Content-Type-Options: nosniff`、`Content-Security-Policy: default-src 'none'; sandbox`、`Cache-Control: no-store`；下载时校验 SHA-256，文件被篡改返回 500，文件丢失返回 404。
- 前端：商机、客户详情新增“附件”页签，线索详情新增“附件”区块；下载用带登录令牌的请求获取后保存（演示前端与后端不同域）。
- 回收站：删除记录时附件元数据进入快照，文件保留在磁盘；恢复后附件可下载；彻底删除、清空或过期时才删除文件。
- 审计：attachment.create / delete，只记录文件名、类型、大小与所属记录，不记录内容。
- 演示数据：11 个虚构的纯文本 / CSV 附件（4 个赢单商机的合同要点、4 个客户的产品价格表、3 条展会线索的名片记录）；重置时先删除演示组织旧的附件文件。
- 不做：在线预览、跟进/报价单附件、病毒扫描。

## 第一轮：功能测试
命令：`npx vitest run tests/attachments/attachments.r1-functional.test.ts --reporter=verbose`
结果：**9/9 通过**（修正一处断言后重新执行）。原始输出：[results/attachments-r1-functional.txt](results/attachments-r1-functional.txt)；首次失败输出：[results/attachments-r1-functional-first-run-failed.txt](results/attachments-r1-functional-first-run-failed.txt)
覆盖：上传写入元数据、磁盘文件与 SHA-256，审计不含内容；6 类允许类型按文件头识别（含大写扩展名）；HTML、SVG、EXE、无扩展名、伪装 PDF、伪装 PNG、含 NUL 的文本、空文件被拒；文件名清理（路径、控制字符、超长保留扩展名）；列表最新在前；下载原内容与安全响应头；删除同时删除文件并审计；10 MB 边界与超出 413、每条记录 50 个上限；删除商机后文件保留、恢复后可下载、彻底删除后文件移除；演示附件与磁盘文件 SHA-256 一致。

## 第二轮：集成测试
命令：`npx vitest run tests/attachments/attachments.r2-integration.test.ts --reporter=verbose`
结果：**13/13 通过**（修正测试代码类型后重新执行，结果相同）。原始输出：[results/attachments-r2-integration.txt](results/attachments-r2-integration.txt)
覆盖：上传权限（本人 201、他人 404、只读 403、经理 201）；查看与下载遵循可见范围；删除规则（上传人、不能删他人上传的、只读 403、经理可删）；改派后原负责人失去访问；跨组织隔离与按组织目录存储；非法所属记录（缺失、非 UUID、客户端提交组织 ID）；同时两个所属记录、缺少文件、非 multipart、Content-Length 过大；未登录 401；数据库约束；生产环境缺少附件目录报错、存储键必须为 UUID；文件被篡改 500、丢失 404。

## 第三轮：回归测试
命令：`scripts/regression.sh attachments`（后台运行，逐阶段汇报）
结果：**PASS（首次即通过）**——lint 16s、typecheck 8s、Vitest **653/653**（144s）、静态导出 55s、生产构建 48s（无警告）、E2E **35/35**（331s）。原始输出：[results/attachments-r3-regression.txt](results/attachments-r3-regression.txt)

### 失败与修复
| 现象 | 原因 | 修复 |
|---|---|---|
| R1：下载文件名断言失败 | 测试代码：期望值手误（“二”替换为 1 个下划线写成了 2 个） | 修正期望值 |
| 生产构建 4 条警告：动态文件路径导致整个项目被构建追踪 | 存储模块按运行时配置的目录读写文件，构建工具无法静态确定范围 | 按提示为这些调用加 `turbopackIgnore` 注释（附件目录是运行时配置，不应参与构建追踪），警告消除 |
| 开发阶段 E2E：只读用户下载演示附件无反应 | **测试环境配置**：全局准备写入演示附件时用默认目录，测试服务器读取 `.data/e2e-attachments`，文件不在同一目录 | 在 Playwright 配置中统一设置附件目录，全局准备与服务器共用 |
| 开发阶段 E2E：导航被遮挡超时 | 测试脚本：关闭详情抽屉后未等待关闭完成；线索详情上传后未关闭抽屉 | 关闭抽屉并等待隐藏后再导航 |
