# 个人 Agent Harness

一个以 **Pi 为执行核心**的本地个人 AI 工作台。中文聊天界面提交文字任务，工作记录保留原话、状态变化、可见输出与成果，原始消息不会被 AI 的解释覆盖。

**当前交付：第一阶段。** 已实现文字聊天、持久任务队列、订阅连接闸门、取消/恢复、工作时间线。附件与语音、知识笔记、Grok Bot MCP 属于后续三个阶段，尚未实现。真实 ChatGPT 订阅仍需在你自己的电脑上登录并完成验证。

## 启动

需要 Node.js **24 或更高版本**、npm，以及可用的本机端口。无需 Docker 或外部数据库。

```bash
npm ci
npm run build
npm start
```

用浏览器访问本机 **4317 端口**（地址栏输入 `http://127.0.0.1:4317`）。服务仅监听回环地址，不提供远程公开入口。开发模式使用 `npm run dev`，同一端口支持界面热更新。

即使没有模型账号，也可以发送和保存消息、查看记录、取消任务。未连接的任务会保存为暂停状态，不会返回模拟的 AI 答案。

## 连接自己的 ChatGPT 订阅

先停止工作台（Ctrl+C）。登录和验证会锁定同一数据目录，避免与后台任务同时调用模型。

```bash
npm run login
npm run account:status
# 在账号设置中确认订阅权益、额外用量/自动充值设置后：
npm run verify:pi -- --confirm-subscription
npm start
```

`login` 使用 **Pi 官方 SDK 的 Sign in with ChatGPT OAuth**，在终端提示你完成浏览器授权。不要在聊天中提交密码或令牌。登录凭证只保存在本机认证目录。

`verify:pi` 只尝试一次小型文字请求，最长 120 秒。只有实际成功返回结果后，该账号与模型才显示为“订阅已验证”。它不会代表你检查平台收费设置，也不会证明所有模型都有权益。验证请求的开始、通过或错误类别会写入独立的连接检查记录。

工作台只注册 OAuth 认证路径，**不会读取 API Key 作为付费备用路径**。默认模型为 `gpt-5.5`；可以在 `.env` 中设置 Pi 官方目录支持且账号有权益的 `PI_MODEL`。更换账号或模型后需重新验证。没有权限、额度不足或超限时任务暂停，用户点击“恢复任务”后才重新排队。

连接错误说明：

| 状态/错误 | 处理 |
| --- | --- |
| `auth_required` / `unconfigured` | 运行 `npm run login`；旧登录可能已失效 |
| `unverified` | 停止服务后运行验证命令 |
| `quota` | 检查订阅额度，稍后手动恢复；不会切换其他付费渠道 |
| `execution_failed` | 检查模型权益和网络连接；无自动重试 |
| `instance_running` | 先停止使用同一数据目录的服务或账号命令 |
| `unsafe_workspace` | 让可读工作目录与凭证/数据库目录分开 |

当前云环境没有用户的 OAuth 凭证，因此**真实账号登录、权益与费用路径尚未实测**。自动化测试的传输替身仅存在于测试目录。

## 使用方式

- **聊天**：输入文字，点击发送或按 Ctrl/⌘+Enter。草稿在当前浏览器本地保存；发送失败保留草稿并可重试。
- **任务状态**：区分排队、执行、暂停、失败、完成和取消。运行中的任务会先请求中断，执行器实际退出后才释放槽位。
- **工作记录**：按递增序号查看原话、模型请求、可见输出、文件读取、状态变化和成果。助手的建议不会自动标为你已采纳。
- **文件只读工具**：将允许读取的 UTF-8 文本放到 `.data/workspace/`，在消息中明确指定相对路径。不能读取目录外、隐藏路径、二进制或超预算文件；没有 shell 或写文件工具。
- **中断恢复**：重启后原来正在执行的任务变为暂停，不会盲目重复执行；已有排队任务继续排队。

默认最多一次执行一个 AI 任务；输入与纳入模型的上下文上限 20,000 字符，单任务最多 3 次请求、120 秒，无自动重试。预算覆盖对话上下文和读取的文本，长对话可能需要开启新会话。返回的 token 用量按实际记录，剩余会员额度显示“未知”。

## 配置与本地数据

可复制 `.env.example` 为 `.env`。不需要设置 API Key。

| 配置 | 默认值 | 用途 |
| --- | --- | --- |
| `PORT` | `4317` | 本机 HTTP 端口 |
| `HARNESS_DATA_DIR` | `.data` | 数据库、验证元数据、连接检查记录 |
| `HARNESS_WORKSPACE` | `.data/workspace` | 唯一允许模型读取的文本目录 |
| `PI_AUTH_DIR` | `.data/auth` | 认证文件目录 |
| `PI_MODEL` | `gpt-5.5` | OpenAI 订阅模型；不自动降级 |

数据目录已被 Git 忽略。`.data/harness.db` 保存消息、任务、事件和结果；`.data/auth/auth.json` 保存凭证，**不要分享该文件**。`.data/subscription-verification.json` 仅保存模型、认证指纹与验证时间。`.data/connection-checks.jsonl` 保存连接验证的非敏感状态。

本地保存不是备份。第一阶段可以在**停止工作台后**复制数据目录做离线备份；包含 auth 的副本必须私密保管。应用内导出、恢复和删除联动将在第三阶段提供。不要在服务运行时直接复制单个 SQLite 主文件，因为 WAL 中可能还有未归并的记录。

## 开发与验证

```bash
npm test                  # 数据库、队列、Pi 契约、本地 HTTP 等测试
npm run typecheck
npm run build
npm run test:e2e           # Chromium 浏览器验收
npm run format:check
```

浏览器测试需要 Chromium：有 `/usr/bin/chromium` 时会自动使用，否则运行 `npx playwright install chromium`，或设置 `CHROMIUM_PATH` 指向已有浏览器。测试使用隔离临时数据库，生产入口不提供模拟模式。

- `src/server/store.ts`：事务、数据库与事件。
- `src/server/runner.ts` / `gate.ts`：串行执行、取消与限制。
- `src/server/pi-adapter.ts`：官方 Pi Agent、OAuth-only provider、请求闸门。
- `src/server/http.ts`：同源本地 API 与静态资源。
- `src/web/`：聊天、会话和工作时间线。

[原始完整方案](docs/superpowers/specs/2026-10-21-personal-agent-harness-proposal.md) · [第一阶段设计](docs/superpowers/specs/2026-10-21-harness-phase-one-design.md) · [实施计划](docs/superpowers/plans/2026-10-21-harness-phase-one.md) · [Pi 接入说明](docs/pi-connection.md)

第二阶段已加入分块附件上传、PDF 范围提取、图像 OCR，以及本地语音转写界面。用法、依赖和当前限制见 [本地材料说明](docs/local-materials.md)。语音模型尚未安装成功时，界面会禁用录音，不会转用云服务。
