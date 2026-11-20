# Webhook 与 API 密钥 — 三轮测试记录

日期：2026-11-20　环境：同 [leads.md](leads.md)　参考：Zoho CRM Webhooks、REST API 访问

迁移 `20261126090000_integrations`：
- `api_keys`（名称、前缀、SHA-256 哈希唯一、绑定用户、创建人、到期、吊销、最近使用）；约束：名称非空白、哈希为 64 位十六进制、前缀以 `ylk_` 开头。
- `webhooks`（名称组织内唯一不分大小写、地址必须 http(s)、签名密钥至少 32 位、启用）。
- `webhook_deliveries`（投递队列：事件、负载、状态 PENDING/SUCCEEDED/FAILED、尝试次数、下次尝试、最近状态码与错误、送达时间；尝试次数非负）。
- 应用迁移后，`prisma migrate diff` 与数据库对比为空迁移，没有漂移。
- 开发过程中，第一次生成迁移时脚本断言失败、生成了只含约束的迁移文件，在本地开发库与测试库执行失败（未提交、未部署）；已用 `prisma migrate resolve --rolled-back` 标记回滚，修正后重新生成。

## 功能
- **API 密钥**（设置 › 集成，`integration.manage`：仅管理员，且必须是浏览器会话）：
  - 新建时选择“以该用户身份”与可选到期日；原文只显示一次（`ylk_` + 43 位），数据库只存 SHA-256 哈希与前缀。
  - 外部系统在 `Authorization: Bearer <密钥>` 中使用，以绑定用户的身份与当前角色访问全部业务接口（可见范围、权限、审计都按该用户）。
  - 吊销、到期、用户停用后立即 401；最近使用时间每分钟最多更新一次。
  - 用 API 密钥不能管理密钥与 Webhook、不能修改密码、不能退出其他设备（防止泄露的密钥自我延续）。
  - 审计只记录名称、前缀、绑定用户、到期，从不记录密钥。
- **Webhook**：
  - 新建时生成签名密钥（`whsec_…`，只在新建与重新生成时显示）；可编辑名称、地址、启停，可测试（发送 ping 并立即返回结果）、重新生成密钥、删除（投递一并删除）。
  - 工作流新增动作“调用 Webhook”：在触发写入的同一事务内写入投递队列（事务回滚则不入队），Webhook 已停用或已删除时跳过并在审计中注明。
  - 负载：`{ id: 投递 ID, event, occurredAt, data: { rule, entity, trigger, record } }`；记录只含 ID、名称与业务状态字段（线索：状态、来源、公司、职位、负责人、市场活动、评分；商机：阶段、金额、币种、预计成交日、负责人、客户、市场活动、评分），不含邮箱、电话。
  - 请求头：`X-Yonlink-Event`、`X-Yonlink-Delivery`（重试时不变，供接收方去重）、`X-Yonlink-Timestamp`（秒）、`X-Yonlink-Signature: v1=HMAC-SHA256(签名密钥, "时间戳.请求体")`。
  - 投递：2xx 成功；否则按 1、5、30、120、360 分钟退避，第 6 次仍失败标记失败，可手动重试（重置次数）。领取使用 `FOR UPDATE SKIP LOCKED` 与 5 分钟租约，多个进程并发不会重复发送。产生投递约 2 秒后应用会在后台发送；定时器 `yonlink-webhook.timer` 每分钟负责重试与补发（见 [定时任务](../deploy/定时任务.md)）。
  - 安全：只允许 https（测试环境可用 `WEBHOOK_ALLOW_HTTP=1`）；地址不能含账号密码；保存时拒绝 localhost 与内网 IP；发送时对 IP 字面量和 DNS 解析结果都检查，拒绝回环、内网、链路本地、组播等地址（测试环境可用 `WEBHOOK_ALLOW_PRIVATE=1`）；不跟随重定向；10 秒超时。
  - 权限：维护需 `integration.manage`（管理员）；经理有 `workflow.manage`，可查看 Webhook 列表以便选择工作流动作。
- **演示数据**：1 个已停用的演示 Webhook，地址为保留域名 `example.com`，不会发送到真实系统；不预置 API 密钥（原文只能显示一次）。
- **不做**：OAuth 授权、按接口限定密钥的权限范围、调用频率限制、Webhook 订阅任意事件（目前通过工作流触发）。

## 第一轮：功能测试
命令：`npx vitest run tests/integrations/integrations.r1-functional.test.ts`
结果：**5/5 通过（修复缺陷后通过，首次失败见下表）**。原始输出：[results/integrations-r1-functional.txt](results/integrations-r1-functional.txt)

覆盖：
- API 密钥：格式、只返回一次、哈希不含原文、列表不含密钥；以销售身份只看到自己的线索；新建记录的负责人与审计操作人为绑定用户；最近使用时间；吊销后 401、再吊销 409；到期、用户停用、伪造密钥 401；审计动作与不含密钥。
- 密钥限制：用密钥查看/新建密钥、新建 Webhook 被拒（`session_required` / 403），改密码 403，业务接口正常；5 类非法输入 400；经理新建 403、销售查看 403；他组织吊销 404。
- Webhook：新建返回签名密钥、列表不含密钥、同名 409；经理可查看不能新建、销售不能查看；关闭测试放行后 7 类非法地址（http、localhost、10.x、[::1]、含账号密码、ftp、非网址）；公网 https 可保存。
- 投递：工作流动作引用不存在的 Webhook 400；新建线索入队，负载字段正确且不含邮箱电话；发送后请求头的投递 ID、事件、签名可用密钥验证，请求体等于负载；成功后不再领取；500 时退避间隔依次为 1、5、30、120、360 分钟，第 6 次为最终失败，投递 ID 始终不变；手动重试后成功、重复重试 409；按状态筛选投递记录。
- 测试事件 ping；关闭内网放行后对 127.0.0.1 的测试被拒（`private_address`），接收端没有收到请求；重新生成密钥后签名随新密钥变化；停用后工作流跳过、已入队的投递标记 `webhook_inactive`；审计不含签名密钥；删除后投递一并删除。

## 第二轮：集成测试
命令：`npx vitest run tests/integrations tests/auth tests/profile tests/workflows tests/leads tests/deals tests/audit tests/rbac tests/i18n tests/web-forms`
结果：**25 个文件 281/281 通过（本功能 5 项首次即通过）**。原始输出：[results/integrations-r2-integration.txt](results/integrations-r2-integration.txt)

覆盖：
- 3 个处理进程并发处理 20 条投递：共领取 20 条，接收端收到 20 次且投递 ID 互不重复，全部成功。
- 绕过保存校验把地址改为 `localhost` 域名：发送时解析为回环地址被拒，接收端没有收到请求；302 重定向视为失败且不跟随；业务事务回滚时投递不保留。
- 组织隔离：B 看不到 A 的 Webhook，测试、投递记录、重试均 404；B 的密钥看不到 A 的数据；只读用户的密钥可读、写 403。
- 数据库约束：非 http(s) 地址、过短的签名密钥、错误的前缀与哈希、负的尝试次数均被拒绝；审计日志按 apikey、webhook 筛选。
- 演示数据：只有 1 个演示 Webhook，已停用、指向 example.com，没有投递与密钥。
- 认证、个人设置、工作流、线索、商机、审计、权限、多语言、网页表单相关测试全部通过。

## 第三轮：回归测试
命令：`scripts/regression.sh integrations`（后台运行）
结果：**通过（首次即通过）**：lint、类型检查、123 个文件 1135 项单元/集成测试、Pages 构建、生产构建、111 项 E2E 全部通过。原始输出：[results/integrations-r3-regression.txt](results/integrations-r3-regression.txt)

新增 E2E `e2e/integrations.spec.ts`（1 项）：管理员在设置 › 集成新建 API 密钥，原文只在弹窗中显示一次；列表显示“有效”与前缀；用该密钥调用 `/api/leads` 返回 200，吊销后返回 401；新建指向 example.com 的 Webhook（不点测试，不发请求），签名密钥只显示一次；停用开关生效；投递记录为空。

**对已有测试的调整（行为变化，非放宽）**：导航 E2E 中系统管理员的菜单在“工作流规则”后增加“集成”。

### 失败与修复
| 现象 | 原因 | 修复 |
|---|---|---|
| R1 首次 1 项失败（[首次输出](results/integrations-r1-first-run-failed.txt)）：关闭内网放行后，对 127.0.0.1 的测试仍然发送成功 | **真实缺陷（SSRF 防护漏洞）**：地址是 IP 字面量时 Node 不做 DNS 解析，自定义的 `lookup` 不会被调用，连接时的内网检查被绕过 | 发送前对 IP 字面量单独检查；R2 另外覆盖域名解析到内网的情况；5/5 通过 |

## 线上检查

2026-11-20 部署 `1524964`（迁移已应用，`migrate status` 显示最新），重置演示数据后：
- 服务器安装 `yonlink-webhook.timer`（每分钟），手动运行一次日志为“领取 0，成功 0，待重试 0，失败 0；用时 158ms”。
- 以管理员在 Pages 站点检查线上接口：
  - 为只读用户周会计新建 API 密钥（前缀 `ylk_fcAJSCri`）：读线索 200、新建线索 403、用密钥查看密钥列表 403；吊销后再读 401。
  - 生产环境（未开启测试放行）新建 Webhook：`https://10.0.0.1/x` 被拒（`private_address`），`http://example.com/x` 被拒（`https_required`）。
  - Webhook 列表只有演示 Webhook（已停用、指向 example.com），返回内容不含签名密钥。
- 检查后重置演示数据，清除检查用的密钥。
