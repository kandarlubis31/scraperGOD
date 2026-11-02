import { urlKey } from '@/src/shared/url';
import type { PageItem } from '@/src/shared/types';

/**
 * Picker memakai data JSON situs kalau item yang dipilih memang ada di sana.
 *
 * Alasannya sederhana: jalur network memberi company/lokasi/gaji/tanggal yang
 * sudah dipetakan, sedangkan DOM hanya bisa menebak dari teks. Kalau tebakan
 * itu sudah tersedia, tidak ada alasan menyimpan versi yang lebih miskin.
 *
 * Murni: tidak menyentuh DOM maupun chrome.*, jadi bisa dites dengan fixture.
 */

export interface NetworkCandidate {
  items: PageItem[];
  /** Path array di JSON, disimpan sebagai `selector` provenance. */
  selector: string | null;
}

export interface PickMerge {
  items: PageItem[];
  selector: string | null;
  /** Item pilihan yang ditemukan di sumber jaringan. */
  matched: number;
  /** matched / jumlah item pilihan (0-1). */
  coverage: number;
}

/** Di bawah ini, data jaringan dianggap bukan daftar yang sama. */
const MIN_COVERAGE = 0.8;

/**
 * Menggabungkan pilihan picker dengan sumber jaringan terbaik. Item yang cocok
 * memakai data jaringan (lebih lengkap), sisanya tetap hasil DOM; urutan pilihan
 * user dipertahankan.
 */
export function mergeWithNetwork(
  picked: PageItem[],
  baseUrl: string,
  candidates: NetworkCandidate[],
): PickMerge | null {
  if (picked.length === 0) return null;

  let best: { candidate: NetworkCandidate; map: Map<string, PageItem>; matched: number } | null =
    null;

  for (const candidate of candidates) {
    const map = new Map<string, PageItem>();
    for (const item of candidate.items) {
      const key = urlKey(item.url, baseUrl);
      if (key && !map.has(key)) map.set(key, item);
    }
    if (map.size === 0) continue;

    let matched = 0;
    for (const item of picked) {
      if (map.has(urlKey(item.url, baseUrl))) matched += 1;
    }
    if (!best || matched > best.matched) best = { candidate, map, matched };
  }

  if (!best) return null;
  const coverage = best.matched / picked.length;
  if (coverage < MIN_COVERAGE) return null;

  const items = picked.map((item) => {
    const fromNetwork = best!.map.get(urlKey(item.url, baseUrl));
    if (!fromNetwork) return item;
    const hasFields = Object.keys(fromNetwork.fields).length > 0;
    return {
      url: fromNetwork.url || item.url,
      title: fromNetwork.title || item.title,
      // Kalau jaringan memberi field kanonik, `info_1/info_2` hasil tebakan DOM
      // dibuang supaya tidak muncul dua kolom untuk hal yang sama.
      fields: hasFields ? fromNetwork.fields : item.fields,
      raw: fromNetwork.raw || item.raw,
    };
  });

  return {
    items,
    selector: best.candidate.selector,
    matched: best.matched,
    coverage,
  };
}
