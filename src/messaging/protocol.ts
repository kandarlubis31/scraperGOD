import { z } from 'zod';
import {
  ApiPlanSchema,
  PageItemSchema,
  SourceKindSchema,
  type ApiPlan,
  type Run,
} from '@/src/shared/types';

/**
 * Protokol pesan SW ↔ UI ↔ content script. Semua request divalidasi sebelum
 * dipakai: pesan bisa datang dari tab mana pun, jadi bentuknya tidak dipercaya.
 */

export const StartRunRequestSchema = z.object({
  type: z.literal('run:start'),
  tabId: z.number().int().nonnegative(),
  maxPages: z.number().int().min(1).max(200).optional(),
  maxItems: z.number().int().min(1).max(10_000).optional(),
  /** Izinkan SW memuat ulang halaman sekali untuk merekam API situs. */
  captureApi: z.boolean().optional(),
  /** Berhenti saat halaman isinya sudah dikenal (daftar terbaru-dulu). */
  incremental: z.boolean().optional(),
});

/** Picker menyimpan pilihannya sebagai run, supaya bisa dipratinjau & diekspor. */
export const SavePickRequestSchema = z.object({
  type: z.literal('pick:save'),
  page: z.object({
    url: z.string().min(1),
    title: z.string().default(''),
    source: SourceKindSchema.default('dom'),
    selector: z.string().nullable().default(null),
    items: z.array(PageItemSchema).min(1).max(2000),
  }),
});

/**
 * "Ambil + lanjut halaman": halaman yang dipilih disimpan dulu, lalu run tetap
 * `queued` supaya pagination melanjutkan sampai target tercapai.
 */
export const PickRunRequestSchema = z.object({
  type: z.literal('pick:run'),
  page: z.object({
    url: z.string().min(1),
    title: z.string().default(''),
    source: SourceKindSchema.default('dom'),
    /** Selector item hasil picker; halaman berikutnya memakai set yang sama. */
    itemSelector: z.string().nullable().default(null),
    container: z.string().nullable().default(null),
    items: z.array(PageItemSchema).min(1).max(2000),
    target: z.number().int().min(1).max(5000),
  }),
});

export const GetRunRequestSchema = z.object({
  type: z.literal('run:get'),
  runId: z.string().min(1),
});

export const StopRunRequestSchema = z.object({
  type: z.literal('run:stop'),
  runId: z.string().min(1),
});

export const ResumeRunRequestSchema = z.object({
  type: z.literal('run:resume'),
  runId: z.string().min(1),
});

export const PreviewRequestSchema = z.object({
  type: z.literal('records:preview'),
  runId: z.string().min(1),
  limit: z.number().int().min(1).max(500).optional(),
  /** Hanya record yang belum pernah terlihat di run sebelumnya. */
  onlyNew: z.boolean().optional(),
});

export const RecentRunsRequestSchema = z.object({
  type: z.literal('run:recent'),
});

export const ExportRunRequestSchema = z.object({
  type: z.literal('run:export'),
  runId: z.string().min(1),
  format: z.enum(['csv', 'json']),
  /** Hanya record yang belum pernah terlihat di run sebelumnya. */
  onlyNew: z.boolean().optional(),
});

/** Semua record run, untuk salin ke klipboard (bukan hanya 50 baris pratinjau). */
export const AllRecordsRequestSchema = z.object({
  type: z.literal('records:all'),
  runId: z.string().min(1),
  onlyNew: z.boolean().optional(),
});

/** Hapus run beserta record-nya. Riwayat `seen` sengaja dipertahankan. */
export const DeleteRunRequestSchema = z.object({
  type: z.literal('run:delete'),
  runId: z.string().min(1),
});

export const ProbeTabRequestSchema = z.object({
  type: z.literal('probe:tab'),
  tabId: z.number().int().nonnegative(),
});

export const RequestSchema = z.discriminatedUnion('type', [
  StartRunRequestSchema,
  SavePickRequestSchema,
  PickRunRequestSchema,
  GetRunRequestSchema,
  StopRunRequestSchema,
  ResumeRunRequestSchema,
  PreviewRequestSchema,
  ExportRunRequestSchema,
  AllRecordsRequestSchema,
  DeleteRunRequestSchema,
  RecentRunsRequestSchema,
  ProbeTabRequestSchema,
]);

export type Request = z.infer<typeof RequestSchema>;

/** Pesan dari SW ke content script (tab). */
export interface TabProbeResponse {
  url: string;
  title: string;
  notes: string[];
  candidates: {
    source: string;
    label: string;
    itemCount: number;
    score: number;
  }[];
  best: {
    source: string;
    label: string;
    itemCount: number;
  } | null;
  /** Rencana pengambilan lewat API; null = pakai DOM/Tab. */
  api: ApiPlan | null;
  /** Jumlah capture JSON yang sedang dipegang content script. */
  captures: number;
}

export const TabProbeResponseApiSchema = ApiPlanSchema.nullable();

export interface RunSnapshot {
  run: Run;
  recordCount: number;
}

export type ApiResponse<T> = { ok: true; data: T } | { ok: false; error: string };

export const MESSAGE = {
  togglePicker: 'toggle-picker',
  probe: 'scrapergod:probe',
  fetchPage: 'scrapergod:fetch-page',
  armNet: 'scrapergod:net-arm',
  disarmNet: 'scrapergod:net-disarm',
  replayNet: 'scrapergod:net-replay',
  /** Nilai token asli dari request terbaru, untuk mengisi placeholder ApiPlan. */
  netSecrets: 'scrapergod:net-secrets',
  /** Laporan diagnosa pagination dari tab aktif. */
  diagnose: 'scrapergod:diagnose',
  /** Status picker tanpa mengubahnya; dipakai popup dan panel untuk label tombol. */
  pickerState: 'scrapergod:picker-state',
} as const;

export interface TabReplayResponse {
  ok: boolean;
  status: number;
  url: string;
  body: string;
  truncated: boolean;
  error?: string;
}
