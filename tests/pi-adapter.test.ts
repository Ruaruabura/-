import { afterEach, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryCredentialStore, type Credential } from '@earendil-works/pi-ai';
async function memory(data: Record<string, Credential>) {
  const store = new InMemoryCredentialStore();
  for (const [k, v] of Object.entries(data)) await store.modify(k, async () => v);
  return store;
}
import { AssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import type { AssistantMessage, SimpleStreamOptions } from '@earendil-works/pi-ai';
import { createPiAdapter, createSubscriptionModels } from '../src/server/pi-adapter.js';
import { createWorkspaceReader } from '../src/server/readonly-tool.js';
import { DEFAULT_LIMITS, type Task } from '../src/shared/contracts.js';
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
function config() {
  const dir = mkdtempSync(join(tmpdir(), 'pi-test-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'work'));
  return {
    workspace: join(dir, 'work'),
    authDir: join(dir, 'auth'),
    verificationPath: join(dir, 'verified.json'),
    model: 'gpt-5.5',
  };
}
const oauth = () =>
  memory({
    openai: {
      type: 'oauth',
      access: 'test-only',
      refresh: 'test-only',
      expires: Date.now() + 3600000,
    },
  });
const task: Task = {
  id: 'task',
  conversationId: 'c',
  sourceMessageId: 'm',
  status: 'running',
  reason: null,
  limits: DEFAULT_LIMITS,
  createdAt: '',
  updatedAt: '',
};
function message(text = '真实接口形状的测试响应'): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'openai-responses',
    provider: 'openai',
    model: 'gpt-5.5',
    stopReason: 'stop',
    timestamp: Date.now(),
    usage: {
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 15,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}
function stream(msg = message()) {
  const s = new AssistantMessageEventStream();
  queueMicrotask(() => {
    s.push({ type: 'done', reason: 'stop', message: msg });
    s.end(msg);
  });
  return s;
}
const controls = () => ({ signal: new AbortController().signal, beforeRequest() {}, emit() {} });
test('provider supports subscription OAuth only, never API key fallback', async () => {
  const credentials = await memory({ openai: { type: 'api_key', key: 'test-only' } });
  const models = createSubscriptionModels(credentials);
  expect(models.getProvider('openai')?.auth.apiKey).toBeUndefined();
  expect(models.getProvider('openai')?.auth.oauth?.isSubscription).toBe(true);
  const a = createPiAdapter(config(), { credentials });
  expect((await a.status()).state).toBe('unconfigured');
  await expect(a.run(task, 'hi', controls())).rejects.toThrow('auth_required');
});
test('OAuth alone stays unverified; successful bounded probe unlocks account and model', async () => {
  const cfg = config(),
    credentials = await oauth();
  let calls = 0;
  let options: SimpleStreamOptions | undefined;
  const a = createPiAdapter(cfg, {
    credentials,
    stream: (_m, _c, o) => {
      calls++;
      options = o;
      return stream();
    },
  });
  expect((await a.status()).state).toBe('unverified');
  await expect(a.run(task, 'hi', controls())).rejects.toThrow('unverified');
  await a.verify();
  expect((await a.status()).state).toBe('available');
  expect(calls).toBe(1);
  expect(options?.maxRetries).toBe(0);
  expect(options?.transport).toBe('sse');
  const b = createPiAdapter({ ...cfg, model: 'gpt-6-luna' }, { credentials });
  expect((await b.status()).state).toBe('unverified');
});
test('request gate runs before transport and hidden reasoning is not emitted', async () => {
  const credentials = await oauth();
  const events: string[] = [];
  let calls = 0;
  const msg = message();
  msg.content.unshift({ type: 'thinking', thinking: 'PRIVATE_REASONING' });
  const a = createPiAdapter(config(), {
    credentials,
    stream: () => {
      calls++;
      return stream(msg);
    },
  });
  await a.verify();
  const c = controls();
  c.beforeRequest = () => {
    throw new Error('gate_closed');
  };
  await expect(a.run(task, 'hello', c)).rejects.toThrow();
  expect(calls).toBe(1);
  const r = await a.run(task, 'hello', {
    ...controls(),
    emit: (t, p) => events.push(t + JSON.stringify(p)),
  });
  expect(r.text).not.toContain('PRIVATE_REASONING');
  expect(events.join('')).not.toContain('PRIVATE_REASONING');
});
test('normalizes provider quota and auth errors without leaking raw detail', async () => {
  const cfg = config(),
    credentials = await oauth();
  let error = '';
  const a = createPiAdapter(cfg, {
    credentials,
    stream: () => {
      const m = message();
      if (error) {
        m.stopReason = 'error';
        m.errorMessage = error;
        const s = new AssistantMessageEventStream();
        queueMicrotask(() => {
          s.push({ type: 'error', reason: 'error', error: m });
          s.end(m);
        });
        return s;
      }
      return stream();
    },
  });
  await a.verify();
  error = '429 usage_limit_reached PRIVATE_TOKEN';
  await expect(a.run(task, 'hi', controls())).rejects.toThrow('quota');
  error = '401 unauthorized PRIVATE_TOKEN';
  await expect(a.run(task, 'hi', controls())).rejects.toThrow('auth_required');
});
test('aborts actual Pi Agent stream and waits for it to settle', async () => {
  let probe = true;
  let aborted = false;
  const a = createPiAdapter(config(), {
    credentials: await oauth(),
    stream: (_m, _c, o) => {
      if (probe) return stream();
      const s = new AssistantMessageEventStream();
      o?.signal?.addEventListener('abort', () => {
        aborted = true;
        const m = { ...message(), stopReason: 'aborted' as const };
        s.push({ type: 'error', reason: 'aborted', error: m });
        s.end(m);
      });
      return s;
    },
  });
  await a.verify();
  probe = false;
  const controller = new AbortController();
  const running = a.run(task, 'hi', { ...controls(), signal: controller.signal });
  await new Promise((r) => setTimeout(r, 20));
  controller.abort();
  await expect(running).rejects.toThrow('cancelled');
  expect(aborted).toBe(true);
});
test('workspace read enforces traversal, symlink, credential and aggregate material boundaries', async () => {
  const cfg = config();
  writeFileSync(join(cfg.workspace, 'ok.txt'), 'hello');
  writeFileSync(join(cfg.workspace, '.env'), 'SECRET');
  writeFileSync(join(cfg.workspace, 'large.txt'), 'a'.repeat(30000));
  symlinkSync('/etc/passwd', join(cfg.workspace, 'escape'));
  const read = createWorkspaceReader(cfg.workspace, 8);
  expect(await read('ok.txt')).toBe('hello');
  await expect(read('ok.txt')).rejects.toThrow('input_limit');
  for (const p of ['../outside', '/etc/passwd', 'escape', '.env', 'large.txt'])
    await expect(createWorkspaceReader(cfg.workspace, 20000)(p)).rejects.toThrow();
});

// Transport integration: the real official Models/OpenAI HTTP adapter receives a 429.
// Only fetch is intercepted; no outbound request or real credential is used.
test('official HTTP transport does not retry a subscription quota response', async () => {
  const cfg = config(),
    credentials = await oauth();
  let calls = 0;
  vi.stubGlobal('fetch', async () => {
    calls++;
    return new Response(
      JSON.stringify({
        error: {
          message: 'usage_limit_reached',
          code: 'rate_limit_exceeded',
          type: 'rate_limit_error',
        },
      }),
      { status: 429, headers: { 'content-type': 'application/json' } },
    );
  });
  try {
    const adapter = createPiAdapter(cfg, { credentials });
    await expect(adapter.verify()).rejects.toThrow('quota');
    expect(calls).toBe(1);
    expect((await adapter.status()).state).toBe('unverified');
  } finally {
    vi.unstubAllGlobals();
  }
});

test('symlink aliases cannot expose hidden files or hidden directories', async () => {
  const cfg = config();
  writeFileSync(join(cfg.workspace, '.env'), 'TEST_SECRET');
  mkdirSync(join(cfg.workspace, '.credentials'));
  writeFileSync(join(cfg.workspace, '.credentials', 'data.txt'), 'TEST_SECRET');
  symlinkSync(join(cfg.workspace, '.env'), join(cfg.workspace, 'public.txt'));
  symlinkSync(join(cfg.workspace, '.credentials'), join(cfg.workspace, 'public-dir'));
  const read = createWorkspaceReader(cfg.workspace, 20000);
  await expect(read('public.txt')).rejects.toThrow('path_denied');
  await expect(read('public-dir/data.txt')).rejects.toThrow('path_denied');
});
test('token-truncated output is retained as visible progress but pauses without automatic retry', async () => {
  let truncated = false,
    calls = 0;
  const events: string[] = [];
  const adapter = createPiAdapter(config(), {
    credentials: await oauth(),
    stream: () => {
      calls++;
      const msg = message('部分回答');
      if (truncated) msg.stopReason = 'length';
      return stream(msg);
    },
  });
  await adapter.verify();
  truncated = true;
  await expect(
    adapter.run(task, 'hi', {
      ...controls(),
      emit: (type, payload) => events.push(type + JSON.stringify(payload)),
    }),
  ).rejects.toThrow('output_limit');
  expect(calls).toBe(2);
  expect(events.join('')).toContain('部分回答');
});
