# 永联CRM（Yonlink-CRM）开发启动说明

本项目指定开发环境与路径：
- 云服务器：Oracle Cloud ARM Ubuntu 26.04
- Linux 登录用户：`ai`
- 项目目录：`/home/ai/Desktop/CRM/Yonlink-CRM/`
- 中文产品名称：永联CRM
- 英文标记：Yonlink-CRM
- 技术项目标识：`yonlink-crm`

## 一、开发包内容
- `CLAUDE.md`：Claude Code 长期开发规范。
- `docs/00-产品命名规范.md`：产品名称与技术标识规范。
- `docs/01-PRD.md`：产品需求文档。
- `docs/02-数据库ER设计.md`：数据库实体关系与关键数据设计。
- `docs/03-系统架构.md`：系统架构和技术选型。
- `docs/04-第一阶段开发任务书.md`：基础工程阶段任务与验收要求。
- `docs/10-development-plan.md`：整体开发路线图。

## 二、在 Ubuntu 服务器准备目录

请使用 `ai` 用户登录服务器。先执行：

```bash
whoami
uname -m
lsb_release -a
```

预期用户为 `ai`，ARM64 架构通常显示 `aarch64`。然后创建项目父目录：

```bash
mkdir -p /home/ai/Desktop/CRM
```

## 三、把 ZIP 上传到 Oracle Cloud Ubuntu

### 方法 A：使用 MobaXterm（推荐）
1. 在当前 ChatGPT 对话下载 `Yonlink-CRM_Enterprise_Blueprint_v1.3.zip` 到 Windows 电脑。
2. 使用 MobaXterm SSH 登录 Oracle Cloud Ubuntu，用户为 `ai`。
3. 在左侧 SFTP 文件浏览器进入 `/home/ai/Desktop/CRM/`。
4. 将 ZIP 文件拖进去，上传完成后回到 SSH 终端。

### 方法 B：使用 Windows scp
如果 Windows 能通过 SSH 连接服务器，在 PowerShell 中执行（请把服务器公网 IP 替换成自己的 IP，并确认私钥路径）：

```powershell
scp -i "C:\你的私钥路径\服务器私钥.key" "$env:USERPROFILE\Downloads\Yonlink-CRM_Enterprise_Blueprint_v1.3.zip" ai@你的服务器公网IP:/home/ai/Desktop/CRM/
```

不要把私钥上传到服务器，也不要把私钥内容发给他人。

## 四、解压到指定项目目录

在 Ubuntu SSH 终端执行：

```bash
cd /home/ai/Desktop/CRM
unzip -o Yonlink-CRM_Enterprise_Blueprint_v1.3.zip
```

压缩包内部顶层目录是 `Yonlink-CRM`，所以解压后项目目录应为：

```text
/home/ai/Desktop/CRM/Yonlink-CRM/
```

检查目录和关键文件：

```bash
ls -la /home/ai/Desktop/CRM/Yonlink-CRM
test -f /home/ai/Desktop/CRM/Yonlink-CRM/CLAUDE.md && echo "CLAUDE.md OK"
test -d /home/ai/Desktop/CRM/Yonlink-CRM/docs && echo "docs OK"
```

如果系统提示 `unzip: command not found`，执行：

```bash
sudo apt update
sudo apt install -y unzip
```

然后重新执行解压命令。

如果之前已经存在同名项目目录，不要直接覆盖你已有的代码。先备份旧目录，再解压；例如：

```bash
cd /home/ai/Desktop/CRM
mv Yonlink-CRM "Yonlink-CRM.backup.$(date +%Y%m%d-%H%M%S)"
unzip Yonlink-CRM_Enterprise_Blueprint_v1.3.zip
```

只有确认旧目录无需保留时才这样操作。

## 五、检查 Claude Code 是否可用

切换到项目目录：

```bash
cd /home/ai/Desktop/CRM/Yonlink-CRM
claude --version
```

如果能显示版本号，说明命令已安装并可调用。然后启动：

```bash
claude
```

如果提示 `claude: command not found`，先不要在项目目录里乱装依赖。检查 Node.js 和 npm：

```bash
node -v
npm -v
which claude
```

如果 Claude Code 尚未安装，请按 Anthropic 官方当前安装说明安装，并完成账号登录。不要使用来源不明的安装脚本或第三方二进制包。安装后重新运行 `claude --version`。

## 六、首次发送给 Claude Code 的指令

启动 Claude Code 后，在交互界面中完整粘贴以下内容：

```text
你现在是 Yonlink-CRM（永联CRM）项目的首席架构师和技术负责人。

当前开发环境：
- Oracle Cloud ARM Ubuntu 26.04
- Linux 用户：ai
- 项目根目录：/home/ai/Desktop/CRM/Yonlink-CRM/
- 中文产品名称：永联CRM
- 英文产品标记：Yonlink-CRM
- 技术项目标识：yonlink-crm

请先完整阅读当前项目目录中的 CLAUDE.md，以及 docs 文件夹内的全部 Markdown 文档，尤其是产品命名规范、PRD、数据库 ER 设计、系统架构、第一阶段开发任务书和开发路线图。

项目目标：开发企业级 CRM 系统，以 Zoho CRM Enterprise 的公开功能作为对标基准，构建拥有自主代码和独立品牌的 Yonlink-CRM。不得复制 Zoho 的源代码、商标、专有文案或受保护素材。

第一阶段请严格执行：
1. 检查当前开发环境、技术栈、ARM64 兼容性和项目目录。
2. 阅读并理解产品需求、数据库设计、系统架构和开发路线图。
3. 检查文档之间是否存在技术冲突、设计遗漏或不合理之处。
4. 制定详细开发任务清单，明确每个任务的文件、实现内容、依赖关系和验收标准。
5. 优先规划工程骨架、数据库、用户认证、企业租户、组织架构、角色权限和审计日志。
6. 特别重视多租户数据隔离，确保不同企业之间的数据绝对不能互相访问；必须设计并测试 API、前端和篡改记录 ID 等场景。
7. 所有产品名称统一使用：永联CRM / Yonlink-CRM；技术项目标识使用 yonlink-crm。
8. 不得擅自删减产品需求，不得直接开始开发全部 CRM 业务模块。
9. 未经我确认，不得执行破坏性操作、删除文件、覆盖现有项目或部署到公网。
10. 如发现蓝图存在问题，先列出问题、影响、建议方案和需要我决定的事项，不要自行作重大架构变更。
11. 技术依赖和 Docker 镜像必须确认支持 Oracle Cloud ARM64 / linux/arm64；不支持时先提出替代方案，不得静默换技术栈。

本轮只完成项目分析、技术方案复核、风险清单和第一阶段任务拆分。请给出建议的目录结构、开发顺序、测试策略、预计交付物和验收标准，然后暂停，等待我确认后再开始编码。
```

## 七、开发阶段顺序

1. 工程骨架、数据库、登录、租户、组织和权限。
2. 客户、联系人、线索管理。
3. 商机、销售流程、报价和合同。
4. 产品、价格表和订单。
5. 邮件、电话、日历和任务。
6. 工作流、自动化和审批。
7. 报表、仪表盘和销售预测。
8. 自定义模块、字段、布局和 API。
9. AI 助手与智能自动化。
10. 安全、性能、备份恢复和私有化部署验收。

每个阶段均执行“需求确认 → 设计 → 编码 → 自动化测试 → 人工验收 → 更新进度”，通过后再进入下一阶段。

## 八、首次分析完成后

把 Claude Code 输出的以下内容发回 ChatGPT：
- 技术方案复核结果和发现的冲突。
- 第一阶段详细任务清单。
- 数据库迁移方案。
- 多租户隔离方案与测试用例。
- ARM64 兼容性检查结果。
- 开发目录结构。
- 需要你确认的决策和风险。

先审核，再批准编码。不要让 Claude Code 在未审核前一次性生成全部系统。
