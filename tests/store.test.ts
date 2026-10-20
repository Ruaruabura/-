import { afterEach, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openStore, type Store } from '../src/server/store.js';
let store: Store;
const dirs: string[] = [];
afterEach(() => {
  store?.close();
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});
function fixture() {
  const d = mkdtempSync(join(tmpdir(), 'harness-'));
  dirs.push(d);
  const path = join(d, 'state.db');
  store = openStore(path);
  const c = store.createConversation();
  return { path, c, input: { conversationId: c.id, clientId: 'send-1', text: '我的原话  ' } };
}
test('persists original messages, tasks and ordered events across reopen', () => {
  const { path, c, input } = fixture();
  const task = store.submit(input);
  expect(task.status).toBe('queued');
  expect(store.messages(c.id)[0].text).toBe(input.text);
  store.transition(task.id, ['queued'], 'running');
  store.complete(task.id, {
    text: '回答',
    scope: '文字',
    evidence: [],
    unfinished: [],
    externalSessionId: null,
  });
  const events = store.events(c.id, 0);
  expect(events.map((e) => e.type)).toEqual([
    'message.sent',
    'task.queued',
    'task.running',
    'assistant.message',
    'task.completed',
  ]);
  expect(events.every((e, i) => i === 0 || e.seq > events[i - 1].seq)).toBe(true);
  store.close();
  store = openStore(path);
  expect(store.messages(c.id).map((m) => m.text)).toEqual([input.text, '回答']);
  expect(store.result(task.id)?.text).toBe('回答');
});
test('deduplicates sends and rejects conflicting idempotency IDs', () => {
  const { input, c } = fixture();
  const a = store.submit(input);
  expect(store.submit(input).id).toBe(a.id);
  expect(() => store.submit({ ...input, text: 'different' })).toThrow('idempotency_conflict');
  expect(store.messages(c.id)).toHaveLength(1);
});
test('rolls back whole send when event persistence fails', () => {
  const { path, input, c } = fixture();
  const db = new DatabaseSync(path);
  db.exec(
    "CREATE TRIGGER fail_event BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT, 'disk failure'); END",
  );
  db.close();
  expect(() => store.submit(input)).toThrow();
  expect(store.messages(c.id)).toHaveLength(0);
  expect(store.queued()).toHaveLength(0);
});
test('recovery pauses interrupted work and leaves queued tasks alone', () => {
  const { input } = fixture();
  const a = store.submit(input);
  const b = store.submit({ ...input, clientId: 'second' });
  store.transition(a.id, ['queued'], 'running');
  expect(store.recoverInterrupted()).toBe(1);
  expect(store.getTask(a.id)?.reason).toBe('interrupted');
  expect(store.getTask(b.id)?.status).toBe('queued');
  expect(() => store.transition(a.id, ['running'], 'completed')).toThrow('invalid_transition');
});
test('terminal tasks reject completion and cancellation cannot rewrite history', () => {
  const { input, c } = fixture();
  const a = store.submit(input);
  store.transition(a.id, ['queued'], 'cancelled');
  expect(() =>
    store.complete(a.id, {
      text: 'late',
      scope: '',
      evidence: [],
      unfinished: [],
      externalSessionId: null,
    }),
  ).toThrow('invalid_transition');
  expect(store.messages(c.id)).toHaveLength(1);
});
