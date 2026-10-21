import { createHash, randomUUID } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  openSync,
  fsyncSync,
  closeSync,
  existsSync,
  readdirSync,
} from 'node:fs';
import { open, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
export const CHUNK_BYTES = 4 * 1024 * 1024;
type Manifest = {
  id: string;
  clientId: string;
  name: string;
  size: number;
  chunks: { index: number; sha256: string }[];
  sha256: string | null;
};
const digest = (data: Buffer) => createHash('sha256').update(data).digest('hex');
export class Uploads {
  private busy = new Set<string>();
  constructor(private root: string) {
    mkdirSync(join(root, 'manifests'), { recursive: true });
    mkdirSync(join(root, 'objects'), { recursive: true });
  }
  private save(m: Manifest) {
    const target = join(this.root, 'manifests', m.id + '.json'),
      tmp = target + '.' + randomUUID();
    writeFileSync(tmp, JSON.stringify(m), { mode: 0o600 });
    const fd = openSync(tmp, 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, target);
  }
  create(clientId: string, name: string, size: number): Manifest {
    if (
      !/^[\w-]{1,100}$/.test(clientId) ||
      !name ||
      name.length > 255 ||
      !Number.isSafeInteger(size) ||
      size < 1 ||
      size > 2 ** 31
    )
      throw Error('invalid_upload');
    let total = 0;
    for (const file of readdirSync(join(this.root, 'manifests'))) {
      if (!file.endsWith('.json')) continue;
      const m = JSON.parse(readFileSync(join(this.root, 'manifests', file), 'utf8')) as Manifest;
      if (m.clientId === clientId) {
        if (m.name !== name || m.size !== size) throw Error('upload_conflict');
        return m;
      }
      total += m.size;
    }
    if (total + size > 10 * 2 ** 30) throw Error('upload_quota');
    const m: Manifest = { id: randomUUID(), clientId, name, size, chunks: [], sha256: null };
    mkdirSync(join(this.root, m.id));
    this.save(m);
    return m;
  }
  status(id: string): Manifest {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw Error('invalid_upload');
    return JSON.parse(readFileSync(join(this.root, 'manifests', id + '.json'), 'utf8'));
  }
  private async exclusive<T>(id: string, fn: () => Promise<T>): Promise<T> {
    if (this.busy.has(id)) throw Error('upload_busy');
    this.busy.add(id);
    try {
      return await fn();
    } finally {
      this.busy.delete(id);
    }
  }
  async put(id: string, index: number, data: Buffer, sha256: string) {
    return this.exclusive(id, async () => {
      const m = this.status(id);
      if (
        !Number.isInteger(index) ||
        index < 0 ||
        index >= Math.ceil(m.size / CHUNK_BYTES) ||
        data.length !== Math.min(CHUNK_BYTES, m.size - index * CHUNK_BYTES)
      )
        throw Error('invalid_chunk');
      if (digest(data) !== sha256) throw Error('checksum_mismatch');
      const old = m.chunks.find((c) => c.index === index);
      if (old) {
        if (old.sha256 !== sha256) throw Error('upload_conflict');
        return m;
      }
      if (m.sha256) throw Error('upload_complete');
      const path = join(this.root, id, String(index)),
        tmp = path + '.tmp';
      const f = await open(tmp, 'w', 0o600);
      try {
        await f.writeFile(data);
        await f.sync();
      } finally {
        await f.close();
      }
      await rename(tmp, path);
      m.chunks.push({ index, sha256 });
      m.chunks.sort((a, b) => a.index - b.index);
      this.save(m);
      return m;
    });
  }
  async complete(id: string, sha256: string) {
    return this.exclusive(id, async () => {
      const m = this.status(id);
      if (!/^[a-f0-9]{64}$/.test(sha256)) throw Error('invalid_checksum');
      if (m.sha256) {
        if (m.sha256 !== sha256) throw Error('upload_conflict');
        return m;
      }
      if (m.chunks.length !== Math.ceil(m.size / CHUNK_BYTES)) throw Error('upload_incomplete');
      const tmp = join(this.root, id, 'assembled'),
        out = await open(tmp, 'w', 0o600),
        hash = createHash('sha256');
      try {
        for (let i = 0; i < m.chunks.length; i++) {
          const bytes = readFileSync(join(this.root, id, String(i)));
          if (digest(bytes) !== m.chunks[i].sha256) throw Error('checksum_mismatch');
          hash.update(bytes);
          await out.writeFile(bytes);
        }
        await out.sync();
      } catch (e) {
        await rm(tmp, { force: true });
        throw e;
      } finally {
        await out.close();
      }
      if (hash.digest('hex') !== sha256) {
        await rm(tmp, { force: true });
        throw Error('checksum_mismatch');
      }
      const target = join(this.root, 'objects', sha256);
      if (existsSync(target)) await rm(tmp, { force: true });
      else await rename(tmp, target);
      m.sha256 = sha256;
      this.save(m);
      await rm(join(this.root, id), { recursive: true, force: true });
      return m;
    });
  }
  contentPath(id: string) {
    const m = this.status(id);
    if (!m.sha256) throw Error('upload_incomplete');
    return join(this.root, 'objects', m.sha256);
  }
}
