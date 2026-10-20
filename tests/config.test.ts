import { afterEach, expect, test, vi } from 'vitest';
import { readConfig } from '../src/server/config.js';
afterEach(() => vi.unstubAllEnvs());
test('refuses a workspace containing the credential directory or database', () => {
  vi.stubEnv('HARNESS_DATA_DIR', '/tmp/config-data');
  vi.stubEnv('PI_AUTH_DIR', '/tmp/config-data/auth');
  vi.stubEnv('HARNESS_WORKSPACE', '/tmp/config-data');
  expect(() => readConfig()).toThrow('unsafe_workspace');
  vi.stubEnv('HARNESS_WORKSPACE', '/tmp/isolated-material');
  expect(readConfig().workspace).toBe('/tmp/isolated-material');
});
