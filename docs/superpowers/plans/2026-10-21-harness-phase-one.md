# Personal Agent Harness Phase One Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 交付本地中文文字聊天工作台，以 Pi 执行任务并可靠保留原话、状态和成果。

**Architecture:** React 浏览器界面通过本地 HTTP 服务访问 SQLite。单并发执行器通过独立 Pi 适配器运行任务；模型请求受程序闸门控制，事件先写数据库再向界面展示。

**Tech Stack:** Node.js 24、TypeScript、React、Vite、SQLite（Node 内置 node:sqlite）、Vitest、Playwright；Pi SDK 的官方包和兼容版本在任务 3 核验并固定到 lockfile。

**Spec:** `docs/superpowers/specs/2026-10-21-harness-phase-one-design.md`

## Global Constraints

- 默认输入上限为 20,000 字符，单任务最长 120 秒，单任务最多 3 次模型请求，无自动重试。
- 一次最多执行一个 AI 任务。
- 只允许经过验证的订阅连接；没有认证或额度不足时保存并暂停，不切换付费 API。
- 先持久化事件，再通知界面。
- 用户消息与任务创建在同一事务完成；状态变化与对应事件也在同一事务完成。
- 启动时把遗留 running 任务置为 paused，记录 interrupted 原因，不自动重放可能产生副作用的操作。
- 不得请求或保存隐藏推理，不把 AI 建议标为用户决定。
- 不默认暴露任意 shell 或写文件工具。
- 当前云环境已经隔离，继续使用 `/workspace/-`；用户没有要求额外 worktree。
- 第一阶段不开发附件、语音、知识整理和 MCP；保留原方案的后续阶段。

## Review Focus

- 同一幂等 ID 被不同内容重用：返回冲突，不能静默丢失新内容（任务 1、4）。
- Pi 中断迟迟不结束：保持执行槽位，不能开始下一个模型任务（任务 2、3）。
- 数据库写入失败：停止推进任务并给出记录失败提示，不能显示完整成果（任务 1、2、4）。
- 本地服务遭跨域请求或异常 Host 访问：拒绝请求，不能把本机认证变成远程调用入口（任务 4）。
- 浏览器发送超时后重试、快速切换会话：不能重复创建任务或把旧请求的结果显示到新会话（任务 5）。

## 文件职责与公共类型

`src/shared/contracts.ts` 定义：

- `TaskStatus = 'queued' | 'running' | 'paused' | 'failed' | 'completed' | 'cancelled'`
- `Limits = { maxInputChars: number; maxRequests: number; timeoutMs: number }`
- `SubmitInput = { conversationId: string; clientId: string; text: string }`
- `Task = { id: string; conversationId: string; sourceMessageId: string; status: TaskStatus; reason: string | null; limits: Limits }`
- `Event = { seq: number; taskId: string | null; conversationId: string; type: string; payload: Record<string, unknown>; createdAt: string }`
- `Result = { text: string; scope: string; evidence: string[]; unfinished: string[]; externalSessionId: string | null }`
- `ConnectionStatus = { state: 'unconfigured' | 'unverified' | 'available' | 'paused'; reason: string | null; verifiedAt: string | null; remainingQuota: null }`

`src/server/store.ts` 管理持久化；`runner.ts` 管理状态和并发；`gate.ts` 管理预算；`pi-adapter.ts` 隔离 SDK；`http.ts` 管理 API；`main.ts` 管理进程生命周期。前端放在 `src/web/`，测试放在 `tests/`。

## Task 1: 可持久化的消息、任务与事件

**Files:** 创建 `package.json`、`package-lock.json`、`tsconfig.json`、`.gitignore`、`src/shared/contracts.ts`、`src/server/schema.sql`、`src/server/store.ts`、`tests/store.test.ts`。

**Interfaces:**
- `openStore(path: string): Store`
- `Store.createConversation(): { id: string }`
- `Store.submit(input: SubmitInput): Task`
- `Store.getTask(id: string): Task | null`
- `Store.transition(id: string, from: TaskStatus[], to: TaskStatus, reason?: string): Task`
- `Store.events(conversationId: string, after: number): Event[]`
- `Store.complete(id: string, result: Result): void`
- `Store.recoverInterrupted(): number`、`Store.close(): void`

- [x] 写 `tests/store.test.ts`：提交后恰有一个用户消息和 queued 任务；重复相同 clientId 返回同一个 task.id；不同正文重用返回冲突；事件 seq 严格递增；事务失败不留下半条记录；关闭重开仍能读取原文。
- [x] 建立仅供这些测试运行的 TypeScript/Vitest 配置，运行 `npx vitest run tests/store.test.ts`，确认因缺失实现失败。
- [x] 实现 SQLite 迁移、外键、事务和参数绑定。终态写入与助手消息、result、事件同一事务完成；非法状态变更拒绝。迁移保留已有数据，不能删除数据库重建。
- [x] 运行同一测试，确认全部通过，并以真实临时磁盘数据库验证重开与 interrupted 恢复。
- [x] 提交 `feat: persist conversations tasks and ordered events`。

## Task 2: 串行任务执行、用量闸门与取消

**Files:** 创建 `src/server/adapter.ts`、`src/server/gate.ts`、`src/server/runner.ts`、`tests/runner.test.ts`。

**Interfaces:**
- `Adapter.status(): Promise<ConnectionStatus>`
- `Adapter.run(task: Task, text: string, controls: { signal: AbortSignal; beforeRequest: () => void; emit: (type: string, payload: Record<string, unknown>) => void }): Promise<Result>`
- `createGate(limits: Limits, now: () => number): { beforeRequest(): void }`
- `createRunner(store: Store, adapter: Adapter): { wake(): void; cancel(id: string): Promise<void>; resume(id: string): void; stop(): Promise<void> }`

- [x] 写测试：并发峰值为 1；第 4 次 beforeRequest 抛出限制错误；20,001 字符被阻断；120,000 ms 超时触发 abort；缺认证及额度错误变 paused；未知错误变 failed。
- [x] 增加取消排队、取消执行、迟到输出、abort 不完成不释放槽位、记录写入失败停止执行、重启只暂停不重放测试。
- [x] 运行 `npx vitest run tests/runner.test.ts`，确认实现缺失导致失败。
- [x] 实现执行器和闸门，测试使用可控时钟和可控 Promise。仅有显式恢复可重排 paused；中断期间保留 running 并记录取消请求，确认退出后才标 cancelled。
- [x] 运行上述测试及 store 测试，确认通过。
- [x] 提交 `feat: enforce task lifecycle and execution limits`。

## Task 3: 真实 Pi 订阅适配器

**Files:** 创建 `src/server/pi-adapter.ts`、`src/server/readonly-tool.ts`、`tests/pi-adapter.test.ts`、`docs/pi-connection.md`；更新依赖和 lockfile。

**Interfaces:** 实现任务 2 的 Adapter；`createPiAdapter(config: { workspace: string; authDir: string }): Adapter`。只读工具 `readWorkspaceFile(relativePath: string): Promise<string>` 限制到配置的工作目录及剩余材料预算。

- [x] 阅读 Pi 官方发布、SDK 文档与包类型，记录包名、固定版本、ChatGPT 官方登录方式、逐请求 hook、中断及禁用重试方式到 `docs/pi-connection.md`。若 SDK 不支持逐请求闸门，采用设计允许的单次请求路径并关闭多步工具循环。
- [x] 写契约测试：只接受核验的订阅 provider；API key 路径不能启用；每次实际请求前调用 beforeRequest；abort 传播；排除隐藏推理和原始认证错误；错误归一化为认证、额度、超时或执行错误。
- [x] 写只读工具测试：拒绝绝对路径、`../`、指向工作目录外的符号链接和超预算文件；允许目录内受限读取。
- [x] 运行 `npx vitest run tests/pi-adapter.test.ts`，确认失败。
- [x] 使用核验过的 SDK 实现适配器；禁用默认高权限工具、后台压缩调用及隐式重试，或确保其模型请求都通过闸门。无法保证时不启用该能力。未知剩余额度保持 null；未验证账号不得返回 available。
- [x] 运行契约测试和类型检查，确认通过。真实登录仅使用官方流程，不读取或输出凭证内容。
- [x] 提交 `feat: integrate guarded Pi subscription adapter`。

## Task 4: 本地 HTTP 服务

**Files:** 创建 `src/server/http.ts`、`src/server/main.ts`、`src/server/config.ts`、`.env.example`、`tests/http.test.ts`。

**Interfaces:** `createServer(store: Store, runner: ReturnType<typeof createRunner>, adapter: Adapter): import('node:http').Server`。

API 使用 JSON，错误为 `{ error: { code, message } }`：

- `GET /api/connection`：ConnectionStatus。
- `GET/POST /api/conversations`：列出或创建会话。
- `GET /api/conversations/:id/messages`：持久消息。
- `POST /api/conversations/:id/messages`：正文 `{ clientId, text }`，返回 Task。
- `GET /api/conversations/:id/events?after=N`：最多 200 条递增事件。
- `GET /api/tasks/:id`：Task 与可用结果。
- `POST /api/tasks/:id/cancel`、`POST /api/tasks/:id/resume`：执行任务操作。

- [x] 写 HTTP 集成测试：无认证提交仍保存并最终 paused；幂等冲突为 409；非法正文为 400；超 128 KiB 请求为 413；未知资源为 404；数据库失败为明确 503；跨域 Origin 和异常 Host 被拒绝。
- [x] 运行 `npx vitest run tests/http.test.ts`，确认失败。
- [x] 实现 JSON 限制、ID 校验、分页、loopback 绑定、同源校验和静态构建资源托管。开发期 Vite 使用同源代理；数据库与工作目录从环境变量读取，示例不含凭证。
- [x] 启动时执行迁移及 interrupted 恢复；退出时停止接收新任务并等待中断，然后关闭数据库。确认单进程运行；第二个实例不得同时消费队列。
- [x] 运行 HTTP 测试与已有测试，确认通过。
- [x] 提交 `feat: expose local task and conversation API`。

## Task 5: 中文聊天与工作记录界面

**Files:** 创建 `index.html`、`vite.config.ts`、`src/web/main.tsx`、`src/web/App.tsx`、`src/web/api.ts`、`src/web/Chat.tsx`、`src/web/Timeline.tsx`、`src/web/styles.css`、`tests/ui.spec.ts`、`playwright.config.ts`。

**Interfaces:** `api.ts` 封装任务 4 的 API；React 组件仅接收公共 DTO，不导入 server 模块。

- [x] 写浏览器测试：输入并发送、暂停原因、取消、刷新恢复、工作记录顺序；失败保留草稿，成功清空；快速切换会话不串数据；发送超时重试沿用 clientId。
- [x] 运行 `npx playwright test`，确认因界面未实现失败。
- [x] 实现中文聊天和工作记录双视图、会话列表、连接状态及任务操作；每秒轮询活动任务，卸载或切换时取消请求；事件按 seq 去重。
- [x] 使用语义化按钮、标签、键盘提交和可读错误提示；明确显示未知额度，未实现的附件和语音不放可点击入口。
- [x] 运行浏览器测试，验证窄屏与桌面布局，确认关键操作可键盘完成。
- [x] 提交 `feat: add chat and work timeline interface`。

## Task 6: 完整验收与交付说明

**Files:** 更新 `README.md`、`package.json`、`docs/pi-connection.md`；创建 `docs/acceptance.md`。

- [x] 添加并验证 `npm run dev`、`npm run build`、`npm start`、`npm run typecheck`、`npm test`、`npm run test:e2e`；说明 Node 24、数据目录、启动关闭和官方认证流程。
- [x] 执行 `npm ci` 验证 lockfile 可复现，然后运行类型检查、全体单元/集成测试、生产构建及浏览器测试；记录实际测试数量与结果。
- [x] 启动生产服务，实际提交消息，验证无认证暂停、查询记录和取消；重启并核对数据库原文仍在，遗留运行任务不会自动重放。
- [x] 检查现有认证的名称和可用状态；有合法可用订阅时运行小型真实任务。没有账号条件时将真实连接标为未执行，并给出用户本地登录后的精确验收步骤，不以测试替身代替。
- [x] 自查所有设计条目、凭证排除、工具边界和异常路径，完成独立代码审查并处理发现的问题。
- [x] 更新 `docs/acceptance.md`，区分软件通过项、真实账号验证项与后续阶段；提交 `docs: document setup and phase one acceptance`。

## 计划自审

设计中的持久化、事件关联与恢复对应任务 1–2；认证与逐请求限制对应任务 3；本地访问边界对应任务 4；用户交互对应任务 5；可复现安装和真实验证对应任务 6。五项 Review Focus 均有归属测试。执行顺序依赖公共类型和接口，建议由当前会话顺序实现，完成后做独立审查。

执行记录：所有六项任务的软件实现与本地验收已完成；真实订阅账号验证因无用户 OAuth 未执行，详见 `docs/acceptance.md`。独立审查及其修复记录在交付前补充。
