import type { ApiPlan } from '@/src/shared/types';

/**
 * Laporan diagnosa pagination.
 *
 * Ini satu-satunya jawaban untuk pertanyaan "kenapa tidak lanjut halaman?" yang
 * bisa dibaca user tanpa membuka DevTools. Semua fakta dikumpulkan content
 * script (DOM/layout hanya ada di sana), lalu diubah jadi teks di sini — fungsi
 * murni, supaya kalimatnya bisa dites dan tidak berbeda antar jalur.
 */

export type TriggerSkipReason =
  | 'disabled'
  | 'loading'
  | 'hidden'
  | 'form'
  | 'dangerous'
  | 'navigates';

export interface TriggerReport {
  label: string;
  /** null = tombol pemicu yang bisa diklik. */
  reason: TriggerSkipReason | null;
}

export interface PaginationFacts {
  url: string;
  itemCount: number;
  /** Rencana API yang lolos; null = tidak ada. */
  api: ApiPlan | null;
  /** Alasan API diterima/ditolak, dari pemindaian capture. */
  apiNotes: string[];
  more: TriggerReport[];
  /** Cara menemukan link berikutnya, mis. `rel=next`. */
  nextUrl: string | null;
  nextUrlVia: string | null;
  scroll: {
    window: boolean;
    /** Container `overflow:auto` yang isinya lebih tinggi dari tingginya. */
    containers: string[];
  };
}

const REASON_LABEL: Record<TriggerSkipReason, string> = {
  disabled: 'dinonaktifkan (disabled)',
  loading: 'sedang memuat',
  hidden: 'tidak terlihat',
  form: 'berada di dalam form',
  dangerous: 'teks berbahaya (lamar/kirim/hapus)',
  navigates: 'menuju dokumen lain',
};

function apiLine(api: ApiPlan): string {
  const method = api.method || 'GET';
  const parts = [method];

  if (api.cursorParam) {
    parts.push(`cursor "${api.cursorParam}"`);
  } else if (api.pageParam) {
    parts.push(`${api.pageKind} "${api.pageParam}" mulai ${api.pageValue}`);
  } else if (api.bodyPageParam) {
    parts.push(`field body "${api.bodyPageParam}"`);
  } else {
    parts.push('tanpa parameter halaman');
  }

  parts.push(`${api.pageSize ?? '?'} item/halaman`);
  parts.push(`array ${api.arrayPath || '$'}`);
  if (api.verified) parts.push('verifikasi halaman 2 lolos');
  return parts.join(' · ');
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

export function buildDiagnosis(facts: PaginationFacts): string {
  const lines: string[] = [];
  lines.push(`Diagnosa pagination — ${hostOf(facts.url)}`);
  lines.push(`${facts.itemCount} item terdeteksi di halaman ini.`);
  lines.push('');

  // 1. API
  if (facts.api) {
    lines.push(`API: dipakai (${apiLine(facts.api)})`);
    if (facts.api.verifyNote) lines.push(`- ${facts.api.verifyNote}`);
  } else {
    lines.push('API: tidak dipakai');
  }
  for (const note of facts.apiNotes.slice(0, 4)) lines.push(`- ${note}`);

  // 2. Tombol "muat lebih"
  const clickable = facts.more.filter((trigger) => trigger.reason === null);
  if (clickable.length > 0) {
    lines.push(`Tombol "muat lebih": ditemukan "${clickable[0]!.label}"`);
  } else if (facts.more.length > 0) {
    lines.push('Tombol "muat lebih": ada, tetapi tidak bisa diklik');
  } else {
    lines.push('Tombol "muat lebih": tidak ditemukan');
  }
  for (const trigger of facts.more) {
    if (trigger.reason === null) continue;
    lines.push(`- "${trigger.label}" dilewati: ${REASON_LABEL[trigger.reason]}`);
  }

  // 3. Link berikutnya
  if (facts.nextUrl) {
    const via = facts.nextUrlVia ? ` (${facts.nextUrlVia})` : '';
    lines.push(`Link berikutnya${via}: ${facts.nextUrl}`);
  } else {
    lines.push('Link berikutnya: tidak ada');
  }

  // 4. Scroll
  if (facts.scroll.window) {
    lines.push('Scroll: halaman masih bisa digulir');
  } else {
    lines.push('Scroll: sudah mentok');
  }
  for (const container of facts.scroll.containers.slice(0, 3)) {
    lines.push(`- Container bisa digulir: ${container}`);
  }

  // 5. Kesimpulan
  lines.push('');
  lines.push(`Kesimpulan: ${conclusionOf(facts)}`);
  return lines.join('\n');
}

export function conclusionOf(facts: PaginationFacts): string {
  if (facts.api) {
    const param = facts.api.cursorParam
      ? `parameter "${facts.api.cursorParam}"`
      : facts.api.pageParam
        ? `${facts.api.pageKind} "${facts.api.pageParam}"`
        : facts.api.bodyPageParam
          ? `field body "${facts.api.bodyPageParam}"`
          : 'parameter halaman';
    return `pagination lewat API situs — halaman berikutnya diambil dengan menaikkan ${param}, tanpa pindah halaman.`;
  }
  if (facts.nextUrl) {
    return 'pagination lewat link halaman berikutnya — tab akan dibuka ke URL itu tiap halaman.';
  }
  if (facts.more.some((trigger) => trigger.reason === null)) {
    return 'hanya tombol "muat lebih" — halaman yang sama diklik lalu digulir berulang sampai daftar habis.';
  }
  if (facts.scroll.window || facts.scroll.containers.length > 0) {
    return 'hanya scroll/infinite scroll — daftar dimuat bertahap di halaman yang sama.';
  }
  return 'tidak ada jalur pagination. Hanya halaman ini yang bisa diambil.';
}
