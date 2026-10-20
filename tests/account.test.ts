import { test, expect } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
test('account status is safe without credentials and verification never invents access', () => {
  const dir = mkdtempSync(join(tmpdir(), 'account-'));
  const env = { ...process.env, HARNESS_DATA_DIR: dir, PI_AUTH_DIR: join(dir, 'auth') };
  try {
    const status = execFileSync(
      process.execPath,
      ['--import', 'tsx', 'src/server/account.ts', 'status'],
      { env, encoding: 'utf8' },
    );
    expect(status).toContain('unconfigured');
    const denied = spawnSync(
      process.execPath,
      ['--import', 'tsx', 'src/server/account.ts', 'verify', '--confirm-subscription'],
      { env, encoding: 'utf8' },
    );
    expect(denied.status).toBe(1);
    expect(denied.stderr).toContain('auth_required');
    expect(existsSync(join(dir, 'subscription-verification.json'))).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
