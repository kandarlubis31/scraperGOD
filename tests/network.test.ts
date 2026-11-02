import { describe, expect, it } from 'vitest';
import {
  analyzeCapture,
  apiPageUrl,
  apiRequest,
  findSecretSource,
  hasMorePages,
  hasUnfilledSecrets,
  isSecretKey,
  pageOverlap,
  SECRET_PLACEHOLDER,
  scanCaptures,
  unfilledSecretKeys,
  snapshotFromApiPage,
  type NetworkCapture,
} from '@/src/core/source/network';
import type { PageItem } from '@/src/shared/types';

function capture(overrides: Partial<NetworkCapture> = {}): NetworkCapture {
  return {
    url: 'https://jobs.test/api/search?page=1&limit=3&q=dev',
    method: 'GET',
    status: 200,
    contentType: 'application/json',
    truncated: false,
    capturedAt: 1,
    body: JSON.stringify({
      data: {
        jobs: [
          { title: 'Frontend Dev', slug: '/l/1', company: { name: 'Alfa' }, city: 'Jakarta' },
          { title: 'Backend Dev', slug: '/l/2', company: { name: 'Beta' }, city: 'Bandung' },
          { title: 'QA Engineer', slug: '/l/3', company: { name: 'Gama' }, city: 'Remote' },
        ],
      },
    }),
    ...overrides,
  };
}

const BASE = 'https://jobs.test/search';

describe('analyzeCapture', () => {
  it('membangun rencana API dari response berparameter halaman', () => {
    const { source, note } = analyzeCapture(capture(), BASE);

    expect(note).toBeNull();
    expect(source).not.toBeNull();
    expect(source!.items).toHaveLength(3);
    expect(source!.items[0]).toMatchObject({ title: 'Frontend Dev', url: 'https://jobs.test/l/1' });
    expect(source!.api).toMatchObject({
      arrayPath: 'data.jobs',
      method: 'GET',
      pageParam: 'page',
      pageKind: 'page',
      pageValue: 1,
      pageSize: 3,
    });
    expect(source!.api.mapping.url).toBe('slug');
    // Objek pembungkus tetap valid: `asText` mengambil `name` di dalamnya.
    expect(source!.api.mapping.company).toBe('company');
    expect(source!.items[0]!.fields.company).toBe('Alfa');
  });

  it('menyimpan URL request absolut walau capture-nya relatif', () => {
    const { source } = analyzeCapture(
      capture({ url: '/api/search?page=1&limit=3' }),
      'https://jobs.test/hasil?q=dev',
    );

    expect(source!.api.url).toBe('https://jobs.test/api/search?page=1&limit=3');
    expect(new URL(apiPageUrl(source!.api, 1)).searchParams.get('page')).toBe('2');
  });

  it('menolak body yang terpotong, bukan memarse JSON separuh', () => {
    const { source, note } = analyzeCapture(capture({ truncated: true }), BASE);
    expect(source).toBeNull();
    expect(note).toContain('terpotong');
  });

  it('menerima POST dengan body: field halaman naik, field lain utuh', () => {
    const { source } = analyzeCapture(
      capture({
        url: 'https://jobs.test/api/search',
        method: 'POST',
        requestContentType: 'application/json',
        requestBody: JSON.stringify({ page: 1, limit: 3, filters: { q: 'dev', city: 'Jakarta' } }),
      }),
      BASE,
    );

    expect(source).not.toBeNull();
    expect(source!.api).toMatchObject({
      method: 'POST',
      bodyPageParam: 'page',
      pageParam: null,
      contentType: 'application/json',
      pageValue: 1,
    });

    const next = apiRequest(source!.api, 1);
    expect(next.method).toBe('POST');
    expect(JSON.parse(next.body!)).toEqual({
      page: 2,
      limit: 3,
      filters: { q: 'dev', city: 'Jakarta' },
    });
  });

  it('memakai cursor dari respons untuk request berikutnya', () => {
    const body = JSON.stringify({
      items: [
        { title: 'A', slug: '/a' },
        { title: 'B', slug: '/b' },
        { title: 'C', slug: '/c' },
      ],
      pageInfo: { hasNextPage: true, endCursor: 'c2' },
    });
    const { source, note } = analyzeCapture(
      capture({ url: 'https://jobs.test/api/feed?cursor=abc', body }),
      BASE,
    );

    expect(note).toBeNull();
    expect(source!.api).toMatchObject({ cursorParam: 'cursor', cursorKind: 'query', pageParam: null });

    const snapshot = snapshotFromApiPage(JSON.parse(body), source!.api, source!.api.url, 0);
    expect(snapshot.nextCursor).toBe('c2');
    expect(apiRequest(source!.api, 1, snapshot.nextCursor).url).toContain('cursor=c2');
  });

  it('rencana API tidak pernah memuat header sensitif', () => {
    const { source } = analyzeCapture(
      capture({
        method: 'POST',
        requestContentType: 'application/json',
        requestBody: JSON.stringify({ page: 1, limit: 3, q: 'dev' }),
      }),
      BASE,
    );

    const stored = JSON.stringify(source!.api).toLowerCase();
    // Hook hanya mengirim content-type; cookie/Authorization tidak pernah
    // dibaca dari request, jadi tidak mungkin ikut tersimpan.
    expect(stored).not.toContain('authorization');
    expect(stored).not.toContain('cookie');
    expect(source!.api.contentType).toBe('application/json');
  });

  it('menolak rencana kalau halaman 2 hampir seluruhnya sama dengan halaman 1', () => {
    const items: PageItem[] = [
      { url: '/l/1', title: 'A', fields: {}, raw: '' },
      { url: '/l/2', title: 'B', fields: {}, raw: '' },
    ];

    const all = pageOverlap(items, items, 'https://jobs.test/');
    expect(all.rejected).toContain('identik');

    // 9 dari 10 item halaman 2 = halaman 1: masih ditolak.
    const first = Array.from({ length: 10 }, (_, i) => ({
      url: `/l/${i}`,
      title: `T${i}`,
      fields: {},
      raw: '',
    }));
    const second = [
      ...first.slice(0, 9),
      { url: '/l/99', title: 'Baru', fields: {}, raw: '' },
    ];
    expect(pageOverlap(first, second, 'https://jobs.test/').rejected).not.toBeNull();
  });

  it('2 item sponsor berulang di halaman 2 tidak membatalkan rencana', () => {
    const first = Array.from({ length: 10 }, (_, i) => ({
      url: `/l/${i}`,
      title: `T${i}`,
      fields: {},
      raw: '',
    }));
    const second = [
      first[0]!,
      first[1]!,
      ...Array.from({ length: 8 }, (_, i) => ({
        url: `/l/${10 + i}`,
        title: `Baru ${i}`,
        fields: {},
        raw: '',
      })),
    ];

    const overlap = pageOverlap(first, second, 'https://jobs.test/');
    expect(overlap.rejected).toBeNull();
    expect(overlap.note).toContain('20%');
  });

  it('tidak menyimpan nilai token di body maupun URL, hanya placeholder', () => {
    const { source } = analyzeCapture(
      capture({
        url: 'https://jobs.test/api/search?page=1&limit=3&csrfToken=url-tok-1',
        method: 'POST',
        requestContentType: 'application/json',
        requestBody: JSON.stringify({
          page: 1,
          limit: 3,
          csrfToken: 'body-tok-2',
          variables: { authToken: 'jwt-tok-3', q: 'dev' },
        }),
      }),
      BASE,
    );

    const stored = JSON.stringify(source!.api);
    expect(stored).not.toContain('url-tok-1');
    expect(stored).not.toContain('body-tok-2');
    expect(stored).not.toContain('jwt-tok-3');
    expect(JSON.parse(source!.api.bodyTemplate!)).toEqual({
      page: 1,
      limit: 3,
      csrfToken: SECRET_PLACEHOLDER,
      variables: { authToken: SECRET_PLACEHOLDER, q: 'dev' },
    });
  });

  it('membedakan key rahasia dari key yang sekadar berawalan auth', () => {
    // author/authorId adalah data, bukan token.
    expect(isSecretKey('author')).toBe(false);
    expect(isSecretKey('authorId')).toBe(false);
    expect(isSecretKey('author_name')).toBe(false);

    expect(isSecretKey('authToken')).toBe(true);
    expect(isSecretKey('auth')).toBe(true);
    expect(isSecretKey('authorization')).toBe(true);
    expect(isSecretKey('Authorization')).toBe(true);
    expect(isSecretKey('x-auth-token')).toBe(true);
    expect(isSecretKey('csrfToken')).toBe(true);
    expect(isSecretKey('apiKey')).toBe(true);
    expect(isSecretKey('accessToken')).toBe(true);
  });

  it('pesan berhenti menyebut key yang placeholder-nya kosong', () => {
    const { source } = analyzeCapture(
      capture({
        url: 'https://jobs.test/api/search?page=1&limit=3&csrfToken=old',
        method: 'POST',
        requestContentType: 'application/json',
        requestBody: JSON.stringify({
          page: 1,
          limit: 3,
          csrfToken: 'old',
          variables: { authToken: 'jwt', q: 'dev' },
          authorId: 42,
        }),
      }),
      BASE,
    );

    const request = apiRequest(source!.api, 1);
    expect(unfilledSecretKeys(request)).toEqual(['csrfToken', 'variables.authToken']);
    // authorId bukan rahasia: nilainya tetap ada di template.
    expect(JSON.parse(source!.api.bodyTemplate!).authorId).toBe(42);
  });

  it('mengisi placeholder token dari request asli terbaru saat replay', () => {
    const { source } = analyzeCapture(
      capture({
        url: 'https://jobs.test/api/search?page=1&limit=3&csrfToken=old',
        method: 'POST',
        requestContentType: 'application/json',
        requestBody: JSON.stringify({ page: 1, limit: 3, csrfToken: 'old', q: 'dev' }),
      }),
      BASE,
    );
    const api = source!.api;

    // Tanpa sumber token: replay tidak boleh jalan dengan placeholder.
    expect(hasUnfilledSecrets(apiRequest(api, 1))).toBe(true);

    const secrets = findSecretSource(api, [
      {
        url: 'https://jobs.test/api/search?page=1&limit=3&csrfToken=fresh',
        method: 'POST',
        requestBody: JSON.stringify({ page: 1, limit: 3, csrfToken: 'fresh', q: 'dev' }),
      },
    ]);
    expect(secrets).not.toBeNull();

    const next = apiRequest(api, 1, null, secrets);
    expect(hasUnfilledSecrets(next)).toBe(false);
    expect(JSON.parse(next.body!)).toEqual({ page: 2, limit: 3, csrfToken: 'fresh', q: 'dev' });
    expect(new URL(next.url).searchParams.get('csrfToken')).toBe('fresh');
  });

  it('menolak response tanpa array item', () => {
    const { source, note } = analyzeCapture(
      capture({ body: JSON.stringify({ ok: true, filters: [] }) }),
      BASE,
    );
    expect(source).toBeNull();
    expect(note).toContain('array');
  });
});

describe('scanCaptures', () => {
  it('memilih sumber dengan skor tertinggi dan mengumpulkan alasan penolakan', () => {
    const scan = scanCaptures(
      [
        capture({ url: 'https://jobs.test/api/session', body: JSON.stringify({ user: 'x' }) }),
        capture(),
      ],
      BASE,
    );

    expect(scan.sources).toHaveLength(1);
    expect(scan.sources[0]!.itemCount).toBe(3);
    expect(scan.notes.join(' ')).toContain('array');
  });
});

describe('pagination API', () => {
  it('menaikkan parameter halaman tanpa mengubah filter lain', () => {
    const { source } = analyzeCapture(capture(), BASE);
    const url = new URL(apiPageUrl(source!.api, 2));
    expect(url.searchParams.get('page')).toBe('3');
    expect(url.searchParams.get('q')).toBe('dev');
  });

  it('memakai langkah sebesar pageSize untuk offset', () => {
    const body = JSON.stringify({
      items: [
        { title: 'A', slug: '/a' },
        { title: 'B', slug: '/b' },
        { title: 'C', slug: '/c' },
      ],
    });
    const { source } = analyzeCapture(
      capture({ url: 'https://jobs.test/api/list?offset=0&limit=3', body }),
      BASE,
    );

    expect(source!.api).toMatchObject({ pageKind: 'offset', pageValue: 0, pageSize: 3 });
    expect(new URL(apiPageUrl(source!.api, 1)).searchParams.get('offset')).toBe('3');
  });

  it('berhenti saat halaman terakhir lebih pendek dari pageSize', () => {
    const { source } = analyzeCapture(capture(), BASE);
    const api = source!.api;

    expect(hasMorePages(api, 0, 3)).toBe(true);
    expect(hasMorePages(api, 0, 2)).toBe(false);
    expect(hasMorePages(api, 0, 0)).toBe(false);
  });

  it('berhenti saat total dari situs sudah tercapai', () => {
    const { source } = analyzeCapture(capture(), BASE);
    const api = { ...source!.api, total: 6 };

    expect(hasMorePages(api, 0, 3)).toBe(true);
    expect(hasMorePages(api, 1, 3)).toBe(false);
  });
});

describe('snapshotFromApiPage', () => {
  it('menerjemahkan JSON halaman jadi snapshot dengan URL halaman berikutnya', () => {
    const { source } = analyzeCapture(capture(), BASE);
    const json = JSON.parse(capture().body);

    const first = snapshotFromApiPage(json, source!.api, source!.api.url, 0);
    expect(first.source).toBe('network');
    expect(first.items).toHaveLength(3);
    expect(first.nextUrl).toContain('page=2');

    const last = snapshotFromApiPage(
      { data: { jobs: [{ title: 'Only', slug: '/l/9' }] } },
      source!.api,
      source!.api.url,
      4,
    );
    expect(last.items).toHaveLength(1);
    expect(last.nextUrl).toBeNull();
  });

  it('mengembalikan halaman kosong kalau path array tidak ada', () => {
    const { source } = analyzeCapture(capture(), BASE);
    const snapshot = snapshotFromApiPage({ data: {} }, source!.api, source!.api.url, 0);

    expect(snapshot.items).toHaveLength(0);
    expect(snapshot.nextUrl).toBeNull();
  });
});
