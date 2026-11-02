import type { RecordRow } from '@/src/shared/types';

/**
 * Export tidak boleh mengubah data: nilai ditulis apa adanya, hanya di-quote
 * sesuai RFC 4180. Kalau ada yang \"dirapikan\" di sini, angka dan teks gaji
 * berubah diam-diam dan hasilnya tidak bisa diaudit lagi.
 */

export const CSV_BOM = '\uFEFF';

/** Selalu ada, urutannya tetap, supaya kolom tidak bergeser antar export. */
const LEADING_COLUMNS = ['url', 'title', 'sumber'] as const;

export function escapeCell(value: string): string {
  if (/[",\r\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

export function recordValue(record: RecordRow, column: string): string {
  if (column === 'url') return record.url;
  if (column === 'title') return record.title;
  if (column === 'sumber') return record.provenance.source;
  return record.fields[column] ?? '';
}

/** Kolom = kolom tetap + gabungan field, urut kemunculan pertama. */
export function columnsOf(records: RecordRow[]): string[] {
  const columns = [...LEADING_COLUMNS] as string[];
  const seen = new Set(columns);
  for (const record of records) {
    for (const key of Object.keys(record.fields)) {
      if (seen.has(key)) continue;
      seen.add(key);
      columns.push(key);
    }
  }
  return columns;
}

export interface CsvOptions {
  /** Tanpa BOM, Excel di Windows membaca UTF-8 sebagai Latin-1 dan 'é' rusak. */
  bom?: boolean;
}

export function toCsv(records: RecordRow[], options: CsvOptions = {}): string {
  const { bom = true } = options;
  const columns = columnsOf(records);
  const lines = [columns.map(escapeCell).join(',')];

  for (const record of records) {
    lines.push(columns.map((column) => escapeCell(recordValue(record, column))).join(','));
  }

  // CRLF: yang paling aman untuk Excel, Numbers, dan Google Sheets.
  return (bom ? CSV_BOM : '') + lines.join('\r\n') + '\r\n';
}
