import { describe, expect, it } from 'vitest';
import { SOURCE_COLUMN, toHtmlTable, toTsv } from '@/src/core/export/tsv';
import type { RecordRow } from '@/src/shared/types';

function row(overrides: Partial<RecordRow> = {}): RecordRow {
  return {
    id: 'r1:abc',
    runId: 'r1',
    urlKey: 'abc',
    url: 'https://example.test/film/1',
    title: 'Film Satu',
    fields: { year: '2024', genre: 'Drama' },
    raw: '{}',
    provenance: {
      source: 'dom',
      pageUrl: 'https://example.test/film',
      selector: '.card',
      adapter: null,
      capturedAt: 1,
    },
    isNew: false,
    firstSeenAt: 1,
    lastSeenAt: 1,
    ...overrides,
  };
}

const COLUMNS = [
  { key: 'title', label: 'Judul' },
  { key: 'year', label: 'Tahun' },
  SOURCE_COLUMN,
];

describe('toTsv', () => {
  it('menulis header dari label kolom yang terlihat', () => {
    const tsv = toTsv([row()], COLUMNS);
    const [head, first] = tsv.split('\n');
    expect(head).toBe('Judul\tTahun\tSumber');
    expect(first).toBe('Film Satu\t2024\tdom');
  });

  it('meratakan tab dan baris baru di dalam nilai agar kolom tidak bergeser', () => {
    const tsv = toTsv([row({ title: 'Baris\nsatu\tdan dua' })], COLUMNS);
    expect(tsv.split('\n')).toHaveLength(2);
    expect(tsv.split('\n')[1]!.split('\t')).toHaveLength(3);
    expect(tsv).toContain('Baris satu dan dua');
  });

  it('memakai urutan record apa adanya', () => {
    const tsv = toTsv(
      [row({ id: 'a', title: 'Pertama' }), row({ id: 'b', title: 'Kedua' })],
      COLUMNS,
    );
    expect(tsv.split('\n').map((line) => line.split('\t')[0])).toEqual([
      'Judul',
      'Pertama',
      'Kedua',
    ]);
  });
});

describe('toHtmlTable', () => {
  it('meng-escape isi sel supaya markup situs tidak merusak tabel', () => {
    const html = toHtmlTable([row({ title: '<b>A & B</b>' })], COLUMNS);
    expect(html).toContain('&lt;b&gt;A &amp; B&lt;/b&gt;');
    expect(html).not.toContain('<b>A');
    expect(html).toContain('<th>Judul</th><th>Tahun</th><th>Sumber</th>');
  });
});
