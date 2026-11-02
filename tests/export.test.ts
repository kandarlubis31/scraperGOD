import { describe, expect, it } from 'vitest';
import { CSV_BOM, escapeCell, toCsv } from '@/src/core/export/csv';
import { buildExport } from '@/src/core/export';
import { exportFilename, toJson } from '@/src/core/export/json';
import type { RecordRow, Run } from '@/src/shared/types';

function row(overrides: Partial<RecordRow> = {}): RecordRow {
  return {
    id: 'run-1:https://contoh.test/a',
    runId: 'run-1',
    urlKey: 'https://contoh.test/a',
    url: 'https://contoh.test/a',
    title: 'Insinyur Perangkat Lunak',
    fields: { company: 'PT Maju', salary: 'Rp10.000.000' },
    raw: '{"a":1}',
    provenance: {
      source: 'embedded',
      pageUrl: 'https://contoh.test/list',
      selector: null,
      adapter: null,
      capturedAt: 1,
    },
    isNew: true,
    firstSeenAt: 1,
    lastSeenAt: 1,
    ...overrides,
  };
}

const run: Run = {
  id: 'run-1',
  status: 'done',
  startUrl: 'https://www.contoh.test/lowongan?page=1',
  tabId: 7,
  maxPages: 3,
  maxItems: 1000,
  createdAt: 1,
  updatedAt: 2,
  finishedAt: 2,
  checkpoint: {
    nextUrl: null,
    page: 2,
    itemCount: 2,
    lastFingerprint: null,
    emptyPages: 0,
    seenPages: 0,
    expand: false,
    cursor: null,
  },
  lease: null,
  lastError: null,
  stopReason: 'next-missing',
  incremental: true,
  api: null,
  selector: null,
  container: null,
};

describe('CSV', () => {
  it('mengutip sel yang memuat koma, kutip, dan baris baru', () => {
    expect(escapeCell('biasa')).toBe('biasa');
    expect(escapeCell('a,b')).toBe('"a,b"');
    expect(escapeCell('kata "kunci"')).toBe('"kata ""kunci"""');
    expect(escapeCell('baris1\nbaris2')).toBe('"baris1\nbaris2"');
  });

  it('menulis header tetap lalu gabungan field, tanpa duplikat kolom', () => {
    const csv = toCsv([
      row(),
      row({ fields: { location: 'Bandung', company: 'PT Lain', salary: '' } }),
    ]);
    const [header] = csv.replace(CSV_BOM, '').split('\r\n');

    expect(header).toBe('url,title,sumber,company,salary,location');
    expect(csv.startsWith(CSV_BOM)).toBe(true);
    expect(csv.endsWith('\r\n')).toBe(true);
  });

  it('baris mengikuti urutan kolom header meski field tidak lengkap', () => {
    const csv = toCsv(
      [row({ fields: { location: 'Bandung' } }), row({ url: 'https://contoh.test/b', fields: {} })],
      { bom: false },
    );
    const lines = csv.trim().split('\r\n');

    // Hanya `location` yang ada, jadi hanya kolom itu yang ditambahkan.
    expect(lines[0]).toBe('url,title,sumber,location');
    expect(lines[1]).toBe('https://contoh.test/a,Insinyur Perangkat Lunak,embedded,Bandung');
    expect(lines[2]).toBe('https://contoh.test/b,Insinyur Perangkat Lunak,embedded,');
  });
});

describe('JSON', () => {
  it('memuat provenance dan raw supaya bisa diproses ulang', () => {
    const parsed = JSON.parse(toJson([row()], run, new Date('2026-03-04T05:06:07Z')));

    expect(parsed.exportedAt).toBe('2026-03-04T05:06:07.000Z');
    expect(parsed.count).toBe(1);
    expect(parsed.records[0].raw).toBe('{"a":1}');
    expect(parsed.records[0].provenance.source).toBe('embedded');
    expect(parsed.run).toMatchObject({ id: 'run-1', stopReason: 'next-missing' });
  });
});

describe('nama file', () => {
  it('memakai host tanpa www dan stempel waktu', () => {
    expect(exportFilename(run, 'csv', new Date(2026, 0, 9, 7, 5))).toBe(
      'contoh-test-20260109-0705.csv',
    );
  });
});

describe('buildExport', () => {
  it('menyertakan mime dan jumlah baris yang benar', () => {
    const csv = buildExport(run, [row(), row()], 'csv', new Date(2026, 0, 9, 7, 5));
    expect(csv.filename).toBe('contoh-test-20260109-0705.csv');
    expect(csv.mime).toContain('text/csv');
    expect(csv.count).toBe(2);

    const json = buildExport(run, [row()], 'json', new Date(2026, 0, 9, 7, 5));
    expect(json.mime).toContain('application/json');
    expect(JSON.parse(json.content).count).toBe(1);
  });

  it('run kosong tetap menghasilkan header yang valid', () => {
    const csv = buildExport(run, [], 'csv', new Date(2026, 0, 9, 7, 5));
    expect(csv.content.replace(CSV_BOM, '')).toBe('url,title,sumber\r\n');
    expect(csv.count).toBe(0);
  });
});
