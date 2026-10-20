import { mkdir } from 'node:fs/promises';
import { readConfig } from './config.js';
import { openStore } from './store.js';
import { createRunner } from './runner.js';
import { createPiAdapter } from './pi-adapter.js';
import { createServer } from './http.js';
import { acquireInstanceLock } from './instance-lock.js';

async function main() {
  const config = readConfig();
  await mkdir(config.workspace, { recursive: true, mode: 0o700 });
  const release = acquireInstanceLock(config.databasePath),
    store = openStore(config.databasePath);
  store.recoverInterrupted();
  const adapter = createPiAdapter(config),
    runner = createRunner(store, adapter);
  const dev = process.argv.includes('--dev')
    ? await import('vite').then((v) =>
        v.createServer({ server: { middlewareMode: true }, appType: 'spa' }),
      )
    : null;
  const server = createServer(store, runner, adapter, { middleware: dev?.middlewares });
  let closing = false;
  async function close() {
    if (closing) return;
    closing = true;
    server.close();
    await runner.stop();
    await dev?.close();
    server.closeAllConnections();
    store.close();
    release();
  }
  process.once('SIGINT', () => void close());
  process.once('SIGTERM', () => void close());
  server.once('error', async () => {
    console.error('本地服务启动失败：端口被占用或不可用。');
    await close();
    process.exitCode = 1;
  });
  server.listen(config.port, '127.0.0.1', () => {
    console.log(`个人工作台已启动，端口 ${config.port}（仅本机访问）`);
    runner.wake();
  });
}
main().catch((error) => {
  console.error(
    error instanceof Error && error.message === 'instance_running'
      ? '此数据目录已有工作台实例运行。'
      : '工作台启动失败，请检查配置与数据目录权限。',
  );
  process.exitCode = 1;
});
