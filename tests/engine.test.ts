import { describe, expect, it } from 'vitest';
import {
  createRun,
  isBusy,
  pump,
  savePickedRun,
  stopRun,
  type EngineDeps,
} from '@/src/core/run/engine';
import type { RunStore } from '@/src/core/store/types';
import type { PageSnapshot, RecordRow, Run, SeenEntry } from '@/src/shared/types';

function memoryStore(): RunStore & {
  records: Map<string, RecordRow>;
  seen: Map<string, SeenEntry>;
} {
  const runs = new Map<string, Run>();
  const records = new Map<string, RecordRow>();
  const seen = new Map<string, SeenEntry>();
  return {
    records,
    seen,
    async getRun(id) {
      return runs.get(id) ?? null;
    },
    async putRun(run) {
      runs.set(run.id, structuredClone(run));
    },
    async commitPage(run, rows, seenEntries = []) {
      for (const row of rows) records.set(row.id, structuredClone(row));
      for (const entry of seenEntries) {
        const previous = seen.get(entry.id);
        seen.set(
          entry.id,
          structuredClone({ ...entry, firstSeenAt: previous?.firstSeenAt ?? entry.firstSeenAt }),
        );
      }
      runs.set(run.id, structuredClone(run));
    },
    async listRecords(runId) {
      return [...records.values()].filter((row) => row.runId === runId);
    },
    async countRecords(runId) {
      return [...records.values()].filter((row) => row.runId === runId).length;
    },
    async listUrlKeys(runId) {
      return [...records.values()]
        .filter((row) => row.runId === runId)
        .map((row) => row.urlKey);
    },
    async seenUrlKeys(keys) {
      return new Set([...new Set(keys)].filter((key) => seen.has(key)));
    },
    async listRunsByStatus(statuses) {
      return [...runs.values()].filter((run) => statuses.includes(run.status));
    },
    async listRecentRuns(limit) {
      return [...runs.values()]
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, limit);
    },
    async deleteRun(runId) {
      runs.delete(runId);
      for (const [id, row] of records) if (row.runId === runId) records.delete(id);
    },
  };
}

function page(items: { url: string; title?: string }[], nextUrl: string | null): PageSnapshot {
  return {
    items: items.map((item) => ({
      url: item.url,
      title: item.title ?? item.url,
      fields: {},
      raw: '',
    })),
    nextUrl,
    source: 'dom',
    selector: null,
  };
}

function depsFor(
  store: RunStore,
  pages: Record<string, PageSnapshot>,
  overrides: Partial<EngineDeps> = {},
): EngineDeps {
  return {
    store,
    fetchPage: async (url) => {
      const snapshot = pages[url];
      if (!snapshot) throw new Error(`tidak ada fixture untuk ${url}`);
      return snapshot;
    },
    now: () => 1_000,
    owner: 'sw-a',
    ...overrides,
  };
}

const P1 = 'https://contoh.test/list?page=1';
const P2 = 'https://contoh.test/list?page=2';
const P3 = 'https://contoh.test/list?page=3';

describe('run engine', () => {
  it('createRun memulai dari queued dengan checkpoint kosong', async () => {
    const store = memoryStore();
    const run = await createRun({ startUrl: P1 }, { store, now: () => 5 });

    expect(run.status).toBe('queued');
    expect(run.checkpoint).toEqual({
      nextUrl: null,
      page: 0,
      itemCount: 0,
      lastFingerprint: null,
      emptyPages: 0,
      seenPages: 0,
      expand: false,
      cursor: null,
    });
    expect(await store.getRun(run.id)).toMatchObject({ id: run.id, maxPages: 50 });
  });

  it('mengikuti nextUrl sampai habis lalu done', async () => {
    const store = memoryStore();
    const run = await createRun({ startUrl: P1 }, { store, now: () => 1_000 });
    const deps = depsFor(store, {
      [P1]: page([{ url: '/a' }, { url: '/b' }], P2),
      [P2]: page([{ url: '/c' }, { url: '/d' }], P3),
      [P3]: page([{ url: '/e' }], null),
    });

    const done = await pump(run.id, deps);

    expect(done.status).toBe('done');
    expect(done.stopReason).toBe('next-missing');
    expect(done.checkpoint).toMatchObject({ page: 3, itemCount: 5, nextUrl: null });
    expect(await store.countRecords(run.id)).toBe(5);
  });

  it('membuang URL ganda di satu halaman', async () => {
    const store = memoryStore();
    const run = await createRun({ startUrl: P1 }, { store });
    const deps = depsFor(store, {
      [P1]: page(
        [{ url: '/a' }, { url: 'https://contoh.test/a?utm_source=x' }, { url: '/b' }],
        null,
      ),
    });

    const done = await pump(run.id, deps);
    expect(done.checkpoint.itemCount).toBe(2);
    expect(await store.countRecords(run.id)).toBe(2);
  });

  it('berhenti kalau pagination mengulang halaman yang sama', async () => {
    const store = memoryStore();
    const run = await createRun({ startUrl: P1 }, { store });
    const deps = depsFor(store, {
      [P1]: page([{ url: '/a' }, { url: '/b' }], P2),
      [P2]: page([{ url: '/a' }, { url: '/b' }], P3),
      [P3]: page([{ url: '/z' }], null),
    });

    const done = await pump(run.id, deps);
    expect(done.status).toBe('done');
    expect(done.stopReason).toBe('duplicate-page');
    expect(await store.countRecords(run.id)).toBe(2);
  });

  it('menghormati maxPages', async () => {
    const store = memoryStore();
    const run = await createRun({ startUrl: P1, maxPages: 2 }, { store });
    const deps = depsFor(store, {
      [P1]: page([{ url: '/a' }], P2),
      [P2]: page([{ url: '/b' }], P3),
      [P3]: page([{ url: '/c' }], null),
    });

    const done = await pump(run.id, deps);
    expect(done.stopReason).toBe('max-pages');
    expect(done.checkpoint.page).toBe(2);
    expect(await store.countRecords(run.id)).toBe(2);
  });

  it('memotong halaman terakhir sesuai maxItems', async () => {
    const store = memoryStore();
    const run = await createRun({ startUrl: P1, maxItems: 3 }, { store });
    const deps = depsFor(store, {
      [P1]: page([{ url: '/a' }, { url: '/b' }], P2),
      [P2]: page([{ url: '/c' }, { url: '/d' }], P3),
      [P3]: page([{ url: '/e' }], null),
    });

    const done = await pump(run.id, deps);
    expect(done.stopReason).toBe('max-items');
    expect(done.checkpoint.itemCount).toBe(3);
    expect(await store.countRecords(run.id)).toBe(3);
  });

  it('pause saat gagal, lalu lanjut tanpa duplikat', async () => {
    const store = memoryStore();
    const run = await createRun({ startUrl: P1 }, { store });
    const pages: Record<string, PageSnapshot> = {
      [P1]: page([{ url: '/a' }], P2),
      [P2]: page([{ url: '/b' }], null),
    };

    let boom = true;
    const failing: EngineDeps = {
      store,
      now: () => 2_000,
      owner: 'sw-a',
      fetchPage: async (url) => {
        if (url === P2 && boom) {
          boom = false;
          throw new Error('service worker dimatikan');
        }
        return pages[url]!;
      },
    };

    const paused = await pump(run.id, failing);
    expect(paused.status).toBe('paused');
    expect(paused.lastError).toContain('service worker');
    expect(paused.checkpoint.nextUrl).toBe(P2);
    expect(await store.countRecords(run.id)).toBe(1);

    const done = await pump(run.id, failing);
    expect(done.status).toBe('done');
    expect(await store.countRecords(run.id)).toBe(2);
    expect(done.checkpoint.itemCount).toBe(2);
  });

  it('tidak menyerobot run yang lease-nya masih dipegang worker lain', async () => {
    const store = memoryStore();
    const run = await createRun({ startUrl: P1 }, { store });
    const busy: Run = {
      ...run,
      lease: { owner: 'sw-b', expiresAt: 9_000 },
    };
    await store.putRun(busy);

    let fetched = 0;
    const deps: EngineDeps = {
      store,
      now: () => 1_000,
      owner: 'sw-a',
      fetchPage: async () => {
        fetched += 1;
        return page([{ url: '/a' }], null);
      },
    };

    const result = await pump(run.id, deps);
    expect(fetched).toBe(0);
    expect(result.status).toBe('queued');

    expect(isBusy(busy, 'sw-a', 1_000)).toBe(true);
    expect(isBusy(busy, 'sw-a', 9_001)).toBe(false);
  });

  it('melanjutkan run yang lease-nya sudah kedaluwarsa', async () => {
    const store = memoryStore();
    const run = await createRun({ startUrl: P1 }, { store });
    await store.putRun({ ...run, lease: { owner: 'sw-b', expiresAt: 500 } });

    const deps = depsFor(store, { [P1]: page([{ url: '/a' }], null) }, {
      now: () => 10_000,
    });

    const done = await pump(run.id, deps);
    expect(done.status).toBe('done');
    expect(done.lease?.owner).toBe('sw-a');
  });

  it('run lama tanpa checkpoint.expand tetap dilanjutkan', async () => {
    const store = memoryStore();
    const run = await createRun({ startUrl: P1 }, { store });
    // Run yang ditulis sebelum field ini ada: Dexie mengembalikan objek apa
    // adanya (tanpa parse Zod), jadi engine harus tahan `undefined` juga.
    const legacy = structuredClone(run);
    delete (legacy.checkpoint as { expand?: boolean }).expand;
    await store.putRun(legacy);

    const done = await pump(run.id, depsFor(store, { [P1]: page([{ url: '/a' }], null) }));

    expect(done.status).toBe('done');
    expect(done.checkpoint.expand).toBe(false);
  });

  it('Stop saat fetch berjalan tidak ditimpa halaman yang telanjur diambil', async () => {
    const store = memoryStore();
    const run = await createRun({ startUrl: P1 }, { store });

    const deps: EngineDeps = {
      store,
      now: () => 3_000,
      owner: 'sw-a',
      fetchPage: async () => {
        await stopRun(run.id, store, () => 2_500);
        return page([{ url: '/a' }], P2);
      },
    };

    const result = await pump(run.id, deps);
    expect(result.status).toBe('stopped');
    expect(await store.countRecords(run.id)).toBe(0);
  });

  it('stopRun menandai stopped dan menyimpan checkpoint', async () => {
    const store = memoryStore();
    const run = await createRun({ startUrl: P1 }, { store });
    const stopped = await stopRun(run.id, store, () => 42);

    expect(stopped).toMatchObject({ status: 'stopped', stopReason: 'stopped' });

    const again = await pump(run.id, depsFor(store, {}));
    expect(again.status).toBe('stopped');
  });

  it('item yang sudah tersimpan dari halaman sebelumnya tidak dihitung dua kali', async () => {
    const store = memoryStore();
    const run = await createRun({ startUrl: P1 }, { store });
    // Lazy-load khas: halaman 2 mengulang item terakhir halaman 1.
    const deps = depsFor(store, {
      [P1]: page([{ url: '/a' }, { url: '/b' }], P2),
      [P2]: page([{ url: '/b' }, { url: '/c' }], null),
    });

    const done = await pump(run.id, deps);

    expect(done.checkpoint.itemCount).toBe(3);
    expect(await store.countRecords(run.id)).toBe(3);
  });

  it('maxItems tidak habis terpakai oleh duplikat antar halaman', async () => {
    const store = memoryStore();
    const run = await createRun({ startUrl: P1, maxItems: 3 }, { store });
    const deps = depsFor(store, {
      [P1]: page([{ url: '/a' }, { url: '/b' }], P2),
      [P2]: page([{ url: '/b' }, { url: '/c' }], P3),
      [P3]: page([{ url: '/d' }], null),
    });

    const done = await pump(run.id, deps);

    expect(done.stopReason).toBe('max-items');
    expect(done.checkpoint.itemCount).toBe(3);
    expect(await store.countRecords(run.id)).toBe(3);
  });

  it('berhenti setelah beberapa halaman berurutan tanpa item baru', async () => {
    const store = memoryStore();
    const run = await createRun({ startUrl: P1 }, { store });
    const deps = depsFor(
      store,
      {
        [P1]: page([{ url: '/a' }], P2),
        [P2]: page([], P3),
        [P3]: page([], 'https://contoh.test/list?page=4'),
        'https://contoh.test/list?page=4': page([], P3),
      },
      { idlePageLimit: 2 },
    );

    const done = await pump(run.id, deps);

    expect(done.status).toBe('done');
    expect(done.stopReason).toBe('no-new-items');
    expect(done.checkpoint.page).toBe(3);
    expect(done.checkpoint.emptyPages).toBe(2);
    expect(await store.countRecords(run.id)).toBe(1);
  });

  it('menjeda antar-halaman tapi tidak setelah halaman terakhir', async () => {
    const store = memoryStore();
    const run = await createRun({ startUrl: P1, maxPages: 2 }, { store });
    const slept: number[] = [];
    const deps = depsFor(
      store,
      {
        [P1]: page([{ url: '/a' }], P2),
        [P2]: page([{ url: '/b' }], P3),
      },
      {
        delayMs: 700,
        sleep: async (ms) => {
          slept.push(ms);
        },
      },
    );

    const done = await pump(run.id, deps);

    expect(done.stopReason).toBe('max-pages');
    expect(slept).toEqual([700]);
  });

  it('run dari picker tersimpan sebagai run selesai dengan URL unik', async () => {
    const store = memoryStore();
    const { run, recordCount } = await savePickedRun(
      {
        url: 'https://contoh.test/lowongan',
        items: [
          { url: '/a', title: 'A', fields: {}, raw: '' },
          { url: 'https://contoh.test/a?utm_source=x', title: 'A lagi', fields: {}, raw: '' },
          { url: '/b', title: 'B', fields: {}, raw: '' },
        ],
        source: 'dom',
        selector: null,
      },
      { store, now: () => 4_000 },
    );

    expect(recordCount).toBe(2);
    expect(run).toMatchObject({
      status: 'done',
      stopReason: 'picked',
      maxPages: 1,
      finishedAt: 4_000,
    });
    expect(run.checkpoint).toMatchObject({ page: 1, itemCount: 2, nextUrl: null });
    expect(await store.countRecords(run.id)).toBe(2);
    expect(await store.getRun(run.id)).toMatchObject({ status: 'done' });
  });

  it('lease dihitung dari waktu setelah halaman selesai diambil', async () => {
    const store = memoryStore();
    let clock = 1_000;
    const run = await createRun({ startUrl: P1 }, { store, now: () => clock });

    const deps: EngineDeps = {
      store,
      owner: 'sw-a',
      leaseTtlMs: 25_000,
      now: () => clock,
      fetchPage: async () => {
        clock += 20_000; // fetch lambat menghabiskan hampir seluruh TTL
        return page([{ url: '/a' }], null);
      },
    };

    const done = await pump(run.id, deps);

    expect(done.lease).toEqual({ owner: 'sw-a', expiresAt: clock + 25_000 });
  });
});

describe('dedupe lintas-run', () => {
  const pages = {
    [P1]: page([{ url: '/a' }, { url: '/b' }], P2),
    [P2]: page([{ url: '/c' }, { url: '/d' }], P3),
    [P3]: page([{ url: '/e' }], null),
  };

  it('menandai item baru di run pertama, tidak baru di run kedua', async () => {
    const store = memoryStore();
    const first = await createRun({ startUrl: P1 }, { store });
    await pump(first.id, depsFor(store, pages));

    const firstRows = await store.listRecords(first.id);
    expect(firstRows).toHaveLength(5);
    expect(firstRows.every((row) => row.isNew)).toBe(true);

    const second = await createRun({ startUrl: P1 }, { store });
    await pump(second.id, depsFor(store, pages));

    const secondRows = await store.listRecords(second.id);
    expect(secondRows.length).toBeGreaterThan(0);
    expect(secondRows.every((row) => row.isNew)).toBe(false);
  });

  it('firstSeenAt tidak bergeser saat item muncul di run berikutnya', async () => {
    const store = memoryStore();
    const first = await createRun({ startUrl: P1 }, { store });
    await pump(first.id, depsFor(store, pages, { now: () => 1_000 }));

    const second = await createRun({ startUrl: P1 }, { store });
    await pump(second.id, depsFor(store, pages, { now: () => 9_000 }));

    expect(store.seen.get('https://contoh.test/a')).toMatchObject({
      firstSeenAt: 1_000,
      lastSeenAt: 9_000,
      lastRunId: second.id,
    });
  });

  it('berhenti cepat di halaman kedua yang isinya sudah dikenal', async () => {
    const store = memoryStore();
    const first = await createRun({ startUrl: P1 }, { store });
    await pump(first.id, depsFor(store, pages, { now: () => 1_000 }));

    const second = await createRun({ startUrl: P1 }, { store });
    const done = await pump(second.id, depsFor(store, pages, { now: () => 2_000 }));

    expect(done.stopReason).toBe('all-known');
    expect(done.checkpoint.page).toBe(2);
    // Halaman 1 tetap diambil (bukti urutan), halaman 2 memicu stop,
    // halaman 3 tidak pernah disentuh. Itemnya tetap tersimpan.
    expect(await store.countRecords(second.id)).toBe(4);
  });

  it('incremental:false tetap menelusuri semua halaman', async () => {
    const store = memoryStore();
    const first = await createRun({ startUrl: P1 }, { store });
    await pump(first.id, depsFor(store, pages, { now: () => 1_000 }));

    const second = await createRun({ startUrl: P1, incremental: false }, { store });
    const done = await pump(second.id, depsFor(store, pages, { now: () => 2_000 }));

    expect(done.stopReason).toBe('next-missing');
    expect(done.checkpoint.page).toBe(3);
    expect(await store.countRecords(second.id)).toBe(5);
  });

  it('hasil picker ikut tercatat sebagai sudah dikenal', async () => {
    const store = memoryStore();
    await savePickedRun(
      {
        url: 'https://contoh.test/lowongan',
        items: [{ url: 'https://contoh.test/a', title: 'A', fields: {}, raw: '' }],
        source: 'network',
        selector: null,
      },
      { store, now: () => 500 },
    );

    expect(await store.seenUrlKeys(['https://contoh.test/a'])).toEqual(
      new Set(['https://contoh.test/a']),
    );
  });
});

describe('perluasan halaman tanpa URL baru', () => {
  function snapshot(urls: string[], canExpand: boolean): PageSnapshot {
    return {
      items: urls.map((url) => ({ url, title: url, fields: {}, raw: '' })),
      nextUrl: null,
      source: 'dom',
      selector: null,
      canExpand,
    };
  }

  it('meminta ekspansi saat tidak ada nextUrl tapi halaman masih bisa bertambah', async () => {
    const store = memoryStore();
    const run = await createRun({ startUrl: P1 }, { store });
    const rounds: boolean[] = [];

    const deps: EngineDeps = {
      store,
      now: () => 1_000,
      owner: 'sw-a',
      fetchPage: async (_url, _run, opts) => {
        rounds.push(opts?.expand === true);
        return rounds.length === 1
          ? snapshot(['/a', '/b'], true)
          : snapshot(['/a', '/b', '/c'], false);
      },
    };

    const done = await pump(run.id, deps);

    // Fetch pertama navigasi, kedua minta isi halaman yang sama ditambah.
    expect(rounds).toEqual([false, true]);
    expect(done.stopReason).toBe('next-missing');
    expect(done.checkpoint.page).toBe(2);
    expect(await store.countRecords(run.id)).toBe(3);
  });

  it('ekspansi yang isinya sudah dikenal berhenti lebih awal (incremental aktif)', async () => {
    const store = memoryStore();
    const run = await createRun({ startUrl: P1 }, { store });

    const deps: EngineDeps = {
      store,
      now: () => 1_000,
      owner: 'sw-a',
      fetchPage: async () => snapshot(['/a'], true),
    };

    const done = await pump(run.id, deps);

    // `all-known` menang lebih dulu daripada `no-new-items`: isi halaman kedua
    // memang sudah dikenal, jadi tidak perlu menunggu tiga percobaan.
    expect(done.stopReason).toBe('all-known');
    expect(done.checkpoint.page).toBe(2);
    expect(await store.countRecords(run.id)).toBe(1);
  });

  it('tanpa incremental, ekspansi berhenti setelah tiga kali tanpa item baru', async () => {
    const store = memoryStore();
    const run = await createRun({ startUrl: P1, incremental: false }, { store });

    const deps: EngineDeps = {
      store,
      now: () => 1_000,
      owner: 'sw-a',
      fetchPage: async () => snapshot(['/a'], true),
    };

    const done = await pump(run.id, deps);

    expect(done.stopReason).toBe('no-new-items');
    expect(done.checkpoint.emptyPages).toBe(3);
    expect(await store.countRecords(run.id)).toBe(1);
  });

  it('batas tunggu ekspansi dilaporkan sebagai expand-timeout, bukan no-new-items', async () => {
    const store = memoryStore();
    const run = await createRun({ startUrl: P1 }, { store });

    const deps: EngineDeps = {
      store,
      now: () => 1_000,
      owner: 'sw-a',
      // Daftar belum sempat bertambah dalam batas waktu: itu bukan "habis".
      fetchPage: async () => ({ ...snapshot(['/a'], true), expandStatus: 'timeout' as const }),
    };

    const done = await pump(run.id, deps);

    expect(done.stopReason).toBe('expand-timeout');
    expect(done.checkpoint.page).toBe(2);
  });

  it('cursor dari respons tersimpan di checkpoint dan dipakai halaman berikutnya', async () => {
    const store = memoryStore();
    const run = await createRun({ startUrl: P1 }, { store });
    const cursors: (string | null)[] = [];

    const deps: EngineDeps = {
      store,
      now: () => 1_000,
      owner: 'sw-a',
      fetchPage: async (_url, current) => {
        // Engine meneruskan run hasil commit terakhir: cursor harus sudah ada.
        cursors.push(current.checkpoint.cursor ?? null);
        const first = cursors.length === 1;
        return {
          items: [{ url: first ? '/a' : '/b', title: 'x', fields: {}, raw: '' }],
          nextUrl: first ? 'https://contoh.test/api/feed?cursor=c2' : null,
          source: 'network',
          selector: null,
          nextCursor: first ? 'c2' : null,
        };
      },
    };

    const done = await pump(run.id, deps);

    expect(cursors).toEqual([null, 'c2']);
    expect(done.stopReason).toBe('next-missing');
  });

  it('ekspansi tetap terhitung sebagai halaman', async () => {
    const store = memoryStore();
    const run = await createRun({ startUrl: P1, maxPages: 2 }, { store });

    const deps: EngineDeps = {
      store,
      now: () => 1_000,
      owner: 'sw-a',
      fetchPage: async () => snapshot(['/a'], true),
    };

    const done = await pump(run.id, deps);

    expect(done.stopReason).toBe('max-pages');
    expect(done.checkpoint.page).toBe(2);
  });
});
