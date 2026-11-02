import Dexie from 'dexie';
import { describe, expect, it } from 'vitest';
import {
  DexieRunStore,
  ScraperGodDB,
  migrateLegacyDatabase,
} from '@/src/core/store/db';
import { createRun, pump } from '@/src/core/run/engine';
import type { PageSnapshot } from '@/src/shared/types';

let counter = 0;
function freshDb(): { db: ScraperGodDB; store: DexieRunStore } {
  counter += 1;
  const db = new ScraperGodDB(`scrapergod-test-${counter}-${Math.random().toString(36).slice(2, 7)}`);
  return { db, store: new DexieRunStore(db) };
}

const P1 = 'https://contoh.test/list?page=1';
const P2 = 'https://contoh.test/list?page=2';

function page(urls: string[], next: string | null): PageSnapshot {
  return {
    items: urls.map((url) => ({ url, title: url, fields: {}, raw: '' })),
    nextUrl: next,
    source: 'dom',
    selector: null,
  };
}

describe('Dexie store', () => {
  it('commitPage menyimpan run dan record sekaligus', async () => {
    const { db, store } = freshDb();
    const run = await createRun({ startUrl: P1 }, { store, now: () => 10 });
    const records = [
      {
        id: `${run.id}:a`,
        runId: run.id,
        urlKey: 'https://contoh.test/a',
        url: 'https://contoh.test/a',
        title: 'A',
        fields: {},
        raw: '',
        provenance: {
          source: 'dom' as const,
          pageUrl: P1,
          selector: null,
          adapter: null,
          capturedAt: 10,
        },
        firstSeenAt: 10,
        lastSeenAt: 10,
        isNew: true,
      },
    ];

    await store.commitPage({ ...run, status: 'running' }, records);

    expect(await store.getRun(run.id)).toMatchObject({ status: 'running' });
    expect(await store.countRecords(run.id)).toBe(1);
    expect(await store.listRecords(run.id)).toHaveLength(1);
    db.close();
  });

  it('data tetap ada setelah koneksi DB ditutup dan dibuka ulang', async () => {
    const { db, store } = freshDb();
    const run = await createRun({ startUrl: P1 }, { store });
    await pump(run.id, {
      store,
      now: () => 100,
      fetchPage: async () => page(['/a', '/b'], P2),
    });
    const name = db.name;
    db.close();

    const reopened = new ScraperGodDB(name);
    const store2 = new DexieRunStore(reopened);
    expect(await store2.getRun(run.id)).toMatchObject({ status: 'done' });
    expect(await store2.countRecords(run.id)).toBe(2);
    reopened.close();
  });

  it('resume setelah crash tidak menambah baris ganda', async () => {
    const { db, store } = freshDb();
    const run = await createRun({ startUrl: P1 }, { store });

    let fail = true;
    const flaky = {
      store,
      now: () => 200,
      fetchPage: async (url: string): Promise<PageSnapshot> => {
        if (url === P2 && fail) {
          fail = false;
          throw new Error('SW terminated');
        }
        return url === P1 ? page(['/a', '/b'], P2) : page(['/b', '/c'], null);
      },
    };

    const paused = await pump(run.id, flaky);
    expect(paused.status).toBe('paused');
    expect(await store.countRecords(run.id)).toBe(2);

    db.close();
    const reopened = new ScraperGodDB(db.name);
    const store2 = new DexieRunStore(reopened);

    const done = await pump(run.id, { ...flaky, store: store2 });
    expect(done.status).toBe('done');
    expect(await store2.countRecords(run.id)).toBe(3);
    reopened.close();
  });

  it('memindahkan isi database lama ke nama baru lalu menghapus yang lama', async () => {
    counter += 1;
    // DB lama punya skema yang sama; hanya namanya berbeda.
    const legacyName = `scrapekit-legacy-${counter}`;
    const legacy = new ScraperGodDB(legacyName);
    const legacyStore = new DexieRunStore(legacy);
    const run = await createRun({ startUrl: P1 }, { store: legacyStore, now: () => 50 });
    await pump(run.id, {
      store: legacyStore,
      now: () => 60,
      fetchPage: async () => page(['/a', '/b'], null),
    });
    legacy.close();

    const target = new ScraperGodDB(`scrapergod-migrate-${counter}`);
    const store2 = new DexieRunStore(target);

    const result = await migrateLegacyDatabase(target, [legacyName]);
    expect(result).toEqual({ migrated: true, from: legacyName, runs: 1, records: 2 });
    expect(await store2.getRun(run.id)).toMatchObject({ status: 'done' });
    expect(await store2.countRecords(run.id)).toBe(2);
    expect(await Dexie.exists(legacyName)).toBe(false);

    // Panggilan kedua tidak menemukan apa pun untuk dimigrasikan.
    expect((await migrateLegacyDatabase(target, [legacyName])).migrated).toBe(false);
    expect(await store2.countRecords(run.id)).toBe(2);
    target.close();
  });

  it('riwayat seen tersimpan dan dipakai run berikutnya', async () => {
    const { db, store } = freshDb();
    const first = await createRun({ startUrl: P1 }, { store });
    await pump(first.id, {
      store,
      now: () => 100,
      fetchPage: async () => page(['/a', '/b'], null),
    });

    expect(await store.seenUrlKeys(['https://contoh.test/a'])).toEqual(
      new Set(['https://contoh.test/a']),
    );

    const second = await createRun({ startUrl: P1 }, { store });
    await pump(second.id, {
      store,
      now: () => 200,
      fetchPage: async () => page(['/a', '/b'], null),
    });

    const rows = await store.listRecords(second.id);
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.isNew)).toBe(false);
    db.close();
  });
});
