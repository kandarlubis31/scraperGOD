import { absoluteUrl } from '@/src/shared/url';
import { inferDomFields, type DomHints } from './fields';

/**
 * Ekstraksi nilai dari satu item + serialisasi TSV.
 *
 * Kolom sengaja sederhana di prototipe: judul, url, dua info tambahan.
 * Pemetaan kolom per-situs menyusul di FR-5B.
 */

const MAX_BLOCK_LENGTH = 300;
const IGNORED_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG']);

export const COLUMNS = ['judul', 'url', 'info_1', 'info_2'] as const;

export function normalizeSpace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export { absoluteUrl };

function ownText(el: Element): string {
  let text = '';
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) text += node.nodeValue ?? '';
  }
  return normalizeSpace(text);
}

/**
 * Blok teks milik item, urut sesuai DOM. Blok yang isinya sudah tercakup blok
 * lain dibuang supaya "Jakarta" tidak muncul dua kali karena parent & child.
 */
export function textBlocks(item: Element): string[] {
  const all: string[] = [];
  const walk = (el: Element) => {
    if (IGNORED_TAGS.has(el.tagName)) return;
    const text = ownText(el);
    if (text.length >= 2 && text.length <= MAX_BLOCK_LENGTH) all.push(text);
    for (const child of Array.from(el.children)) walk(child);
  };
  walk(item);

  const byLength = [...all].sort((a, b) => b.length - a.length);
  const kept: string[] = [];
  for (const text of byLength) {
    if (!kept.some((longer) => longer.includes(text))) kept.push(text);
  }

  return all.filter((text) => kept.includes(text));
}

/**
 * Teks link yang jelas bukan judul item: aksi kartu, bukan isi kartu.
 * Tanpa filter ini, "Simpan lowongan" atau "Bagikan" bisa jadi judul.
 */
const LINK_NOISE =
  /^(simpan|simpan lowongan|save|saved|lamar|lamar sekarang|apply|apply now|bagikan|share|lihat semua|lihat selengkapnya|baca selengkapnya|detail|more|lihat|follow|ikuti|suka|like|favorit|favorite|bookmark|tambah|add|bandingkan|compare|beli|buy|tonton|watch|unduh|download)$/i;

function linkText(link: Element): string {
  return normalizeSpace(link.textContent ?? '');
}

/**
 * Link yang mewakili item.
 *
 * Urutan prioritas: anchor di dalam heading (h1–h5) → class/id yang menyebut
 * judul/nama → teks terpanjang. Dulu "terpanjang" saja, dan di kartu nyata itu
 * sering link promosi ("Lihat semua film dari …") sehingga judul semua item
 * jadi sama. Link aksi (simpan/lamar/bagikan) selalu dibuang.
 */
export function bestLink(item: Element): HTMLAnchorElement | null {
  const links = Array.from(item.querySelectorAll<HTMLAnchorElement>('a[href]')).filter(
    (link) => !LINK_NOISE.test(linkText(link)),
  );
  if (links.length === 0) return null;

  const heading = item.querySelector('h1, h2, h3, h4, h5');
  if (heading) {
    const inHeading = links.find(
      (link) => heading.contains(link) && linkText(link).length >= 2,
    );
    if (inHeading) return inHeading;
  }

  const named = links.find((link) => {
    const hint = `${link.getAttribute('class') ?? ''} ${link.getAttribute('id') ?? ''}`;
    return /(title|name|headline|judul)/i.test(hint) && linkText(link).length >= 2;
  });
  if (named) return named;

  const withText = links.filter((link) => linkText(link).length >= 3);
  const pool = withText.length > 0 ? withText : links;

  return pool.reduce((longest, link) =>
    linkText(link).length > linkText(longest).length ? link : longest,
  );
}

interface TitleUrl {
  title: string;
  url: string;
  /** Blok teks selain judul & URL, urut DOM. */
  extras: string[];
}

function titleAndUrl(item: Element, base?: string): TitleUrl {
  const link = bestLink(item);
  const linkText = normalizeSpace(link?.textContent ?? '');
  const blocks = textBlocks(item);
  const longestBlock = blocks.reduce(
    (longest, block) => (block.length > longest.length ? block : longest),
    '',
  );
  const title = linkText || longestBlock || normalizeSpace(item.textContent ?? '');
  const url = absoluteUrl(link?.getAttribute('href') ?? null, base);

  const extras = blocks.filter(
    (block) =>
      block !== title &&
      block !== url &&
      !block.includes(title) &&
      !title.includes(block),
  );

  return { title, url, extras };
}

export function rowOf(item: Element, base?: string): string[] {
  const { title, url, extras } = titleAndUrl(item, base);
  return [title, url, extras[0] ?? '', extras[1] ?? ''];
}

const COMPANY_MARKER = /(company|employer|perusahaan|brand|hiringorganization)/i;

/** Petunjuk perusahaan dari class/atribut/alt logo, kalau ada. */
export function companyHint(item: Element): string | null {
  for (const el of Array.from(item.querySelectorAll<HTMLElement>('[class], [data-company]'))) {
    const className = typeof el.className === 'string' ? el.className : '';
    const marker = `${className} ${el.hasAttribute('data-company') ? 'company' : ''}`;
    if (!COMPANY_MARKER.test(marker)) continue;
    const text = normalizeSpace(el.textContent ?? '');
    if (text && text.length <= 80) return text;
  }

  const alt = normalizeSpace(item.querySelector('img[alt]')?.getAttribute('alt') ?? '');
  if (alt && alt.length <= 80 && !/logo|photo|foto|image|icon|avatar/i.test(alt)) return alt;
  return null;
}

/**
 * Judul, URL, dan field kanonik (company/location/salary/date) untuk satu
 * kartu. `rowOf` sengaja tidak diubah: TSV tetap empat kolom.
 */
export function fieldsOf(
  item: Element,
  base?: string,
): { title: string; url: string; fields: Record<string, string> } {
  const { title, url, extras } = titleAndUrl(item, base);
  const hints: DomHints = { company: companyHint(item) };
  return { title, url, fields: inferDomFields(extras, hints) };
}

export function rowsOf(items: Element[], base?: string): string[][] {
  return items.map((item) => rowOf(item, base));
}

export function escapeCell(value: string): string {
  if (/[\t\n\r"]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export function toTSV(rows: string[][], columns: readonly string[] = COLUMNS): string {
  const lines = [columns.map(escapeCell).join('\t')];
  for (const row of rows) lines.push(row.map(escapeCell).join('\t'));
  return lines.join('\r\n');
}
