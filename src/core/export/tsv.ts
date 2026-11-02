import type { RecordRow } from '@/src/shared/types';

/**
 * Salin ke klipboard: TSV untuk Sheets/Excel (tempel langsung jadi kolom), dan
 * HTML table untuk Google Docs/Word/Notion (tempel jadi tabel, bukan teks
 * bertab). Keduanya dibangun dari kolom yang SEDANG terlihat di panel, jadi
 * hasil salin selalu sama dengan yang dilihat user — termasuk kolom hasil
 * rename dan urutan yang sudah diatur.
 */

export interface ExportColumn {
  key: string;
  label: string;
}

/** Kolom audit yang selalu ikut: dari mana nilai itu diambil. */
export const SOURCE_COLUMN: ExportColumn = { key: '__source', label: 'Sumber' };

export function exportValue(record: RecordRow, key: string): string {
  if (key === 'title') return record.title;
  if (key === 'url') return record.url;
  if (key === SOURCE_COLUMN.key) return record.provenance.source;
  return record.fields[key] ?? '';
}

/** Tab/baris baru di dalam nilai akan memecah tabel, jadi diratakan. */
function clean(value: string): string {
  return value.replace(/[\t\r\n]+/g, ' ').trim();
}

export function toTsv(records: RecordRow[], columns: ExportColumn[]): string {
  const lines = [columns.map((column) => clean(column.label)).join('\t')];
  for (const record of records) {
    lines.push(columns.map((column) => clean(exportValue(record, column.key))).join('\t'));
  }
  return lines.join('\n');
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function toHtmlTable(records: RecordRow[], columns: ExportColumn[]): string {
  const head = columns.map((column) => `<th>${escapeHtml(column.label)}</th>`).join('');
  const body = records
    .map(
      (record) =>
        `<tr>${columns
          .map((column) => `<td>${escapeHtml(exportValue(record, column.key))}</td>`)
          .join('')}</tr>`,
    )
    .join('');
  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}
