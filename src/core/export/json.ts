import type { RecordRow, Run } from '@/src/shared/types';

export type ExportFormat = 'csv' | 'json';

export interface ExportFile {
  filename: string;
  mime: string;
  content: string;
  count: number;
}

/** Nama file aman: hanya huruf/angka/dash, supaya tidak ditolak OS mana pun. */
export function slugify(value: string, maxLength = 40): string {
  const slug = value
    .normalize('NFKD')
    .replace(/[^\w\s.-]/g, '')
    .trim()
    // Titik ikut jadi dash: `contoh.test` harus terbaca sebagai dua kata.
    .replace(/[.\s_-]+/g, '-')
    .replace(/-+/g, '-')
    .toLowerCase()
    .slice(0, maxLength)
    .replace(/^-|-$/g, '');
  return slug || 'hasil';
}

function stamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
  ].join('') + `-${pad(date.getHours())}${pad(date.getMinutes())}`;
}

export function hostLabel(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return 'hasil';
  }
}

export function exportFilename(run: Run, format: ExportFormat, at: Date): string {
  return `${slugify(hostLabel(run.startUrl))}-${stamp(at)}.${format}`;
}

export interface JsonExport {
  exportedAt: string;
  run: {
    id: string;
    startUrl: string;
    status: Run['status'];
    stopReason: Run['stopReason'];
    maxPages: number;
    itemCount: number;
  };
  count: number;
  records: RecordRow[];
}

/**
 * JSON memuat `raw` dan `provenance` per baris: itu satu-satunya bentuk yang
 * bisa diproses ulang kalau normalisasi berubah di kemudian hari.
 */
export function toJson(records: RecordRow[], run: Run, at: Date): string {
  const payload: JsonExport = {
    exportedAt: at.toISOString(),
    run: {
      id: run.id,
      startUrl: run.startUrl,
      status: run.status,
      stopReason: run.stopReason,
      maxPages: run.maxPages,
      itemCount: run.checkpoint.itemCount,
    },
    count: records.length,
    records,
  };
  return JSON.stringify(payload, null, 2);
}

export const EXPORT_MIME: Record<ExportFormat, string> = {
  csv: 'text/csv;charset=utf-8',
  json: 'application/json;charset=utf-8',
};
