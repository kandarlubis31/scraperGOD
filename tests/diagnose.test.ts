import { describe, expect, it } from 'vitest';
import { buildDiagnosis, conclusionOf, type PaginationFacts } from '@/src/core/probe/diagnose';
import type { ApiPlan } from '@/src/shared/types';

const API: ApiPlan = {
  url: 'https://contoh.test/api/daftar?page=1',
  method: 'GET',
  bodyTemplate: null,
  bodyPageParam: null,
  contentType: null,
  cursorParam: null,
  cursorKind: null,
  arrayPath: 'data.items',
  mapping: {
    title: 'title',
    url: null,
    company: null,
    location: null,
    salary: null,
    date: null,
    description: null,
  },
  extraFields: {},
  pageParam: 'page',
  pageKind: 'page',
  pageValue: 1,
  pageSize: 20,
  total: null,
  verified: true,
  verifyNote: null,
};

function facts(overrides: Partial<PaginationFacts> = {}): PaginationFacts {
  return {
    url: 'https://contoh.test/daftar',
    itemCount: 20,
    api: null,
    apiNotes: [],
    more: [],
    nextUrl: null,
    nextUrlVia: null,
    scroll: { window: false, containers: [] },
    ...overrides,
  };
}

describe('buildDiagnosis', () => {
  it('melaporkan tombol yang dilewati beserta alasannya, bukan "daftar habis"', () => {
    const input = facts({
      more: [
        { label: 'Muat lebih banyak', reason: 'disabled' },
        { label: 'Lihat lebih banyak lowongan', reason: 'navigates' },
      ],
    });
    const report = buildDiagnosis(input);

    expect(report).toContain('tidak bisa diklik');
    expect(report).toContain('dinonaktifkan');
    expect(report).toContain('menuju dokumen lain');
    // Kesimpulan tidak boleh menyebut ada jalur yang bisa dipakai.
    expect(conclusionOf(input)).toContain('tidak ada jalur pagination');
  });

  it('mengatakan tidak ada jalur pagination saat semua jalur kosong', () => {
    const report = buildDiagnosis(facts());

    expect(report).toContain('API: tidak dipakai');
    expect(report).toContain('Link berikutnya: tidak ada');
    expect(report).toContain('Scroll: sudah mentok');
    expect(report).toContain('Kesimpulan: tidak ada jalur pagination');
  });

  it('memilih API lebih dulu saat rencananya lolos', () => {
    const report = buildDiagnosis(
      facts({
        api: API,
        nextUrl: 'https://contoh.test/daftar?page=2',
        nextUrlVia: 'dari halaman',
      }),
    );

    expect(report).toContain('API: dipakai');
    expect(report).toContain('20 item/halaman');
    expect(conclusionOf(facts({ api: API }))).toContain('pagination lewat API');
  });
});
