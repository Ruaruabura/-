import { resolve, join, relative, isAbsolute, dirname, basename } from 'node:path';
import { existsSync, realpathSync } from 'node:fs';
function canonical(path: string): string {
  if (existsSync(path)) return realpathSync(path);
  const parent = dirname(path);
  return parent === path ? path : join(canonical(parent), basename(path));
}
export function readConfig() {
  if (existsSync('.env')) process.loadEnvFile('.env');
  const dataDir = canonical(resolve(process.env.HARNESS_DATA_DIR ?? '.data'));
  const port = Number(process.env.PORT ?? 4317);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid_port');
  const workspace = canonical(resolve(process.env.HARNESS_WORKSPACE ?? join(dataDir, 'workspace'))),
    authDir = canonical(resolve(process.env.PI_AUTH_DIR ?? join(dataDir, 'auth'))),
    databasePath = join(dataDir, 'harness.db');
  for (const path of [authDir, databasePath]) {
    const rel = relative(workspace, path);
    if (!rel || (!rel.startsWith('..') && !isAbsolute(rel))) throw new Error('unsafe_workspace');
  }
  return {
    dataDir,
    databasePath,
    workspace,
    authDir,
    verificationPath: join(dataDir, 'subscription-verification.json'),
    model: process.env.PI_MODEL ?? 'gpt-5.5',
    port,
  };
}
