import { readFile, writeFile, mkdir, rename, chmod } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { lock } from 'proper-lockfile';
import type {
  AuthOperationOptions,
  Credential,
  CredentialInfo,
  CredentialStore,
} from '@earendil-works/pi-ai';

/** Pi-compatible auth.json store. OAuth login/refresh stays in the official SDK. */
export class FileCredentialStore implements CredentialStore {
  constructor(private readonly path: string) {}
  private async load(): Promise<Record<string, Credential>> {
    try {
      const data: unknown = JSON.parse(await readFile(this.path, 'utf8'));
      if (!data || typeof data !== 'object' || Array.isArray(data))
        throw new Error('invalid_auth_store');
      return data as Record<string, Credential>;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw new Error('auth_store_unavailable');
    }
  }
  async read(id: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
    options?.signal?.throwIfAborted();
    return (await this.load())[id];
  }
  async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
    options?.signal?.throwIfAborted();
    return Object.entries(await this.load())
      .filter(([, v]) => v.type === 'oauth' || v.type === 'api_key')
      .map(([providerId, v]) => ({ providerId, type: v.type }));
  }
  private async change(
    id: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
    remove = false,
    options?: AuthOperationOptions,
  ): Promise<Credential | undefined> {
    options?.signal?.throwIfAborted();
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    try {
      await writeFile(this.path, '{}', { flag: 'wx', mode: 0o600 });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    const release = await lock(this.path, {
      realpath: false,
      retries: { retries: 8, minTimeout: 20, maxTimeout: 200 },
    });
    try {
      options?.signal?.throwIfAborted();
      const data = await this.load();
      const next = await fn(data[id]);
      if (remove) delete data[id];
      else if (next) data[id] = next;
      const temp = `${this.path}.${randomUUID()}.tmp`;
      await writeFile(temp, JSON.stringify(data), { mode: 0o600 });
      await rename(temp, this.path);
      await chmod(this.path, 0o600);
      return data[id];
    } finally {
      await release();
    }
  }
  modify(
    id: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
    options?: AuthOperationOptions,
  ) {
    return this.change(id, fn, false, options);
  }
  async delete(id: string, options?: AuthOperationOptions): Promise<void> {
    await this.change(id, async () => undefined, true, options);
  }
}
