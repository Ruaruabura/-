import { Uploads, CHUNK_BYTES } from './uploads.js';
import { extractMaterial, speechAvailable, transcribeVoice } from './materials.js';
import { createServer as nodeServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { isStoreConflict, type Store } from './store.js';
import type { Runner } from './runner.js';
import type { Adapter } from './adapter.js';
type Middleware = (req: IncomingMessage, res: ServerResponse, next: () => void) => void;
class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
  ) {
    super(code);
  }
}
const messages: Record<string, string> = {
  not_found: '未找到记录',
  speech_model_missing: '本地语音模型未就绪，请配置模型目录后重试。',
  checksum_mismatch: '文件校验失败，请重新选择原文件后重试。',
  material_budget: '所选材料超过输入预算，请缩小范围或分批发送。',
  local_processing_failed: '本地提取失败，文件可能损坏或工具不可用。',
  no_text_extracted: '未提取到文字；扫描 PDF 请先转换为图片进行 OCR。',
  invalid_input: '输入格式不正确',
  idempotency_conflict: '该发送编号已用于另一条消息',
  invalid_transition: '任务当前状态不支持此操作',
  recording_failed: '记录保存失败，执行已停止。请检查磁盘并重启服务。',
  forbidden: '仅允许本地同源访问',
  too_large: '请求过大',
  json_required: '请使用 JSON 请求',
};
function json(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(data));
}
async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!req.headers['content-type']?.startsWith('application/json'))
    throw new HttpError(415, 'json_required');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 131072) throw new HttpError(413, 'too_large');
    chunks.push(chunk);
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error();
    return value as Record<string, unknown>;
  } catch {
    throw new HttpError(400, 'invalid_input');
  }
}
export function createServer(
  store: Store,
  runner: Runner,
  adapter: Adapter,
  options: { staticDir?: string; middleware?: Middleware; uploads?: Uploads } = {},
) {
  function database<T>(operation: () => T): T {
    try {
      return operation();
    } catch (error) {
      if (isStoreConflict(error)) throw error;
      runner.recordingFailed();
      throw new HttpError(503, 'recording_failed');
    }
  }
  const server = nodeServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    try {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
      if (
        !req.headers.host ||
        !hosts.has(req.headers.host) ||
        req.headers['sec-fetch-site'] === 'cross-site'
      )
        throw new HttpError(403, 'forbidden');
      if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`)
        throw new HttpError(403, 'forbidden');
      const url = new URL(req.url ?? '/', 'http://localhost');
      const path = url.pathname;
      const method = req.method ?? 'GET';
      if (path.startsWith('/api/')) {
        if (runner.health()) throw new HttpError(503, 'recording_failed');
        if (method === 'GET' && path === '/api/capabilities')
          return json(res, 200, { speech: await speechAvailable(), uploads: !!options.uploads });
        if (method === 'POST' && path === '/api/voice') {
          if (!(await speechAvailable())) throw new HttpError(400, 'speech_model_missing');
          const chunks: Buffer[] = [];
          let size = 0;
          for await (const chunk of req) {
            size += chunk.length;
            if (size > 16 * 1024 * 1024) throw new HttpError(413, 'too_large');
            chunks.push(chunk);
          }
          let text: string;
          try {
            text = await transcribeVoice(Buffer.concat(chunks));
          } catch (error) {
            throw new HttpError(
              400,
              error instanceof Error ? error.message : 'local_processing_failed',
            );
          }
          const id = database(() =>
            store.saveMaterial({
              uploadId: 'voice',
              name: '语音原始转写',
              text,
              scope: '本地语音转写，音频已删除',
            }),
          );
          return json(res, 200, { id, text });
        }
        if (options.uploads && path.startsWith('/api/uploads')) {
          try {
            const uploads = options.uploads;
            if (path === '/api/uploads' && method === 'POST') {
              const data = await body(req);
              if (
                typeof data.clientId !== 'string' ||
                typeof data.name !== 'string' ||
                typeof data.size !== 'number'
              )
                throw new HttpError(400, 'invalid_input');
              return json(res, 201, uploads.create(data.clientId, data.name, data.size));
            }
            const route = path.match(
              /^\/api\/uploads\/([\w-]+)(?:\/(complete|prepare|chunks)(?:\/(\d+))?)?$/,
            );
            if (!route) throw new HttpError(404, 'not_found');
            const [, id, action, index] = route;
            if (method === 'GET' && !action) return json(res, 200, uploads.status(id));
            if (method === 'PUT' && action === 'chunks') {
              if (req.headers['content-type'] !== 'application/octet-stream')
                throw new HttpError(415, 'invalid_input');
              const chunks: Buffer[] = [];
              let size = 0;
              for await (const chunk of req) {
                size += chunk.length;
                if (size > CHUNK_BYTES) throw new HttpError(413, 'too_large');
                chunks.push(chunk);
              }
              return json(
                res,
                200,
                await uploads.put(
                  id,
                  Number(index),
                  Buffer.concat(chunks),
                  String(req.headers['x-chunk-sha256'] ?? ''),
                ),
              );
            }
            if (method === 'POST' && action === 'complete') {
              const data = await body(req);
              return json(res, 200, await uploads.complete(id, String(data.sha256 ?? '')));
            }
            if (method === 'POST' && action === 'prepare') {
              const data = await body(req),
                file = uploads.status(id);
              const derived = await extractMaterial(uploads.contentPath(id), file.name, {
                start: Number(data.start),
                end: Number(data.end),
              });
              const material = { uploadId: id, name: file.name, ...derived };
              const materialId = database(() => store.saveMaterial(material));
              return json(res, 200, { id: materialId, ...material });
            }
            throw new HttpError(404, 'not_found');
          } catch (error) {
            if (error instanceof HttpError) throw error;
            const code = error instanceof Error ? error.message : '';
            const expected = [
              'invalid_upload',
              'upload_conflict',
              'upload_quota',
              'upload_busy',
              'invalid_chunk',
              'checksum_mismatch',
              'upload_complete',
              'invalid_checksum',
              'upload_incomplete',
              'invalid_range',
              'processing_busy',
              'speech_model_missing',
              'unsupported_material',
              'unsupported_binary',
              'no_text_extracted',
              'local_processing_failed',
            ];
            if (expected.includes(code)) throw new HttpError(400, code);
            throw error;
          }
        }
        if (method === 'GET' && path === '/api/health') return json(res, 200, { ok: true });
        if (method === 'GET' && path === '/api/connection')
          return json(res, 200, await adapter.status());
        if (path === '/api/conversations') {
          if (method === 'GET')
            return json(
              res,
              200,
              database(() => store.conversations()),
            );
          if (method === 'POST') {
            await body(req);
            return json(
              res,
              201,
              database(() => store.createConversation()),
            );
          }
        }
        const conversation = path.match(
          /^\/api\/conversations\/([\w-]+)\/(messages|events|tasks)$/,
        );
        if (conversation) {
          const [, id, kind] = conversation;
          if (!database(() => store.hasConversation(id))) throw new HttpError(404, 'not_found');
          if (method === 'GET') {
            if (kind === 'messages')
              return json(
                res,
                200,
                database(() => store.messages(id)),
              );
            if (kind === 'tasks')
              return json(
                res,
                200,
                database(() =>
                  store.tasks(id).map((task) => ({ ...task, result: store.result(task.id) })),
                ),
              );
            const after = Number(url.searchParams.get('after') ?? '0');
            if (!Number.isSafeInteger(after) || after < 0)
              throw new HttpError(400, 'invalid_input');
            return json(
              res,
              200,
              database(() => store.events(id, after)),
            );
          }
          if (method === 'POST' && kind === 'messages') {
            const data = await body(req);
            if (
              typeof data.clientId !== 'string' ||
              !/^[\w-]{1,100}$/.test(data.clientId) ||
              typeof data.text !== 'string' ||
              !data.text.trim()
            )
              throw new HttpError(400, 'invalid_input');
            if (
              data.materialIds !== undefined &&
              (!Array.isArray(data.materialIds) ||
                data.materialIds.length > 3 ||
                data.materialIds.some((v) => typeof v !== 'string'))
            )
              throw new HttpError(400, 'invalid_input');
            const materials = ((data.materialIds as string[] | undefined) ?? []).map((id) =>
              database(() => store.preparedMaterial(id)),
            );
            if (
              materials.reduce((n, m) => n + m.text.length, 0) + (data.text as string).length >
              18000
            )
              throw new HttpError(400, 'material_budget');
            if (data.transcriptId !== undefined && typeof data.transcriptId !== 'string')
              throw new HttpError(400, 'invalid_input');
            const transcript = data.transcriptId
              ? database(() => store.preparedMaterial(data.transcriptId as string))
              : undefined;
            if (transcript && transcript.uploadId !== 'voice')
              throw new HttpError(400, 'invalid_input');
            const task = database(() =>
              store.submit({
                conversationId: id,
                clientId: data.clientId as string,
                text: data.text as string,
                materials,
                transcript: transcript?.text,
              }),
            );
            runner.wake();
            return json(res, 201, task);
          }
        }
        const taskRoute = path.match(/^\/api\/tasks\/([\w-]+)(?:\/(cancel|resume))?$/);
        if (taskRoute) {
          const [, id, action] = taskRoute,
            task = database(() => store.getTask(id));
          if (!task) throw new HttpError(404, 'not_found');
          if (method === 'GET' && !action)
            return json(res, 200, { ...task, result: database(() => store.result(id)) });
          if (method === 'POST' && action) {
            await body(req);
            if (action === 'cancel') {
              if (!['queued', 'paused', 'running', 'cancelled'].includes(task.status))
                throw new HttpError(409, 'invalid_transition');
              // Cancellation is asynchronous; the slot is retained until the adapter settles.
              void runner.cancel(id).catch(() => {});
            } else runner.resume(id);
            if (runner.health()) throw new HttpError(503, 'recording_failed');
            return json(
              res,
              202,
              database(() => store.getTask(id)),
            );
          }
        }
        throw new HttpError(404, 'not_found');
      }
      if (method !== 'GET' && method !== 'HEAD') throw new HttpError(404, 'not_found');
      if (options.middleware) {
        options.middleware(req, res, () => {
          if (!res.writableEnded)
            json(res, 404, { error: { code: 'not_found', message: '未找到页面' } });
        });
        return;
      }
      const root = resolve(options.staticDir ?? 'dist'),
        requested = path === '/' ? 'index.html' : decodeURIComponent(path).replace(/^\//, '');
      const file = resolve(root, requested);
      if (!file.startsWith(root + sep)) throw new HttpError(403, 'forbidden');
      const data = await readFile(file).catch(() => {
        throw new HttpError(404, 'not_found');
      });
      const mime: Record<string, string> = {
        '.html': 'text/html; charset=utf-8',
        '.js': 'text/javascript; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.svg': 'image/svg+xml',
        '.ico': 'image/x-icon',
      };
      res.setHeader(
        'Content-Security-Policy',
        "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'",
      );
      res.writeHead(200, { 'Content-Type': mime[extname(file)] ?? 'application/octet-stream' });
      res.end(method === 'HEAD' ? undefined : data);
    } catch (error) {
      if (res.writableEnded || res.destroyed) return;
      const known = error instanceof Error ? error.message : '';
      const status =
        error instanceof HttpError
          ? error.status
          : known === 'not_found'
            ? 404
            : ['invalid_transition', 'idempotency_conflict'].includes(known)
              ? 409
              : 503;
      const code =
        error instanceof HttpError ? error.code : status === 503 ? 'recording_failed' : known;
      json(res, status, { error: { code, message: messages[code] ?? '请求无法完成' } });
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  return server;
}
