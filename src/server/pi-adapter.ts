import { Agent, type StreamFn } from '@earendil-works/pi-agent-core';
import { FileCredentialStore } from './auth-store.js';
import {
  createModels,
  Type,
  type CredentialStore,
  type AssistantMessage,
  type Message,
} from '@earendil-works/pi-ai';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  DEFAULT_LIMITS,
  type ConnectionStatus,
  type Task,
  type Result,
} from '../shared/contracts.js';
import { ExecutionError, type Adapter, type Controls } from './adapter.js';
import { createGate } from './gate.js';
import { createWorkspaceReader } from './readonly-tool.js';

export function createSubscriptionModels(credentials: CredentialStore) {
  const models = createModels({ credentials });
  const provider = openaiProvider();
  // No API-key resolver exists in this collection, including for ambient OPENAI_API_KEY.
  models.setProvider({ ...provider, auth: { oauth: provider.auth.oauth } });
  return models;
}
type Config = { workspace: string; authDir: string; verificationPath: string; model?: string };
type Dependencies = { credentials?: CredentialStore; stream?: StreamFn };
type Verification = { provider: 'openai'; model: string; fingerprint: string; verifiedAt: string };
export interface PiAdapter extends Adapter {
  verify(): Promise<Result>;
}
function normalize(error: unknown): ExecutionError {
  if (error instanceof ExecutionError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (/429|quota|usage.limit|rate.limit/i.test(message)) return new ExecutionError('quota');
  if (/401|403|unauthoriz|oauth|credential|authentication|expired.token/i.test(message))
    return new ExecutionError('auth_required');
  return new ExecutionError('execution_failed');
}
export function createPiAdapter(config: Config, dependencies: Dependencies = {}): PiAdapter {
  const credentials =
    dependencies.credentials ?? new FileCredentialStore(join(config.authDir, 'auth.json'));
  const models = createSubscriptionModels(credentials),
    modelId = config.model ?? 'gpt-5.5';
  const model = models.getModel('openai', modelId);
  async function fingerprint(): Promise<string | null> {
    const c = await credentials.read('openai');
    if (c?.type !== 'oauth') return null;
    return createHash('sha256').update(c.refresh).digest('hex');
  }
  async function status(): Promise<ConnectionStatus> {
    try {
      const fp = await fingerprint();
      if (!fp)
        return {
          state: 'unconfigured',
          reason: 'auth_required',
          verifiedAt: null,
          remainingQuota: null,
        };
      let marker: Verification | null = null;
      try {
        marker = JSON.parse(await readFile(config.verificationPath, 'utf8'));
      } catch {}
      const valid =
        model &&
        marker?.provider === 'openai' &&
        marker.model === modelId &&
        marker.fingerprint === fp &&
        Number.isFinite(Date.parse(marker.verifiedAt));
      return {
        state: valid ? 'available' : 'unverified',
        reason: valid ? null : 'unverified',
        verifiedAt: valid ? marker!.verifiedAt : null,
        remainingQuota: null,
      };
    } catch {
      return { state: 'paused', reason: 'auth_required', verifiedAt: null, remainingQuota: null };
    }
  }
  async function saveVerification(verifiedAt = new Date().toISOString()) {
    const fp = await fingerprint();
    if (!fp) throw new ExecutionError('auth_required');
    const marker: Verification = {
      provider: 'openai',
      model: modelId,
      fingerprint: fp,
      verifiedAt,
    };
    await mkdir(dirname(config.verificationPath), { recursive: true, mode: 0o700 });
    const temp = `${config.verificationPath}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(marker), { mode: 0o600 });
    await rename(temp, config.verificationPath);
  }
  async function execute(
    task: Task,
    text: string,
    controls: Controls,
    probe = false,
  ): Promise<Result> {
    const initialStatus = await status();
    if (!(await fingerprint())) throw new ExecutionError('auth_required');
    if (!probe && initialStatus.state !== 'available') throw new ExecutionError('unverified');
    if (!model) throw new ExecutionError('execution_failed');
    if (text.length > task.limits.maxInputChars) throw new ExecutionError('input_limit');
    const read = createWorkspaceReader(
      config.workspace,
      Math.max(0, task.limits.maxInputChars - text.length),
    );
    let failure: unknown;
    const history: Message[] = (controls.history ?? []).map((m) =>
      m.role === 'user'
        ? { role: 'user', content: m.text, timestamp: Date.parse(m.createdAt) }
        : {
            role: 'assistant',
            content: [{ type: 'text', text: m.text }],
            timestamp: Date.parse(m.createdAt),
            provider: 'openai',
            api: 'openai-responses',
            model: modelId,
            stopReason: 'stop',
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
          },
    );
    const agent = new Agent({
      initialState: {
        model,
        thinkingLevel: 'off',
        messages: history,
        systemPrompt:
          '你是个人工作台的助手。用中文完成任务。记录可见结论与证据，不输出隐藏推理。只读取用户明确指定的工作目录内文本文件；说明实际读取范围，不能声称做过未执行的验证。',
        tools: probe
          ? []
          : [
              {
                name: 'read_workspace_file',
                label: '读取工作目录文件',
                description: '读取用户明确指定的工作目录内 UTF-8 文本；禁止隐藏路径和目录外文件。',
                parameters: Type.Object({ path: Type.String() }),
                async execute(_id, params, signal) {
                  const { path } = params as { path: string };
                  if (signal?.aborted) throw new ExecutionError('cancelled');
                  const content = await read(path);
                  controls.emit('tool.read', { path, characters: content.length });
                  return { content: [{ type: 'text', text: content }], details: { path } };
                },
              },
            ],
      },
      toolExecution: 'sequential',
      transport: 'sse',
      async prepareRequest(request) {
        try {
          if (controls.signal.aborted) throw new ExecutionError('cancelled');
          if (!(await fingerprint())) throw new ExecutionError('auth_required');
          const material = request.context.messages.reduce(
            (count, m) =>
              count +
              ('content' in m
                ? typeof m.content === 'string'
                  ? m.content.length
                  : Array.isArray(m.content)
                    ? m.content.reduce(
                        (n: number, c: unknown) =>
                          n +
                          (typeof c === 'object' && c && 'text' in c && typeof c.text === 'string'
                            ? c.text.length
                            : 0),
                        0,
                      )
                    : 0
                : 0),
            0,
          );
          if (material > task.limits.maxInputChars) throw new ExecutionError('input_limit');
          controls.beforeRequest();
          controls.emit('model.request', { provider: 'openai', model: modelId });
        } catch (error) {
          failure = error;
          throw error;
        }
      },
      streamFn: (m, context, options) => {
        const safe = {
          ...options,
          maxRetries: 0,
          transport: 'sse' as const,
          maxTokens: 4096,
          timeoutMs: task.limits.timeoutMs,
        };
        return dependencies.stream
          ? dependencies.stream(m, context, safe)
          : models.streamSimple(m, context, safe);
      },
    });
    const abort = () => agent.abort();
    controls.signal.addEventListener('abort', abort, { once: true });
    try {
      if (controls.signal.aborted) throw new ExecutionError('cancelled');
      agent.subscribe((event) => {
        if (event.type === 'message_end' && event.message.role === 'assistant') {
          const m = event.message as AssistantMessage;
          if (m.stopReason === 'error') {
            failure = normalize(new Error(m.errorMessage ?? ''));
            return;
          }
          if (m.stopReason === 'aborted') return;
          controls.emit('model.usage', {
            input: m.usage.input,
            output: m.usage.output,
            cacheRead: m.usage.cacheRead,
            cacheWrite: m.usage.cacheWrite,
          });
          // No thinking events, request headers, raw errors or response metadata are copied.
          const visible = m.content
            .filter((c) => c.type === 'text')
            .map((c) => c.text)
            .join('');
          if (visible) controls.emit('visible.progress', { text: visible });
        }
      });
      await agent.prompt(text);
      if (failure) throw failure;
      if (controls.signal.aborted) throw new ExecutionError('cancelled');
      const last = agent.state.messages
        .filter((m): m is AssistantMessage => m.role === 'assistant')
        .at(-1);
      if (!last || last.stopReason === 'error' || last.stopReason === 'aborted')
        throw normalize(new Error(last?.errorMessage ?? 'execution_failed'));
      if (last.stopReason === 'length') throw new ExecutionError('output_limit');
      const answer = last.content
        .filter((c) => c.type === 'text')
        .map((c) => c.text)
        .join('');
      if (!answer) throw new ExecutionError('execution_failed');
      if (probe) await saveVerification();
      else await saveVerification(initialStatus.verifiedAt!);
      return {
        text: answer,
        scope: '本次对话中纳入预算的文字和已记录的工作目录读取；未检查其他文件或视频。',
        evidence: [],
        unfinished: [],
        externalSessionId: null,
      };
    } catch (error) {
      throw normalize(failure ?? error);
    } finally {
      controls.signal.removeEventListener('abort', abort);
      agent.abort();
      await agent.waitForIdle();
    }
  }
  return {
    status,
    run: (task, text, ctl) => execute(task, text, ctl),
    async verify() {
      const controller = new AbortController(),
        limits = { ...DEFAULT_LIMITS, maxRequests: 1 };
      const gate = createGate(limits);
      const timer = setTimeout(() => controller.abort(), limits.timeoutMs);
      try {
        return await execute(
          {
            id: randomUUID(),
            conversationId: 'verification',
            sourceMessageId: 'verification',
            status: 'running',
            reason: null,
            limits,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
          '请仅回复：连接成功。',
          { signal: controller.signal, beforeRequest: gate.beforeRequest, emit() {} },
          true,
        );
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
