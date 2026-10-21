import { afterEach, expect, test, vi } from 'vitest';
import { request, type Server } from 'node:http';
import { openStore, type Store } from '../src/server/store.js';
import type { Adapter } from '../src/server/adapter.js';
import { createRunner, type Runner } from '../src/server/runner.js';
import { createServer } from '../src/server/http.js';
import { acquireInstanceLock } from '../src/server/instance-lock.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
let store: Store, runner: Runner, server: Server, url: string;
async function setup(provided?: Adapter) {
  store = openStore(':memory:');
  const adapter = provided ?? {
    status: async () => ({
      state: 'unconfigured' as const,
      reason: 'auth_required',
      verifiedAt: null,
      remainingQuota: null,
    }),
    run: async () => {
      throw Error('must not call');
    },
  };
  runner = createRunner(store, adapter);
  server = createServer(store, runner, adapter);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
afterEach(async () => {
  if (runner) await runner.stop();
  if (server)
    await new Promise<void>((r) => {
      server.close(() => r());
      server.closeAllConnections();
    });
  store?.close();
});
async function post(path: string, body: unknown) {
  return fetch(url + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}
test('no-auth workflow preserves original text, pauses, and cancels', async () => {
  await setup();
  const c = await (await post('/api/conversations', {})).json();
  const response = await post(`/api/conversations/${c.id}/messages`, {
    clientId: 'a',
    text: '原话',
  });
  expect(response.status).toBe(201);
  const t = await response.json();
  await vi.waitFor(() => expect(store.getTask(t.id)?.status).toBe('paused'));
  expect(await (await fetch(`${url}/api/conversations/${c.id}/messages`)).json()).toMatchObject([
    { text: '原话' },
  ]);
  const events = await (await fetch(`${url}/api/conversations/${c.id}/events?after=0`)).json();
  expect(events.at(-1).type).toBe('task.paused');
  expect((await post(`/api/tasks/${t.id}/cancel`, {})).status).toBe(202);
  expect(store.getTask(t.id)?.status).toBe('cancelled');
  expect((await fetch(`${url}/api/connection`)).status).toBe(200);
});
test('rejects conflicting retries, invalid input, missing resources and oversized body', async () => {
  await setup();
  const c = store.createConversation();
  await post(`/api/conversations/${c.id}/messages`, { clientId: 'a', text: 'one' });
  expect(
    (await post(`/api/conversations/${c.id}/messages`, { clientId: 'a', text: 'two' })).status,
  ).toBe(409);
  expect((await post(`/api/conversations/${c.id}/messages`, { text: 'hi' })).status).toBe(400);
  expect(
    (await post(`/api/conversations/${c.id}/messages`, { clientId: 'b', text: ' ' })).status,
  ).toBe(400);
  expect(
    (await post(`/api/conversations/${c.id}/messages`, { clientId: 'b', text: 'a'.repeat(150000) }))
      .status,
  ).toBe(413);
  expect((await fetch(`${url}/api/tasks/missing`)).status).toBe(404);
  expect((await fetch(`${url}/api/conversations/${c.id}/events?after=-1`)).status).toBe(400);
});
test('rejects cross-site requests, bad hosts and non-JSON mutations', async () => {
  await setup();
  expect(
    (
      await fetch(url + '/api/conversations', {
        method: 'POST',
        headers: { origin: 'https://evil.test', 'content-type': 'application/json' },
        body: '{}',
      })
    ).status,
  ).toBe(403);
  const badHost = await new Promise<number | undefined>((resolve) => {
    request(url + '/api/connection', { headers: { Host: 'evil.test' } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    }).end();
  });
  expect(badHost).toBe(403);
  expect(
    (
      await fetch(url + '/api/conversations', {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: '{}',
      })
    ).status,
  ).toBe(415);
});
test('database errors are visible but do not expose internal details', async () => {
  await setup();
  vi.spyOn(store, 'createConversation').mockImplementation(() => {
    throw Error('SECRET_PATH');
  });
  const response = await post('/api/conversations', {});
  expect(response.status).toBe(503);
  expect(await response.text()).not.toContain('SECRET_PATH');
});
test('only one instance may consume a database, and lock releases cleanly', () => {
  const dir = mkdtempSync(join(tmpdir(), 'instance-'));
  try {
    const path = join(dir, 'harness.db');
    const release = acquireInstanceLock(path);
    expect(() => acquireInstanceLock(path)).toThrow('instance_running');
    release();
    const release2 = acquireInstanceLock(path);
    release2();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('HTTP storage failure aborts current execution and latches the queue closed', async () => {
  let finish!: (r: import('../src/shared/contracts.js').Result) => void;
  let signal: AbortSignal | undefined,
    calls = 0;
  const result = {
    text: 'must not complete',
    scope: '',
    evidence: [],
    unfinished: [],
    externalSessionId: null,
  };
  await setup({
    status: async () => ({
      state: 'available',
      reason: null,
      verifiedAt: 'now',
      remainingQuota: null,
    }),
    run: async (_t, _s, ctl) => {
      calls++;
      signal = ctl.signal;
      if (calls > 1) return result;
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
  });
  const c = store.createConversation(),
    a = store.submit({ conversationId: c.id, clientId: 'active', text: 'active' }),
    b = store.submit({ conversationId: c.id, clientId: 'waiting', text: 'waiting' });
  runner.wake();
  await vi.waitFor(() => expect(calls).toBe(1));
  vi.spyOn(store, 'createConversation').mockImplementation(() => {
    throw Error('SQLITE_FULL');
  });
  try {
    expect((await post('/api/conversations', {})).status).toBe(503);
    expect(runner.health()).toBe('recording_failed');
    expect(signal?.aborted).toBe(true);
    expect(store.getTask(b.id)?.status).toBe('queued');
  } finally {
    finish(result);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  expect(calls).toBe(1);
  expect(store.result(a.id)).toBeNull();
  expect((await fetch(url + '/api/health')).status).toBe(503);
});

test('upload API checks chunk hashes and prepares only completed originals', async () => {
  const { Uploads } = await import('../src/server/uploads.js');
  const { createHash } = await import('node:crypto');
  const dir = mkdtempSync(join(tmpdir(), 'http-upload-'));
  await setup();
  await new Promise<void>((r) => server.close(() => r()));
  const adapter: Adapter = {
    status: async () => ({
      state: 'unconfigured',
      reason: 'auth_required',
      verifiedAt: null,
      remainingQuota: null,
    }),
    run: async () => {
      throw Error();
    },
  };
  server = createServer(store, runner, adapter, { uploads: new Uploads(dir) });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const init = await post('/api/uploads', { clientId: 'one', name: 'x.txt', size: 3 });
    expect(init.status).toBe(201);
    const item = await init.json();
    const data = Buffer.from('abc'),
      sha256 = createHash('sha256').update(data).digest('hex');
    expect((await post(`/api/uploads/${item.id}/prepare`, { start: 1, end: 1 })).status).toBe(400);
    const put = await fetch(`${url}/api/uploads/${item.id}/chunks/0`, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream', 'x-chunk-sha256': sha256 },
      body: data,
    });
    expect(put.status).toBe(200);
    expect((await post(`/api/uploads/${item.id}/complete`, { sha256 })).status).toBe(200);
    const prepared = await post(`/api/uploads/${item.id}/prepare`, { start: 1, end: 1 });
    expect(prepared.status).toBe(200);
    expect((await prepared.json()).text).toBe('abc');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('voice endpoint reports missing local model without pretending to transcribe', async () => {
  await setup();
  const response = await fetch(url + '/api/voice', {
    method: 'POST',
    headers: { 'content-type': 'audio/webm' },
    body: Buffer.from('not audio'),
  });
  expect(response.status).toBe(400);
  expect((await response.json()).error.code).toBe('speech_model_missing');
});
