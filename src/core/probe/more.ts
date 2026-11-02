import { absoluteUrl } from '@/src/shared/url';
import type { TriggerReport, TriggerSkipReason } from './diagnose';

/**
 * Jalan keluar saat daftar TIDAK punya link "berikutnya": tombol "Muat lebih
 * banyak" atau infinite scroll.
 *
 * Fungsi di sini murni DOM/angka supaya bisa dites tanpa browser. Tindakannya
 * (klik / scroll) dijalankan di content script, karena hanya di sana layout dan
 * event milik situs benar-benar ada.
 *
 * Salah klik di sini mahal: tombol yang keliru bisa melamar pekerjaan, mengirim
 * form, atau menghapus sesuatu. Karena itu ada empat pagar sebelum klik:
 * status (disabled/loading), konteks form, teks berbahaya, dan visibilitas.
 */

/**
 * Sengaja tanpa "selengkapnya" / "baca selengkapnya": frasa itu biasanya ada
 * DI DALAM kartu lowongan, dan mengkliknya justru membuka halaman detail.
 */
const MORE_TEXT =
  /(muat\s+lebih|lihat\s+lebih|tampilkan\s+lebih|lebih\s+banyak|load\s+more|show\s+more|view\s+more|more\s+results|load\s+next)/i;

const LOADING_HINT = /(disabled|is-loading|loading)/i;

/**
 * Kata yang menandakan aksi berbahaya atau aksi akun, bukan pemicu daftar.
 * Diperiksa SETELAH status dan form, dan menang atas `MORE_TEXT`: tombol
 * "Muat lebih banyak lamaran" tetap tidak boleh diklik.
 */
const DANGEROUS_TEXT =
  /(lamar|melamar|apply|kirim|submit|simpan|hapus|delete|remove|beli|bayar|checkout|langganan|berhenti|unsubscribe|masuk|login|sign\s*in|daftar|sign\s*up|register|logout|keluar)/i;

/** Tombol selebar 40 karakter masih tombol; lebih dari itu kemungkinan paragraf. */
const MAX_BUTTON_TEXT = 40;

/**
 * Berapa lama menunggu daftar bertambah setelah klik/scroll. 6 detik: cukup
 * untuk koneksi lambat (3G) satu permintaan API, bukan "halaman habis".
 * Lewat batas ini statusnya `timeout`, bukan `unchanged`.
 */
export const EXPAND_WAIT_MS = 6_000;
/** Jarak pemeriksaan daftar selama menunggu. */
export const EXPAND_POLL_MS = 250;

export interface MoreButtonOptions {
  /** URL halaman sekarang, untuk menilai apakah link akan berpindah halaman. */
  baseUrl?: string;
  /** Pengganti pemeriksaan layout; hanya dipakai tes. */
  isVisible?: (el: HTMLElement) => boolean;
}

/**
 * Terlihat dan bisa diklik: punya ukuran, tidak `display:none`,
 * `visibility:hidden`, `opacity:0`, `pointer-events:none`, dan tidak
 * disembunyikan dari pembaca layar.
 *
 * Tombol di luar viewport TIDAK ditolak di sini — content script menggulirnya
 * ke tengah layar (`scrollIntoView`) sebelum klik, dan itu lebih baik daripada
 * melewatkan pemicu yang asli.
 */
export function isClickable(el: HTMLElement): boolean {
  if (el.hidden) return false;
  if (el.getAttribute('aria-hidden') === 'true') return false;

  const view = el.ownerDocument.defaultView;
  const style = view?.getComputedStyle(el);
  if (style) {
    if (style.display === 'none') return false;
    if (style.visibility === 'hidden' || style.visibility === 'collapse') return false;
    if (style.opacity === '0') return false;
    if (style.pointerEvents === 'none') return false;
  }

  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

/**
 * Link yang menuju dokumen lain: mengkliknya akan menavigasi tab, bukan
 * menambah isi daftar. Tombol tanpa `href` (button) tidak pernah dianggap
 * navigasi; `href="#"` dan hash sehalaman tetap boleh.
 */
function navigatesAway(node: HTMLElement, baseUrl: string | undefined): boolean {
  const href = node.getAttribute('href');
  if (href === null) return false;
  if (!baseUrl) return true;

  const target = absoluteUrl(href, baseUrl);
  if (!target) return true;

  const here = absoluteUrl(baseUrl, baseUrl);
  return target.split('#')[0] !== (here ?? '').split('#')[0];
}

/** Di dalam form, atau menunjuk form lain lewat atribut `form`: bisa submit. */
function inFormContext(node: HTMLElement): boolean {
  if (node.hasAttribute('form')) return true;
  return node.closest('form') !== null;
}

interface TriggerCandidate {
  node: HTMLElement;
  label: string;
  navigates: boolean;
  /** null = pemicu yang aman diklik. */
  reason: Exclude<TriggerSkipReason, 'navigates'> | null;
}

/**
 * Satu tempat untuk semua pagar, supaya `findMoreButton`,
 * `findBlockedTriggers`, dan laporan Diagnosa tidak pernah berbeda pendapat
 * soal tombol yang sama.
 */
function scanTriggers(doc: Document, options: MoreButtonOptions): TriggerCandidate[] {
  const isVisible = options.isVisible ?? isClickable;
  const nodes = Array.from(
    doc.querySelectorAll<HTMLElement>(
      'button, [role="button"], a[href], input[type="button"]',
    ),
  );
  const found: TriggerCandidate[] = [];

  for (const node of nodes) {
    const text = (node.textContent ?? node.getAttribute('value') ?? '')
      .replace(/\s+/g, ' ')
      .trim();
    const label = node.getAttribute('aria-label') ?? '';

    // Bukan pemicu daftar sama sekali: jangan dilaporkan sebagai "dilewati",
    // atau diagnosa penuh tombol yang tidak ada hubungannya.
    if (!MORE_TEXT.test(text) && !MORE_TEXT.test(label)) continue;
    const shown = text || label;
    if (shown.length === 0 || shown.length > MAX_BUTTON_TEXT) continue;

    let reason: TriggerCandidate['reason'] = null;
    if (node.hasAttribute('disabled') || node.getAttribute('aria-disabled') === 'true') {
      reason = 'disabled';
    } else if (LOADING_HINT.test(node.getAttribute('class') ?? '')) {
      reason = 'loading';
    } else if (node.hidden || !isVisible(node)) {
      reason = 'hidden';
    } else if (inFormContext(node)) {
      reason = 'form';
    } else if (DANGEROUS_TEXT.test(text) || DANGEROUS_TEXT.test(label)) {
      reason = 'dangerous';
    }

    found.push({
      node,
      label: shown,
      navigates: navigatesAway(node, options.baseUrl),
      reason,
    });
  }

  return found;
}

function clickable(candidate: TriggerCandidate): boolean {
  return candidate.reason === null && !candidate.navigates;
}

export function findMoreButton(
  doc: Document,
  options: MoreButtonOptions = {},
): HTMLElement | null {
  return scanTriggers(doc, options).find(clickable)?.node ?? null;
}

/**
 * Pemicu yang tampak seperti "muat lebih banyak" tetapi sengaja TIDAK diklik
 * karena akan berpindah dokumen. Dikembalikan sebagai catatan, supaya akhir run
 * tidak terbaca "daftar habis" padahal ada tombol yang dilewati.
 */
export function findBlockedTriggers(
  doc: Document,
  options: MoreButtonOptions = {},
): string[] {
  return scanTriggers(doc, options)
    .filter((item) => item.reason === null && item.navigates)
    .map((item) => `"${item.label}" dilewati: menuju dokumen lain`);
}

/**
 * Semua pemicu "muat lebih" beserta alasan dilewati. Dipakai Diagnosa: user
 * harus melihat tombol mana yang ada dan kenapa tidak diklik.
 */
export function inspectTriggers(
  doc: Document,
  options: MoreButtonOptions = {},
): TriggerReport[] {
  return scanTriggers(doc, options).map((item) => ({
    label: item.label,
    reason: item.reason ?? (item.navigates ? 'navigates' : null),
  }));
}

/**
 * Masih ada sisa yang bisa di-scroll? Dihitung dari angka, bukan query DOM,
 * karena `scrollHeight` sudah dihitung browser dan itu satu-satunya angka yang
 * benar (jsdom selalu 0, jadi fungsi ini dites dengan angka langsung).
 */
export function canScrollFurther(metrics: {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
}): boolean {
  if (metrics.clientHeight <= 0) return false;
  // Toleransi 8 px: pembulatan layout di layar dengan zoom sering menyisakan
  // selisih satu-dua piksel walau halaman sudah mentok.
  return metrics.scrollTop + metrics.clientHeight < metrics.scrollHeight - 8;
}
