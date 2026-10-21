import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { extractMaterial } from '../src/server/materials.js';
test('text extraction is bounded and reports actual coverage', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'material-'));
  try {
    const file = join(dir, 'text');
    writeFileSync(file, '你好'.repeat(10000));
    const result = await extractMaterial(file, 'notes.txt', { start: 1, end: 1 });
    expect(result.text.length).toBeLessThanOrEqual(12000);
    expect(result.scope).toContain('截断');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test('rejects unsafe ranges and unsupported files before tools run', async () => {
  await expect(extractMaterial('/none', 'x.pdf', { start: 0, end: 50 })).rejects.toThrow(
    'invalid_range',
  );
  await expect(extractMaterial('/none', 'x.exe', { start: 1, end: 1 })).rejects.toThrow(
    'unsupported',
  );
});

test('PDF extraction reports the actual page range and rejects pages beyond the document', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'material-pdf-'));
  try {
    const file = join(dir, 'one.pdf');
    const objects = [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ];
    const stream = 'BT /F1 12 Tf 20 200 Td (Scope evidence) Tj ET';
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    let pdf = '%PDF-1.4\n';
    const offsets = [0];
    objects.forEach((obj, i) => {
      offsets.push(Buffer.byteLength(pdf));
      pdf += `${i + 1} 0 obj\n${obj}\nendobj\n`;
    });
    const xref = Buffer.byteLength(pdf);
    pdf +=
      `xref\n0 6\n0000000000 65535 f \n` +
      offsets
        .slice(1)
        .map((o) => `${String(o).padStart(10, '0')} 00000 n \n`)
        .join('') +
      `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
    writeFileSync(file, pdf);
    const result = await extractMaterial(file, 'one.pdf', { start: 1, end: 5 });
    expect(result.text).toContain('Scope evidence');
    expect(result.scope).toContain('1–1');
    await expect(extractMaterial(file, 'one.pdf', { start: 2, end: 3 })).rejects.toThrow(
      'invalid_range',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
