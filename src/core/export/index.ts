import type { RecordRow, Run } from '@/src/shared/types';
import { toCsv } from './csv';
import { EXPORT_MIME, exportFilename, toJson, type ExportFile, type ExportFormat } from './json';

export { toCsv, columnsOf, escapeCell } from './csv';
export { toJson, exportFilename, EXPORT_MIME } from './json';
export type { ExportFile, ExportFormat } from './json';

/**
 * Batas aman di bawah limit pesan Chrome (sekitar 64 MB). Lebih dari ini,
 * pengiriman satu pesan bisa gagal setengah jalan — lebih baik ditolak dengan
 * pesan jelas daripada panel diam tanpa penjelasan.
 */
export const MAX_EXPORT_BYTES = 32 * 1024 * 1024;

export class ExportTooLargeError extends Error {
  constructor(public readonly bytes: number) {
    super(
      `Hasil terlalu besar untuk diekspor sekaligus (${Math.round(bytes / 1024 / 1024)} MB). ` +
        'Pecah run-nya atau ekspor JSON.',
    );
    this.name = 'ExportTooLargeError';
  }
}

export function buildExport(
  run: Run,
  records: RecordRow[],
  format: ExportFormat,
  at: Date = new Date(),
): ExportFile {
  const content = format === 'csv' ? toCsv(records) : toJson(records, run, at);

  // Blob menyimpan byte UTF-8, jadi ukuran harus dihitung dari situ, bukan
  // dari `content.length` (yang menghitung karakter).
  const bytes = new TextEncoder().encode(content).length;
  if (bytes > MAX_EXPORT_BYTES) throw new ExportTooLargeError(bytes);

  return {
    filename: exportFilename(run, format, at),
    mime: EXPORT_MIME[format],
    content,
    count: records.length,
  };
}
