import { open, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { ExecutionError } from './adapter.js';
export function createWorkspaceReader(workspace: string, budget: number) {
  let remaining = budget;
  return async function readWorkspaceFile(path: string): Promise<string> {
    if (
      isAbsolute(path) ||
      path.split(/[\\/]/).some((p) => p === '..' || p.startsWith('.')) ||
      !path.trim()
    )
      throw new Error('path_denied');
    const root = await realpath(workspace),
      target = await realpath(resolve(root, path)),
      rel = relative(root, target);
    if (
      rel === '..' ||
      rel.startsWith(`..${sep}`) ||
      isAbsolute(rel) ||
      rel.split(sep).some((part) => part.startsWith('.'))
    )
      throw new Error('path_denied');
    const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 64000) throw new ExecutionError('input_limit');
      const bytes = Buffer.alloc(64001);
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
      if (bytesRead > 64000) throw new ExecutionError('input_limit');
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, bytesRead));
      if (text.includes('\0')) throw new Error('unsupported_file');
      if (text.length > remaining) throw new ExecutionError('input_limit');
      remaining -= text.length;
      return text;
    } finally {
      await file.close();
    }
  };
}
