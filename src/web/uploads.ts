import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
const CHUNK = 4 * 1024 * 1024;
async function request(path: string, options: RequestInit = {}) {
  const response = await fetch('/api/uploads' + path, options);
  const data = await response.json();
  if (!response.ok) throw Error(data.error?.message ?? '上传失败，请重试');
  return data;
}
const post = (path: string, data: unknown) =>
  request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
export async function uploadFile(
  file: File,
  range: { start: number; end: number },
  progress: (text: string) => void,
): Promise<string> {
  if (file.size < 1 || file.size > 2 ** 31) throw Error('文件大小须在 1 字节至 2 GiB 之间');
  const hash = sha256.create();
  for (let offset = 0; offset < file.size; offset += CHUNK) {
    hash.update(new Uint8Array(await file.slice(offset, offset + CHUNK).arrayBuffer()));
    progress(
      `${file.name} · 校验 ${Math.min(100, Math.round(((offset + CHUNK) / file.size) * 100))}%`,
    );
  }
  const checksum = bytesToHex(hash.digest());
  const clientId = bytesToHex(sha256(new TextEncoder().encode(file.name + '\n' + checksum)));
  const item = await post('', { clientId, name: file.name, size: file.size });
  for (let offset = 0; offset < file.size; offset += CHUNK) {
    const bytes = new Uint8Array(await file.slice(offset, offset + CHUNK).arrayBuffer()),
      index = offset / CHUNK;
    const chunkHash = bytesToHex(sha256(bytes));
    const existing = item.chunks.find((c: { index: number; sha256: string }) => c.index === index);
    if (existing && existing.sha256 !== chunkHash)
      throw Error('断点与所选文件不一致，请选择原文件');
    if (!existing)
      await request(`/${item.id}/chunks/${index}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream', 'x-chunk-sha256': chunkHash },
        body: bytes,
      });
    progress(
      `${file.name} · 上传 ${Math.min(100, Math.round(((offset + CHUNK) / file.size) * 100))}%`,
    );
  }
  await post(`/${item.id}/complete`, { sha256: checksum });
  progress(`${file.name} · 正在本地提取所选范围`);
  return (await post(`/${item.id}/prepare`, range)).id;
}
