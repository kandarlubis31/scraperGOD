import { absoluteUrl } from '@/src/shared/url';

/**
 * Mencari URL halaman berikutnya dari DOM.
 *
 * Urutan: `rel=next` → teks/aria-label yang jelas → kelas `next`/`pagination-next`
 * (tombol berikon sering tidak punya teks) → pagination bernomor.
 *
 * Kalau semua gagal, `guessNextUrl` menaikkan parameter halaman di URL. Itu
 * tebakan, jadi engine tetap punya pengaman `duplicate-page`: kalau halaman 2
 * isinya sama dengan halaman 1, run berhenti dan mengatakannya.
 */

const NEXT_TEXT =
  /^(next|next page|berikutnya|selanjutnya|lanjut|halaman berikutnya|›|»|>|→|▶|❯)$/i;
const NEXT_LABEL = /(next|berikutnya|selanjutnya|halaman berikutnya|lanjut ke)/i;
const DISABLED_HINT = /(disabled|is-disabled|aria-disabled)/i;

/**
 * Petunjuk dari class/id. Sengaja berbatas kata supaya `nextjs` tidak dianggap
 * tombol "next", dan `context` tidak cocok karena `next` di tengah kata.
 */
const NEXT_HINT =
  /(^|[\s_-])(next|berikutnya|selanjutnya)([\s_-]?(page|pagination|link|btn|button|arrow|nav))?($|[\s_-])/i;

const ACTIVE_HINT = /(^|[\s_-])(active|current|selected|is-active|is-current)($|[\s_-])/i;

function hrefOf(anchor: Element, baseUrl: string): string | null {
  const href = anchor.getAttribute('href');
  const url = absoluteUrl(href, baseUrl);
  return url || null;
}

function isDisabled(anchor: Element): boolean {
  const className = anchor.getAttribute('class') ?? '';
  return (
    anchor.hasAttribute('disabled') ||
    anchor.getAttribute('aria-disabled') === 'true' ||
    DISABLED_HINT.test(className)
  );
}

/** Teks anchor biasanya kosong kalau isinya ikon SVG: cek label & judul juga. */
function labelsOf(anchor: Element): { text: string; label: string; hint: string } {
  const text = (anchor.textContent ?? '').replace(/\s+/g, ' ').trim();
  const label = `${anchor.getAttribute('aria-label') ?? ''} ${anchor.getAttribute('title') ?? ''}`.trim();
  const hint = `${anchor.getAttribute('class') ?? ''} ${anchor.getAttribute('id') ?? ''} ${anchor.getAttribute('rel') ?? ''}`;
  return { text, label, hint };
}

function pageNumberOf(anchor: Element): number | null {
  const text = (anchor.textContent ?? '').replace(/\s+/g, ' ').trim();
  if (!/^\d{1,5}$/.test(text)) return null;
  return Number(text);
}

/**
 * Nomor halaman yang sedang dibuka. Dibaca dari penanda `active`/`aria-current`
 * lebih dulu, lalu dari parameter URL. Tanpa nomor sekarang, pagination
 * bernomor tidak bisa dipakai — menebak \"angka terkecil\" bisa memutar balik.
 */
function currentPageNumber(doc: Document, baseUrl: string): number | null {
  const anchors = Array.from(doc.querySelectorAll<HTMLAnchorElement>('a[href]'));
  for (const anchor of anchors) {
    const number = pageNumberOf(anchor);
    if (number === null) continue;
    const className = anchor.getAttribute('class') ?? '';
    const current =
      anchor.getAttribute('aria-current') === 'page' ||
      ACTIVE_HINT.test(className) ||
      ACTIVE_HINT.test(anchor.parentElement?.getAttribute('class') ?? '');
    if (current) return number;
  }

  try {
    const params = new URL(baseUrl).searchParams;
    for (const [key, value] of params.entries()) {
      if (!PAGE_QUERY.test(key)) continue;
      const number = Number(value);
      if (Number.isFinite(number) && number > 0) return number;
    }
  } catch {
    /* URL rusak: tidak ada nomor sekarang */
  }
  return null;
}

/** Pagination bernomor: `<a>1</a> <a>2</a> <a class="active">3</a> <a>4</a>`. */
function numberedNext(doc: Document, baseUrl: string): string | null {
  const current = currentPageNumber(doc, baseUrl);
  if (current === null) return null;

  const anchors = Array.from(doc.querySelectorAll<HTMLAnchorElement>('a[href]'));
  for (const anchor of anchors) {
    if (isDisabled(anchor)) continue;
    if (pageNumberOf(anchor) !== current + 1) continue;
    const url = hrefOf(anchor, baseUrl);
    if (url && url !== absoluteUrl(baseUrl)) return url;
  }
  return null;
}

export function findNextUrl(doc: Document, baseUrl: string): string | null {
  const rel = doc.querySelector<HTMLAnchorElement>('a[rel~="next"], link[rel="next"]');
  if (rel) {
    const url = hrefOf(rel, baseUrl);
    if (url) return url;
  }

  const anchors = Array.from(doc.querySelectorAll<HTMLAnchorElement>('a[href]'));
  let hinted: string | null = null;

  for (const anchor of anchors) {
    if (isDisabled(anchor)) continue;
    const { text, label, hint } = labelsOf(anchor);

    const matchesText = NEXT_TEXT.test(text);
    const matchesLabel = NEXT_LABEL.test(label);
    const matchesHint = NEXT_HINT.test(hint);
    if (!matchesText && !matchesLabel && !matchesHint) continue;

    // Tombol "next" yang menunjuk ke halaman sekarang biasanya jebakan.
    const url = hrefOf(anchor, baseUrl);
    if (!url || url === absoluteUrl(baseUrl)) continue;

    // Teks/label eksplisit lebih dipercaya daripada class yang bisa saja milik
    // elemen dekorasi; class disimpan sebagai kandidat kedua.
    if (matchesText || matchesLabel) return url;
    hinted ??= url;
  }

  if (hinted) return hinted;
  return numberedNext(doc, baseUrl);
}

/** Parameter query yang biasanya berisi nomor halaman (bukan offset/cursor). */
const PAGE_QUERY = /^(page|_page|p|pg|pageno|page_no|pagenum|page_num)$/i;
/** Pagination di path: `/page/2`, `/halaman/2`, `/p/2`. */
const PAGE_PATH = /^(.*\/(?:page|halaman|halaman-|p)\/?)(\d+)(\/?)$/i;

/**
 * Tebakan URL halaman berikutnya dari bentuk URL-nya sendiri.
 *
 * Hanya menaikkan parameter yang JELAS nomor halaman. `offset`/`cursor` tidak
 * disentuh: ukuran halaman tidak diketahui, dan menebak offset menghasilkan
 * halaman yang salah tanpa terlihat salah.
 */
export function guessNextUrl(baseUrl: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return null;
  }

  for (const [key, value] of parsed.searchParams.entries()) {
    if (!PAGE_QUERY.test(key)) continue;
    const number = Number(value);
    if (!Number.isFinite(number)) continue;
    const next = new URL(parsed.toString());
    next.searchParams.set(key, String(number + 1));
    return next.toString();
  }

  const match = parsed.pathname.match(PAGE_PATH);
  if (match) {
    const next = new URL(parsed.toString());
    next.pathname = `${match[1]}${Number(match[2]) + 1}${match[3] ?? ''}`;
    return next.toString();
  }

  return null;
}
