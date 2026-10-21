// Real 1 GiB disk round trip, bounded 4 MiB buffer; not part of the fast suite.
import { Uploads, CHUNK_BYTES } from '../src/server/uploads.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
const root = mkdtempSync(join(tmpdir(), 'harness-gib-'));
try {
  let uploads = new Uploads(root);
  const item = uploads.create('large', '1GiB.bin', 2 ** 30),
    all = createHash('sha256');
  for (let i = 0; i < 256; i++) {
    const bytes = Buffer.alloc(CHUNK_BYTES, i);
    all.update(bytes);
    await uploads.put(item.id, i, bytes, createHash('sha256').update(bytes).digest('hex'));
    if (i === 127) {
      uploads = new Uploads(root);
      assert.equal(uploads.status(item.id).chunks.length, 128);
    }
  }
  const expected = all.digest('hex');
  await uploads.complete(item.id, expected);
  const actual = createHash('sha256');
  for await (const bytes of createReadStream(uploads.contentPath(item.id))) actual.update(bytes);
  assert.equal(actual.digest('hex'), expected);
  console.log(
    JSON.stringify({
      bytes: 2 ** 30,
      chunks: 256,
      restartedAfter: 128,
      sha256: expected,
      passed: true,
    }),
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
