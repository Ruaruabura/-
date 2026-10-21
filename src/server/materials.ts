import { execFile } from 'node:child_process';
import { open, mkdtemp, rm, access } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { tmpdir } from 'node:os';
export type Material = { uploadId: string; name: string; text: string; scope: string };
export type Range = { start: number; end: number };
let busy = false;
function command(file: string, args: string[], timeout = 60000): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile(file, args, { timeout, maxBuffer: 1024 * 1024, encoding: 'utf8' }, (error, stdout) =>
      error ? reject(Error('local_processing_failed')) : resolve(stdout),
    ),
  );
}
export function speechConfig() {
  return {
    python: process.env.HARNESS_SPEECH_PYTHON ?? '/workspace/.cache/harness/speech-venv/bin/python',
    model: process.env.HARNESS_SPEECH_MODEL ?? '/workspace/.cache/harness/faster-whisper-small',
  };
}
export async function speechAvailable() {
  const c = speechConfig();
  try {
    await access(join(c.model, 'model.bin'));
    await access(c.python);
    return true;
  } catch {
    return false;
  }
}
export async function transcribe(path: string): Promise<string> {
  if (!(await speechAvailable())) throw Error('speech_model_missing');
  const c = speechConfig();
  return command(
    c.python,
    [new URL('./speech.py', import.meta.url).pathname, c.model, path],
    300000,
  );
}
export async function extractMaterial(
  path: string,
  name: string,
  range: Range,
): Promise<{ text: string; scope: string }> {
  if (
    !Number.isInteger(range.start) ||
    !Number.isInteger(range.end) ||
    range.start < 1 ||
    range.end < range.start
  )
    throw Error('invalid_range');
  if (busy) throw Error('processing_busy');
  busy = true;
  try {
    let text = '',
      scope = '';
    const ext = extname(name).toLowerCase();
    if (['.txt', '.md', '.csv', '.json', '.log', '.srt', '.vtt'].includes(ext)) {
      const file = await open(path, 'r');
      const bytes = Buffer.alloc(48001);
      let count = 0;
      try {
        count = (await file.read(bytes, 0, bytes.length, 0)).bytesRead;
      } finally {
        await file.close();
      }
      if (bytes.subarray(0, count).includes(0)) throw Error('unsupported_binary');
      text = bytes.subarray(0, count).toString('utf8');
      scope = '文本前 12,000 字符';
    } else if (ext === '.pdf') {
      if (range.end - range.start >= 20) throw Error('invalid_range');
      const info = await command('pdfinfo', [path]);
      const pages = Number(info.match(/^Pages:\s+(\d+)/m)?.[1]);
      if (!Number.isSafeInteger(pages) || range.start > pages) throw Error('invalid_range');
      const end = Math.min(range.end, pages);
      text = await command('pdftotext', [
        '-f',
        String(range.start),
        '-l',
        String(end),
        '-enc',
        'UTF-8',
        path,
        '-',
      ]);
      scope = `PDF 第 ${range.start}–${end} 页（共 ${pages} 页）；仅文本层，未识别扫描图像`;
    } else if (['.png', '.jpg', '.jpeg', '.webp'].includes(ext)) {
      text = await command('tesseract', [
        path,
        'stdout',
        '--tessdata-dir',
        process.env.HARNESS_TESSDATA ?? '/workspace/.cache/harness/tessdata',
        '-l',
        'chi_sim+eng',
      ]);
      scope = '图像本地 OCR 文本；模型未查看原图';
    } else if (
      ['.mp4', '.mov', '.mkv', '.webm', '.mp3', '.wav', '.m4a', '.ogg', '.flac'].includes(ext)
    ) {
      if (range.end - range.start >= 600) throw Error('invalid_range');
      if (!(await speechAvailable())) throw Error('speech_model_missing');
      const dir = await mkdtemp(join(tmpdir(), 'harness-audio-'));
      try {
        const audio = join(dir, 'segment.wav');
        await command('ffmpeg', [
          '-nostdin',
          '-v',
          'error',
          '-ss',
          String(range.start - 1),
          '-i',
          path,
          '-t',
          String(range.end - range.start + 1),
          '-vn',
          '-ac',
          '1',
          '-ar',
          '16000',
          audio,
        ]);
        text = await transcribe(audio);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
      scope = `音轨 ${range.start - 1}–${range.end} 秒转写；未查看视频画面`;
    } else throw Error('unsupported_material');
    if (!text.trim()) throw Error('no_text_extracted');
    const truncated = text.length > 12000;
    return { text: text.slice(0, 12000), scope: scope + (truncated ? '；已截断' : '') };
  } finally {
    busy = false;
  }
}

export async function transcribeVoice(bytes: Buffer): Promise<string> {
  if (!(await speechAvailable())) throw Error('speech_model_missing');
  if (busy) throw Error('processing_busy');
  busy = true;
  const dir = await mkdtemp(join(tmpdir(), 'harness-voice-'));
  try {
    const path = join(dir, 'recording');
    const file = await open(path, 'w', 0o600);
    try {
      await file.writeFile(bytes);
    } finally {
      await file.close();
    }
    const duration = Number(
      (
        await command('ffprobe', [
          '-v',
          'error',
          '-show_entries',
          'format=duration',
          '-of',
          'default=noprint_wrappers=1:nokey=1',
          path,
        ])
      ).trim(),
    );
    if (!Number.isFinite(duration) || duration <= 0 || duration > 120)
      throw Error('voice_duration');
    const text = (await transcribe(path)).trim();
    if (!text) throw Error('no_text_extracted');
    if (text.length > 12000) throw Error('voice_too_long');
    return text;
  } finally {
    await rm(dir, { recursive: true, force: true });
    busy = false;
  }
}
