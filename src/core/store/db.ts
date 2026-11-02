import Dexie, { type Table } from 'dexie';
import type { RecordRow, Run, RunStatus, SeenEntry } from '@/src/shared/types';
import { siteKey } from '@/src/shared/url';
import type { RunStore } from './types';

/** Satu sumber nama: dipakai manifest, atribut DOM, key pesan, dan alarm. */
export const DB_NAME = 'scrapergod';

/** Nama database sebelum rename. Dibaca sekali lalu dihapus. */
export const LEGACY_DB_NAMES = ['scraperkit'] as const;

/**
 * Satu database untuk runs, records, dan (nanti) recipe/adapter/settings.
 *
 * Catatan penting: IndexedDB dari content script masuk ke origin SITUS, bukan
 * origin ekstensi. Jadi semua baca-tulis lewat SW — content script hanya
 * mengirim pesan.
 */
export class ScraperGodDB extends Dexie {
  runs!: Table<Run, string>;
  records!: Table<RecordRow, string>;
  seen!: Table<SeenEntry, string>;

  constructor(name = DB_NAME) {
    super(name);
    this.version(1).stores({
      runs: 'id, status, updatedAt',
      records: 'id, runId, [runId+urlKey], firstSeenAt',
    });
    // v2: riwayat "sudah pernah dilihat" lintas-run. Dexie menaikkan versi
    // tanpa menyentuh data lama, jadi run yang sedang berjalan tetap utuh.
    this.version(2).stores({
      runs: 'id, status, updatedAt',
      records: 'id, runId, [runId+urlKey], firstSeenAt',
      seen: 'id, siteKey, lastSeenAt',
    });
  }
}

export class DexieRunStore implements RunStore {
  constructor(private readonly db: ScraperGodDB) {}

  async getRun(id: string): Promise<Run | null> {
    return (await this.db.runs.get(id)) ?? null;
  }

  async putRun(run: Run): Promise<void> {
    await this.db.runs.put(run);
  }

  async commitPage(run: Run, records: RecordRow[], seen: SeenEntry[] = []): Promise<void> {
    await this.db.transaction('rw', this.db.runs, this.db.records, this.db.seen, async () => {
      if (records.length > 0) await this.db.records.bulkPut(records);
      if (seen.length > 0) {
        const existing = await this.db.seen.bulkGet(seen.map((entry) => entry.id));
        // firstSeenAt baris pertama yang menang: "kapan item ini pertama
        // terlihat" tidak boleh bergeser hanya karena item muncul lagi.
        await this.db.seen.bulkPut(
          seen.map((entry, index) => ({
            ...entry,
            firstSeenAt: existing[index]?.firstSeenAt ?? entry.firstSeenAt,
          })),
        );
      }
      await this.db.runs.put(run);
    });
  }

  async listRecords(runId: string): Promise<RecordRow[]> {
    return this.db.records.where('runId').equals(runId).toArray();
  }

  async countRecords(runId: string): Promise<number> {
    return this.db.records.where('runId').equals(runId).count();
  }

  async listUrlKeys(runId: string): Promise<string[]> {
    const rows = await this.db.records.where('runId').equals(runId).toArray();
    return rows.map((row) => row.urlKey);
  }

  async seenUrlKeys(keys: string[]): Promise<Set<string>> {
    const unique = [...new Set(keys.filter((key) => key.length > 0))];
    if (unique.length === 0) return new Set();
    const rows = await this.db.seen.bulkGet(unique);
    const found = new Set<string>();
    rows.forEach((row, index) => {
      if (row) found.add(unique[index]!);
    });
    return found;
  }

  async listRunsByStatus(statuses: RunStatus[]): Promise<Run[]> {
    if (statuses.length === 0) return [];
    return this.db.runs.where('status').anyOf(statuses).toArray();
  }

  async listRecentRuns(limit: number): Promise<Run[]> {
    return this.db.runs.orderBy('updatedAt').reverse().limit(limit).toArray();
  }

  async deleteRun(runId: string): Promise<void> {
    await this.db.transaction('rw', this.db.runs, this.db.records, async () => {
      await this.db.records.where('runId').equals(runId).delete();
      await this.db.runs.delete(runId);
    });
  }
}

export interface MigrationResult {
  migrated: boolean;
  from: string | null;
  runs: number;
  records: number;
}

/**
 * Membaca seluruh object store dari database lama lewat IndexedDB mentah.
 * Sengaja tidak memakai Dexie: skema lama tidak perlu dideklarasikan ulang, dan
 * `getAll` tidak butuh index.
 */
async function readLegacyStore(name: string): Promise<Map<string, unknown[]>> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(name);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error(`Database ${name} sedang diblokir.`));
  });

  try {
    const contents = new Map<string, unknown[]>();
    for (const storeName of Array.from(db.objectStoreNames)) {
      contents.set(
        storeName,
        await new Promise<unknown[]>((resolve, reject) => {
          const tx = db.transaction(storeName, 'readonly');
          const request = tx.objectStore(storeName).getAll();
          request.onsuccess = () => resolve(request.result as unknown[]);
          request.onerror = () => reject(request.error);
        }),
      );
    }
    return contents;
  } finally {
    db.close();
  }
}

/**
 * Menyalin isi database lama ke `target` dalam satu transaksi, lalu menghapus
 * database lama. Urutannya penting: kalau penyalinan gagal, database lama
 * dibiarkan utuh sehingga percobaan berikutnya masih punya sumber.
 *
 * Idempoten: karena memakai `bulkPut` dengan primary key yang sama, memanggilnya
 * dua kali tidak menghasilkan baris ganda.
 */
export async function migrateLegacyDatabase(
  target: ScraperGodDB,
  legacyNames: readonly string[] = LEGACY_DB_NAMES,
): Promise<MigrationResult> {
  const empty: MigrationResult = { migrated: false, from: null, runs: 0, records: 0 };

  for (const name of legacyNames) {
    if (name === target.name) continue;
    if (!(await Dexie.exists(name))) continue;

    const contents = await readLegacyStore(name);
    const runs = (contents.get('runs') ?? []) as Run[];
    const records = (contents.get('records') ?? []) as RecordRow[];
    // Database v1 belum punya tabel `seen`; riwayatnya diturunkan dari record
    // yang dimigrasikan supaya item lama tidak dilaporkan "baru" lagi.
    const legacySeen = (contents.get('seen') ?? []) as SeenEntry[];
    const seen =
      legacySeen.length > 0
        ? legacySeen
        : records.map((record) => ({
            id: record.urlKey,
            siteKey: siteKey(record.url) || record.urlKey,
            urlKey: record.urlKey,
            firstSeenAt: record.firstSeenAt,
            lastSeenAt: record.lastSeenAt,
            lastRunId: record.runId,
          }));

    await target.transaction('rw', target.runs, target.records, target.seen, async () => {
      if (runs.length > 0) await target.runs.bulkPut(runs);
      if (records.length > 0) await target.records.bulkPut(records);
      if (seen.length > 0) await target.seen.bulkPut(seen);
    });

    await Dexie.delete(name);
    return { migrated: true, from: name, runs: runs.length, records: records.length };
  }

  return empty;
}
