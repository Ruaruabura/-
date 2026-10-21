import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, expect, test } from 'vitest';
import { Uploads, CHUNK_BYTES } from '../src/server/uploads.js';
const roots: string[] = [];
const root = () => {
  const p = mkdtempSync(join(tmpdir(), 'uploads-'));
  roots.push(p);
  return p;
};
const hash = (b: Buffer) => createHash('sha256').update(b).digest('hex');
afterEach(() => roots.splice(0).forEach((p) => rmSync(p, { recursive: true, force: true })));
test('verified chunks survive restart and completion preserves original bytes', async () => {
  const dir = root(),
    data = Buffer.alloc(CHUNK_BYTES + 7, 42);
  const a = new Uploads(dir);
  const item = a.create('client-one', '../original.bin', data.length);
  await a.put(item.id, 0, data.subarray(0, CHUNK_BYTES), hash(data.subarray(0, CHUNK_BYTES)));
  const b = new Uploads(dir);
  expect(b.status(item.id).chunks).toHaveLength(1);
  await b.put(item.id, 1, data.subarray(CHUNK_BYTES), hash(data.subarray(CHUNK_BYTES)));
  const done = await b.complete(item.id, hash(data));
  expect(done.sha256).toBe(hash(data));
  expect(readFileSync(b.contentPath(item.id)).equals(data)).toBe(true);
  expect(await b.complete(item.id, hash(data))).toEqual(done);
});
test('bad checksums and conflicting retries never mark a file complete', async () => {
  const a = new Uploads(root()),
    data = Buffer.from('abc'),
    item = a.create('client', 'x', 3);
  await expect(a.put(item.id, 0, data, '0'.repeat(64))).rejects.toThrow('checksum');
  expect(a.status(item.id).chunks).toHaveLength(0);
  await a.put(item.id, 0, data, hash(data));
  await expect(a.put(item.id, 0, Buffer.from('xyz'), hash(Buffer.from('xyz')))).rejects.toThrow(
    'conflict',
  );
  await expect(a.complete(item.id, '0'.repeat(64))).rejects.toThrow('checksum');
  expect(a.status(item.id).sha256).toBeNull();
});
test('validates bounds, identities and idempotent metadata', () => {
  const a = new Uploads(root());
  const item = a.create('client', 'x', 1);
  expect(a.create('client', 'x', 1).id).toBe(item.id);
  expect(() => a.create('client', 'y', 1)).toThrow('conflict');
  for (const size of [0, -1, 2 ** 31 + 1, 1.5])
    expect(() => a.create('other', 'x', size)).toThrow('invalid');
  expect(() => a.status('../escape')).toThrow('invalid');
});
