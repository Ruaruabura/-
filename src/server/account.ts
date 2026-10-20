import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readConfig } from './config.js';
import { createPiAdapter, createSubscriptionModels } from './pi-adapter.js';
import { FileCredentialStore } from './auth-store.js';
import { acquireInstanceLock } from './instance-lock.js';
import { ExecutionError } from './adapter.js';
async function main() {
  const command = process.argv[2],
    config = readConfig();
  const adapter = createPiAdapter(config);
  if (command === 'status') {
    console.log(JSON.stringify(await adapter.status(), null, 2));
    return;
  }
  if (!['login', 'verify'].includes(command))
    throw new Error('请使用 account:status、login 或 verify:pi。');
  if (command === 'verify' && !process.argv.includes('--confirm-subscription'))
    throw new Error(
      '请先核对订阅和额外消费设置，再运行 npm run verify:pi -- --confirm-subscription。',
    );
  const release = acquireInstanceLock(config.databasePath);
  try {
    await mkdir(config.authDir, { recursive: true, mode: 0o700 });
    if (command === 'verify') {
      const audit = join(config.dataDir, 'connection-checks.jsonl');
      const record = async (status: string) =>
        appendFile(
          audit,
          JSON.stringify({
            at: new Date().toISOString(),
            provider: 'openai',
            model: config.model,
            action: 'subscription_probe',
            status,
          }) + '\n',
          { mode: 0o600 },
        );
      await record('started');
      try {
        await adapter.verify();
        await record('passed');
        console.log('订阅连接小任务通过。现在可以启动工作台；剩余额度仍未知。');
      } catch (error) {
        await record(error instanceof ExecutionError ? error.code : 'failed');
        throw error;
      }
      return;
    }
    const models = createSubscriptionModels(
      new FileCredentialStore(join(config.authDir, 'auth.json')),
    );
    const rl = createInterface({ input: stdin, output: stdout });
    const devicePath = join(config.dataDir, 'device-id');
    let deviceId: string;
    try {
      deviceId = (await readFile(devicePath, 'utf8')).trim();
    } catch {
      deviceId = randomUUID();
      await writeFile(devicePath, deviceId, { mode: 0o600 });
    }
    console.log('通过 Pi 官方 SDK 的 Sign in with ChatGPT 登录。登录不会自动验证模型或执行任务。');
    try {
      await models.login(
        'openai',
        'oauth',
        {
          async prompt(prompt) {
            if (prompt.type === 'select') {
              console.log(prompt.message);
              for (const option of prompt.options) console.log(`${option.id}: ${option.label}`);
            }
            return rl.question(prompt.type === 'select' ? '选择：' : `${prompt.message}\n> `, {
              signal: prompt.signal,
            });
          },
          notify(event) {
            if (event.type === 'auth_url') console.log(`请在浏览器打开：${event.url}`);
            else if (event.type === 'device_code')
              console.log(`请打开 ${event.verificationUri}，输入设备码 ${event.userCode}`);
            else if (event.type === 'info' || event.type === 'progress') console.log(event.message);
          },
        },
        { agentName: 'Personal Agent Harness', getDeviceId: () => deviceId },
      );
      console.log(
        '登录信息已安全保存在本机。核对消费设置后，运行 npm run verify:pi -- --confirm-subscription。',
      );
    } finally {
      rl.close();
    }
  } finally {
    release();
  }
}
main().catch((error) => {
  const known = [
    'auth_required',
    'unverified',
    'quota',
    'timeout',
    'execution_failed',
    'instance_running',
    'unsafe_workspace',
  ];
  const message = error instanceof Error ? error.message : '';
  if (known.includes(message))
    console.error(`连接操作未完成：${message}。请检查 README 中的登录与验证说明。`);
  else if (message.startsWith('请')) console.error(message);
  else console.error('连接操作未完成。请检查网络和账号状态；认证细节不会输出到日志。');
  process.exitCode = 1;
});
