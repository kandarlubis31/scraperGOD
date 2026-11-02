/**
 * Normalisasi URL yang dipakai bersama oleh picker, engine, dan dedupe.
 * Fungsi ini tidak boleh menyentuh `location` secara langsung supaya bisa
 * dipakai di service worker dan di test.
 */

const TRACKING_PARAM =
  /^(utm_.+|ref|ref_src|referrer|trk|tracking|src|source|si|fbclid|gclid|mc_cid|mc_eid)$/i;

function currentHref(): string {
  return typeof location === 'undefined' ? '' : location.href;
}

/** URL absolut, hanya http(s), parameter pelacak & hash dibuang. */
export function absoluteUrl(href: string | null, base?: string): string {
  if (!href) return '';
  try {
    const url = new URL(href, base ?? currentHref());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    for (const key of Array.from(url.searchParams.keys())) {
      if (TRACKING_PARAM.test(key)) url.searchParams.delete(key);
    }
    url.hash = '';
    return url.toString();
  } catch {
    return '';
  }
}

/**
 * Identitas "kumpulan daftar" untuk dedupe lintas-run: origin + path tanpa
 * query. Dua URL daftar yang hanya beda parameter halaman atau filter dianggap
 * daftar yang sama, jadi item yang sudah pernah diambil tidak dilaporkan baru
 * lagi hanya karena nomor halamannya berubah.
 */
export function siteKey(raw: string, base?: string): string {
  const url = absoluteUrl(raw, base);
  if (!url) return '';
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/\/+$/, '');
    return `${parsed.protocol}//${parsed.host.toLowerCase()}${path}`;
  } catch {
    return '';
  }
}

/**
 * Kunci identitas record. Dua URL yang hanya beda parameter pelacak atau
 * trailing slash harus menghasilkan kunci sama, supaya dedupe benar-benar
 * menahan duplikat dan bukan cuma merapikan tampilan.
 */
export function urlKey(raw: string, base?: string): string {
  const url = absoluteUrl(raw, base);
  if (!url) return '';
  try {
    const parsed = new URL(url);
    parsed.hostname = parsed.hostname.toLowerCase();
    if (parsed.pathname !== '/') parsed.pathname = parsed.pathname.replace(/\/+$/, '');
    parsed.searchParams.sort();
    return parsed.toString();
  } catch {
    return '';
  }
}
