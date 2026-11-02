import { z } from 'zod';

/**
 * Satu sumber kebenaran untuk bentuk data yang melintasi SW, UI, dan DB.
 * Semua yang masuk dari content script / adapter divalidasi di sini.
 */

export const SourceKindSchema = z.enum(['network', 'embedded', 'dom']);
export type SourceKind = z.infer<typeof SourceKindSchema>;

export const RunStatusSchema = z.enum([
  'queued',
  'running',
  'paused',
  'stopped',
  'done',
  'failed',
]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const StopReasonSchema = z.enum([
  'next-missing',
  'max-pages',
  'max-items',
  'duplicate-page',
  'no-new-items',
  'all-known',
  'expand-timeout',
  'expand-blocked',
  'picked',
  'stopped',
  'error',
]);
export type StopReason = z.infer<typeof StopReasonSchema>;

/** Dari mana satu nilai diambil. Dipakai untuk audit, bukan hiasan. */
export const ProvenanceSchema = z.object({
  source: SourceKindSchema,
  pageUrl: z.string(),
  selector: z.string().nullable(),
  adapter: z.string().nullable(),
  capturedAt: z.number().int().nonnegative(),
});
export type Provenance = z.infer<typeof ProvenanceSchema>;

export const RecordRowSchema = z.object({
  /** `${runId}:${urlKey}` — idempoten, jadi simpan ulang tidak menambah baris. */
  id: z.string().min(1),
  runId: z.string().min(1),
  urlKey: z.string().min(1),
  url: z.string(),
  title: z.string(),
  fields: z.record(z.string(), z.string()),
  /** Nilai mentah (JSON/teks) sebelum normalisasi, untuk re-process. */
  raw: z.string(),
  provenance: ProvenanceSchema,
  /**
   * Belum pernah terlihat di run mana pun sebelum run ini. Dihitung dari tabel
   * `seen` saat record dibuat, jadi tetap benar untuk run yang dilanjutkan
   * setelah SW mati.
   */
  isNew: z.boolean().default(false),
  firstSeenAt: z.number().int().nonnegative(),
  lastSeenAt: z.number().int().nonnegative(),
});
export type RecordRow = z.infer<typeof RecordRowSchema>;

/**
 * Riwayat lintas-run: satu baris per item yang sudah pernah diambil.
 *
 * Sengaja tidak menyalin record: yang disimpan hanya identitas item, jadi
 * tabel ini tetap kecil walau ada ratusan ribu record.
 */
export const SeenEntrySchema = z.object({
  /** Sama dengan `urlKey` — identitas item, unik lintas run dan lintas situs. */
  id: z.string().min(1),
  /** Daftar asal (origin + path tanpa query), untuk statistik dan hapus per situs. */
  siteKey: z.string().min(1),
  urlKey: z.string().min(1),
  /** Kapan item ini PERTAMA terlihat; tidak pernah ditimpa. */
  firstSeenAt: z.number().int().nonnegative(),
  lastSeenAt: z.number().int().nonnegative(),
  lastRunId: z.string().min(1),
});
export type SeenEntry = z.infer<typeof SeenEntrySchema>;

export const CheckpointSchema = z.object({
  /** URL halaman berikutnya; null berarti sudah tidak ada lanjutan. */
  nextUrl: z.string().nullable(),
  page: z.number().int().nonnegative(),
  itemCount: z.number().int().nonnegative(),
  /** Sidik jari halaman terakhir, untuk mendeteksi pagination yang berputar. */
  lastFingerprint: z.string().nullable(),
  /**
   * Halaman berurutan yang tidak menambah record baru. Disimpan di checkpoint
   * supaya tetap terhitung setelah SW mati lalu run dilanjutkan.
   */
  emptyPages: z.number().int().nonnegative().default(0),
  /**
   * Halaman berurutan yang isinya sudah dikenal dari run sebelumnya. Dipakai
   * untuk berhenti cepat di daftar yang urutannya terbaru-dulu.
   */
  seenPages: z.number().int().nonnegative().default(0),
  /**
   * Fetch berikutnya adalah percobaan memperluas halaman yang sama (tombol
   * "muat lebih banyak" / scroll), bukan navigasi ke URL lain.
   */
  expand: z.boolean().default(false),
  /**
   * Cursor halaman terakhir yang diterima. Disimpan di checkpoint supaya run
   * yang dilanjutkan setelah SW mati memakai cursor yang sama, bukan menebak.
   */
  cursor: z.string().nullable().default(null),
});
export type Checkpoint = z.infer<typeof CheckpointSchema>;

export const LeaseSchema = z.object({
  owner: z.string().min(1),
  expiresAt: z.number().int().nonnegative(),
});
export type Lease = z.infer<typeof LeaseSchema>;

/**
 * Rencana mengambil halaman lewat API situs, bukan lewat DOM. Disimpan di run
 * supaya setelah SW mati tidak perlu menebak ulang dari halaman.
 */
export const FieldMappingSchema = z.object({
  title: z.string().nullable(),
  url: z.string().nullable(),
  company: z.string().nullable(),
  location: z.string().nullable(),
  salary: z.string().nullable(),
  date: z.string().nullable(),
  description: z.string().nullable(),
});
export type FieldMapping = z.infer<typeof FieldMappingSchema>;

export const ApiPlanSchema = z.object({
  /** URL request halaman pertama, apa adanya dari capture. */
  url: z.string().min(1),
  method: z.string().default('GET'),
  /**
   * Body request POST/GraphQL apa adanya. Sengaja HANYA body: cookie,
   * Authorization, dan token tidak pernah ikut direkam ke DB.
   */
  bodyTemplate: z.string().nullable().default(null),
  /** Path field halaman di body, mis. `page`, `offset`, `variables.page`. */
  bodyPageParam: z.string().nullable().default(null),
  /** Hanya content-type yang disimpan; header lain tidak pernah direkam. */
  contentType: z.string().nullable().default(null),
  /** Nama field cursor di request (`cursor`, `after`, `variables.after`). */
  cursorParam: z.string().nullable().default(null),
  /** Cursor dikirim lewat query string atau di dalam body JSON. */
  cursorKind: z.enum(['query', 'body']).nullable().default(null),
  /** Path array item di dalam JSON; '' berarti root. */
  arrayPath: z.string(),
  mapping: FieldMappingSchema,
  /**
   * Kolom non-kanonik yang ikut disimpan: `year`, `rating`, `genre`, ...
   * Default kosong supaya rencana lama di DB tetap lolos parse.
   */
  extraFields: z.record(z.string(), z.string()).default({}),
  /** Nama parameter pagination; null = tidak ada lanjutan yang bisa dibangun. */
  pageParam: z.string().nullable(),
  /** `page` = 1,2,3 · `offset` = 0,20,40. */
  pageKind: z.enum(['page', 'offset']),
  /** Nilai parameter di halaman pertama yang tertangkap. */
  pageValue: z.number().int(),
  pageSize: z.number().int().positive().nullable(),
  /** Total item menurut situs, kalau dinyatakan. */
  total: z.number().int().nonnegative().nullable(),
  /**
   * Rencana ini sudah diperiksa (2 request pembanding). Disimpan supaya
   * resume setelah SW mati tidak mengirim request verifikasi lagi.
   */
  verified: z.boolean().default(false),
  /** Catatan hasil verifikasi (mis. sebagian item halaman 2 berulang). */
  verifyNote: z.string().nullable().default(null),
});
export type ApiPlan = z.infer<typeof ApiPlanSchema>;

export const RunSchema = z.object({
  id: z.string().min(1),
  status: RunStatusSchema,
  startUrl: z.string().min(1),
  /** Tab yang dipakai untuk navigasi pagination; null = run tanpa tab (mis. replay API). */
  tabId: z.number().int().nonnegative().nullable().default(null),
  maxPages: z.number().int().positive(),
  maxItems: z.number().int().positive(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  finishedAt: z.number().int().nonnegative().nullable(),
  checkpoint: CheckpointSchema,
  lease: LeaseSchema.nullable(),
  lastError: z.string().nullable(),
  stopReason: StopReasonSchema.nullable(),
  /**
   * Berhenti saat halaman isinya sudah dikenal semua. Bisa dimatikan karena
   * situs tidak selalu mengurutkan daftar dari yang terbaru.
   */
  incremental: z.boolean().default(true),
  /** Ada = halaman diambil lewat API situs, bukan dengan navigasi tab. */
  api: ApiPlanSchema.nullable().default(null),
  /**
   * Selector item hasil picker. Disimpan di run supaya halaman berikutnya (dan
   * run yang dilanjutkan setelah SW mati) memakai daftar item yang sama.
   */
  selector: z.string().nullable().default(null),
  /** Selector container daftar hasil picker. */
  container: z.string().nullable().default(null),
});
export type Run = z.infer<typeof RunSchema>;

export const PageItemSchema = z.object({
  url: z.string(),
  title: z.string().default(''),
  fields: z.record(z.string(), z.string()).default({}),
  /** Serialisasi JSON/teks asli dari sumber, untuk re-process nanti. */
  raw: z.string().default(''),
});
export type PageItem = z.infer<typeof PageItemSchema>;

/** Satu halaman hasil ambil, dari sumber mana pun. */
export const PageSnapshotSchema = z.object({
  items: z.array(PageItemSchema),
  /** null = tidak ada halaman berikutnya. */
  nextUrl: z.string().nullable(),
  source: SourceKindSchema,
  selector: z.string().nullable().default(null),
  /**
   * Masih bisa bertambah walau tidak ada URL berikutnya: ada tombol "muat
   * lebih banyak", atau halaman masih bisa di-scroll (infinite scroll).
   */
  canExpand: z.boolean().optional(),
  /** Hasil percobaan memperluas halaman (klik "muat lebih" / scroll). */
  expandStatus: z.enum(['grown', 'unchanged', 'timeout']).optional(),
  /** Cursor untuk request berikutnya, dari respons halaman ini. */
  nextCursor: z.string().nullable().optional(),
  /** Catatan non-fatal: pemicu yang dilewati, daftar yang mungkin virtualized. */
  notes: z.array(z.string()).optional(),
});
export type PageSnapshot = z.infer<typeof PageSnapshotSchema>;

export const PAGE_SNAPSHOT_LIMITS = {
  maxItemsPerPage: 500,
} as const;
