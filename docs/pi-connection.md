# Pi 订阅连接

核验版本：`@earendil-works/pi-agent-core`、`pi-ai`、`pi-coding-agent` 均为 **1.3.0**（npm 官方包；上游仓库 https://github.com/earendil-works/pi）。旧 `@mariozechner/*` 已废弃，项目使用新的 `@earendil-works/*`。

本工作台使用 Pi Agent 核心，而不直接启动完整 coding-agent 会话：这样不会自动发现扩展、启用 shell、压缩上下文或产生后台模型请求。`Agent.prepareRequest` 在每次请求前执行预算闸门；`streamSimple` 明确设置 `maxRetries: 0`、`transport: 'sse'`、`maxTokens: 4096`。只注册 OpenAI 的 `oauth` 认证方法，删除 API-key resolver；环境中的 API Key 不能成为备用路径。

当前 Pi 的 OpenAI provider 原生提供 **Sign in with ChatGPT**。支持资格、模型权益和费用以账号实际状态为准。默认模型 `gpt-5.5`，可通过 `PI_MODEL` 指定官方目录里的其他 OpenAI 模型；更换模型或登录账户需要重新验证。

SDK 1.3.0 不再公开导出 AuthStorage。工作台实现 SDK 公共 `CredentialStore` 接口，以 Pi 兼容的 auth.json 保存登录信息，使用文件锁及原子替换。OAuth 登录、刷新和请求头生成均由官方 SDK 完成。认证文件默认独立于可读工作目录，不进入数据库、界面、日志或 Git。

接入步骤见 README。验证命令先检查已有 OAuth，再做最多一次、最长 120 秒的小型任务。只有收到成功响应才写入按账号指纹和模型关联的验证记录。凭证和模型发生变化时不继承旧验证。指纹不含原始令牌。剩余额度始终显示未知；实际 token 数仅取服务返回值。

自动化测试运行真实 Pi Agent 及 SDK 事件协议，传输层使用测试替身；它们不等于用户订阅实测。真实账号尚未授权时，不会自动尝试付费 API，也不会显示“已连接”。
