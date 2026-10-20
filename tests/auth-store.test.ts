import { test, expect } from 'vitest';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileCredentialStore } from '../src/server/auth-store.js';
test('persists OAuth with restricted permissions and serializes concurrent changes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'auth-'));
  try {
    const path = join(dir, 'auth.json');
    const a = new FileCredentialStore(path);
    expect(await a.read('openai')).toBeUndefined();
    await a.modify('openai', async () => ({
      type: 'oauth',
      access: 'test',
      refresh: 'test',
      expires: 100,
      count: 0,
    }));
    const b = new FileCredentialStore(path);
    await Promise.all(
      Array.from({ length: 4 }, (_, i) =>
        (i % 2 ? a : b).modify('openai', async (c) => ({
          ...c!,
          count: Number(c && 'count' in c ? c.count : 0) + 1,
        })),
      ),
    );
    expect(await b.read('openai')).toMatchObject({ count: 4 });
    expect(statSync(path).mode & 0o077).toBe(0);
    expect(await b.list()).toEqual([{ providerId: 'openai', type: 'oauth' }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
