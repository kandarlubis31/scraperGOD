import { describe, expect, it } from 'vitest';

type Target = { fetch: (input?: any, init?: any) => Promise<any> };
import {
  installFetchHook,
  summarizeJson,
  type CaptureRecord,
} from '../src/net/hook';
import { inferPagination } from '../src/net/paginate';

function fakeResponse(body: unknown, contentType = 'application/json; charset=utf-8') {
  return {
    status: 200,
    headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? contentType : null) },
    clone() {
      return this;
    },
    text: async () => JSON.stringify(body),
  };
}

function wait(ms = 10): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('hook fetch (S4)', () => {
  it('menangkap response JSON saat armed, tanpa mengubah hasil fetch', async () => {
    const payload = { data: [{ id: 1 }, { id: 2 }], total: 42 };
    const response = fakeResponse(payload);
    const target: Target = { fetch: async () => response };
    const captures: CaptureRecord[] = [];

    installFetchHook(target, { armed: () => true, onCapture: (c) => captures.push(c) });

    const result = await target.fetch('https://contoh.test/api/jobs?page=2');
    await wait();

    expect(result).toBe(response);
    expect(captures).toHaveLength(1);
    expect(captures[0]).toMatchObject({
      url: 'https://contoh.test/api/jobs?page=2',
      method: 'GET',
      status: 200,
      itemCount: 2,
      total: 42,
      arrayPath: 'data',
    });
  });

  it('tidak membaca response saat belum armed', async () => {
    let cloned = 0;
    const response = {
      ...fakeResponse({ data: [{ id: 1 }, { id: 2 }] }),
      clone() {
        cloned += 1;
        return this;
      },
    };
    const target: Target = { fetch: async () => response };
    const captures: CaptureRecord[] = [];

    installFetchHook(target, { armed: () => false, onCapture: (c) => captures.push(c) });

    await target.fetch('https://contoh.test/api/jobs');
    await wait();

    expect(cloned).toBe(0);
    expect(captures).toHaveLength(0);
  });

  it('mengabaikan response non-JSON dan body rusak', async () => {
    const target: Target = {
      fetch: async (input: string) =>
        input.includes('html')
          ? fakeResponse('<html></html>', 'text/html')
          : {
              ...fakeResponse({}),
              text: async () => '{bukan json',
            },
    };
    const captures: CaptureRecord[] = [];

    installFetchHook(target, { armed: () => true, onCapture: (c) => captures.push(c) });
    await target.fetch('https://contoh.test/html');
    await target.fetch('https://contoh.test/broken');
    await wait();

    expect(captures).toHaveLength(0);
  });

  it('tidak memasang hook dua kali', () => {
    const target: Target = { fetch: async () => fakeResponse({}) };
    installFetchHook(target, { armed: () => false, onCapture: () => {} });
    const once = target.fetch;
    installFetchHook(target, { armed: () => false, onCapture: () => {} });
    expect(target.fetch).toBe(once);
  });

  it('meringkas array terdalam dan total', () => {
    const summary = summarizeJson({
      meta: { code: 200 },
      result: { jobs: [{ id: 1 }, { id: 2 }, { id: 3 }], totalCount: 340 },
    });
    expect(summary.primaryArrayPath).toBe('result.jobs');
    expect(summary.primaryArrayLength).toBe(3);
    expect(summary.total).toBe(340);
  });
});

describe('inferensi pagination (S7)', () => {
  it('nomor halaman + limit di query', () => {
    const hint = inferPagination('https://contoh.test/api/jobs?page=3&limit=20', {
      data: [{ id: 1 }, { id: 2 }],
      total: 340,
      hasMore: true,
      limit: 20,
    });

    expect(hint).toMatchObject({
      pageParam: 'page',
      pageValue: 3,
      pageSize: 20,
      total: 340,
      hasMore: true,
    });
  });

  it('offset + total bersarang (Elasticsearch style)', () => {
    const hint = inferPagination('https://contoh.test/api/search?offset=40&limit=20', {
      hits: { total: { value: 1000 }, hits: [{ id: 1 }, { id: 2 }] },
      has_more: true,
    });

    expect(hint.pageParam).toBe('offset');
    expect(hint.pageValue).toBe(40);
    expect(hint.total).toBe(1000);
    expect(hint.hasMore).toBe(true);
  });

  it('cursor di query dan nextCursor di body', () => {
    const hint = inferPagination('https://contoh.test/api/jobs?cursor=abc', {
      jobs: [{ id: 1 }],
      nextCursor: 'def',
      hasMore: true,
    });

    expect(hint.pageParam).toBe('cursor');
    expect(hint.nextCursor).toBe('def');
    expect(hint.hasMore).toBe(true);
  });

  it('URL tanpa parameter pagination tetap dilaporkan jujur', () => {
    const hint = inferPagination('https://contoh.test/api/jobs', {
      data: [{ id: 1 }],
    });
    expect(hint.pageParam).toBeNull();
    expect(hint.pageValue).toBeNull();
  });
});
