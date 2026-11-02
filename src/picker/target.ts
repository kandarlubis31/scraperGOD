/**
 * Aturan target pengambilan dari picker.
 *
 * Halaman pertama sudah ada di DOM: user memilih sekumpulan item, dan sering
 * kumpulan itu hanya sebagian dari daftar (satu halaman). "Ambil" yang lama
 * selalu berhenti di halaman itu. Sekarang user bisa menetapkan target M, dan
 * sisanya diambil dengan pagination yang sudah ada.
 *
 * Modul murni: dipakai picker (content script) dan tes.
 */

/** Di atas jumlah ini, user harus memilih: satu halaman saja atau lanjut. */
export const CONFIRM_ITEMS = 20;
/** Batas atas target, sama dengan batas pesan picker. */
export const MAX_TARGET = 5_000;

export type PickMode = 'page' | 'continue';

export interface PickDecision {
  mode: PickMode;
  /** Jumlah item yang ingin disimpan. */
  target: number;
}

/** Target selalu bilangan bulat 1..MAX_TARGET; nilai aneh jatuh ke `fallback`. */
export function clampTarget(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return Math.max(1, Math.min(fallback, MAX_TARGET));
  return Math.max(1, Math.min(Math.round(value), MAX_TARGET));
}

/** Perlu dialog? Set besar, atau user sudah menetapkan target besar. */
export function needsConfirmation(count: number, target: number | null = null): boolean {
  return count > CONFIRM_ITEMS || (target ?? 0) > CONFIRM_ITEMS;
}

/**
 * Item yang diambil dari halaman ini. Urutan DOM dipertahankan: `M` teratas
 * berarti urutan situs, bukan urutan acak.
 */
export function sliceForPage<T>(items: T[], target: number): T[] {
  return items.slice(0, clampTarget(target, items.length));
}

/**
 * Plafon halaman untuk target M. `+2` memberi ruang satu halaman pembuka dan
 * satu halaman penutup; engine tetap berhenti sendiri di `max-items`.
 */
export function maxPagesFor(target: number, pageSize: number, limit = 200): number {
  const size = Math.max(1, pageSize);
  return Math.max(1, Math.min(limit, Math.ceil(target / size) + 2));
}
