import { describe, expect, it } from 'vitest';
import { pump, startPickRun } from '@/src/core/run/engine';
import type { RunStore } from '@/src/core/store/types';
import type { PageItem, PageSnapshot, RecordRow, Run, SeenEntry } from '@/src/shared/types';

function memoryStore(): RunStore {
  const runs = new Map<string, Run>();
  const records = new Map<string, RecordRow>();
  const seen = new Map<string, SeenEntry>();
  return {
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
      return [...records.values()].filter((row) => row.runId === runId).map((row) => row.urlKey);
    },
    async seenUrlKeys(keys) {
      return new Set([...new Set(keys)].filter((key) => seen.has(key)));
    },
    async listRunsByStatus(statuses) {
      return [...runs.values()].filter((run) => statuses.includes(run.status));
    },
    async listRecentRuns(limit) {
      return [...runs.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit);
    },
    async deleteRun(runId) {
      runs.delete(runId);
      for (const [id, row] of records) if (row.runId === runId) records.delete(id);
    },
  };
}

function pageItems(start: number, size = 20): PageItem[] {
  return Array.from({ length: size }, (_, index) => ({
    url: `https://contoh.test/item/${start + index}`,
    title: `Item ${start + index}`,
    fields: {},
    raw: '',
  }));
}

describe('startPickRun', () => {
  it('berhenti tepat di target saat halaman berikutnya menambah item', async () => {
    const store = memoryStore();
    const { run } = await startPickRun(
      {
        url: 'https://contoh.test/daftar',
        items: pageItems(0),
        target: 50,
        selector: '.card-row',
      },
      { store, now: () => 1_000 },
    );

    let calls = 0;
    const result = await pump(run.id, {
      store,
      now: () => 2_000,
      fetchPage: async () => {
        const start = calls * 20;
        calls += 1;
        return {
          items: pageItems(start),
          nextUrl: `https://contoh.test/daftar?page=${calls + 1}`,
          source: 'dom',
          selector: '.card-row',
        } satisfies PageSnapshot;
      },
    });

    expect(result.status).toBe('done');
    expect(result.stopReason).toBe('max-items');
    // 20 item sudah tersimpan dari picker; 50 total, bukan 60 dari tiga halaman.
    expect(result.checkpoint.itemCount).toBe(50);
    expect(await store.countRecords(run.id)).toBe(50);
  });

  it('target lebih kecil dari halaman ini: tepat M teratas tanpa pagination', async () => {
    const store = memoryStore();
    const { run, recordCount } = await startPickRun(
      { url: 'https://contoh.test/daftar', items: pageItems(0), target: 5 },
      { store, now: () => 1_000 },
    );

    expect(run.status).toBe('done');
    expect(run.stopReason).toBe('max-items');
    expect(run.checkpoint.itemCount).toBe(5);
    expect(recordCount).toBe(5);

    const rows = await store.listRecords(run.id);
    expect(rows.map((row) => row.title)).toEqual([
      'Item 0',
      'Item 1',
      'Item 2',
      'Item 3',
      'Item 4',
    ]);
  });

  it('menyimpan selector picker dan memakainya lagi saat run dilanjutkan', async () => {
    const store = memoryStore();
    const { run } = await startPickRun(
      {
        url: 'https://contoh.test/daftar',
        items: pageItems(0),
        target: 40,
        selector: '.job-card',
        container: '.job-list',
      },
      { store, now: () => 1_000 },
    );

    expect(run.selector).toBe('.job-card');
    expect(run.container).toBe('.job-list');

    const received: Run[] = [];
    await pump(run.id, {
      store,
      now: () => 2_000,
      fetchPage: async (_url, current) => {
        received.push(current);
        return {
          items: pageItems(20),
          nextUrl: null,
          source: 'dom',
          selector: '.job-card',
        } satisfies PageSnapshot;
      },
    });

    // Resume memakai run yang sama dari Dexie, jadi selector harus ikut.
    expect(received[0]?.selector).toBe('.job-card');
    expect(received[0]?.container).toBe('.job-list');
  });
});
