import type { RecordRow, Run, RunStatus, SeenEntry } from '@/src/shared/types';

/**
 * Kontrak penyimpanan yang dipakai run engine. Engine tidak tahu Dexie —
 * itu yang membuat state machine-nya bisa dites tanpa browser.
 */
export interface RunStore {
  getRun(id: string): Promise<Run | null>;
  putRun(run: Run): Promise<void>;
  /**
   * Menyimpan progres halaman + record-nya + riwayat `seen` dalam SATU
   * transaksi. Kalau SW mati di tengah, tidak boleh ada kondisi "checkpoint
   * maju tapi record hilang", atau "record tersimpan tapi tidak ditandai
   * pernah dilihat".
   */
  commitPage(run: Run, records: RecordRow[], seen?: SeenEntry[]): Promise<void>;
  listRecords(runId: string): Promise<RecordRow[]>;
  countRecords(runId: string): Promise<number>;
  /**
   * urlKey yang sudah tersimpan untuk run ini. Engine memakainya untuk dedupe
   * antar halaman: satu item bisa muncul di dua halaman berurutan.
   */
  listUrlKeys(runId: string): Promise<string[]>;
  /**
   * Kunci item yang sudah pernah terlihat di run MANA PUN (lintas-run). Engine
   * memakainya untuk menandai `isNew` dan untuk berhenti cepat di daftar yang
   * isinya sudah dikenal. Satu lookup per halaman, bukan memuat seluruh tabel.
   */
  seenUrlKeys(keys: string[]): Promise<Set<string>>;
  /** Dipakai saat SW bangun: run mana yang perlu dilanjutkan. */
  listRunsByStatus(statuses: RunStatus[]): Promise<Run[]>;
  listRecentRuns(limit: number): Promise<Run[]>;
  /**
   * Hapus run beserta record-nya. Tabel `seen` sengaja tidak ikut dihapus:
   * item itu tetap benar-benar pernah dilihat, jadi run berikutnya tidak
   * melaporkannya sebagai "baru" lagi.
   */
  deleteRun(runId: string): Promise<void>;
}
