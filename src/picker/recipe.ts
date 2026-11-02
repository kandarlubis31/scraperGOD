/**
 * Recipe: "daftar mana yang gw pilih" disimpan per situs.
 *
 * Tanpa ini, "Ambil" di picker dan "Mulai ambil" di panel bisa menunjuk
 * kumpulan item yang berbeda: panel menebak ulang level daftar setiap halaman,
 * dan satu iklan atau satu section baru sudah cukup untuk menggeser tebakan.
 *
 * Isinya sengaja kecil dan tahan berubah: selector item + selector container +
 * sidik jari bentuk item. Kalau sidik jari tidak cocok, recipe DITOLAK dengan
 * alasan, bukan dipakai diam-diam untuk menghasilkan kolom kosong.
 *
 * Modul ini murni DOM (tidak menyentuh chrome.*), supaya bisa dites.
 */

const MAX_ANCESTOR_DEPTH = 6;
/** Kelas yang terlihat seperti hash build: berubah tiap deploy, jangan dipakai. */
const UNSTABLE_CLASS = /^[a-z]?[0-9a-f]{6,}$|^css-|^sc-|^jsx-|[:[\]]/i;

export interface Recipe {
  /** origin + path tanpa query. */
  siteKey: string;
  /** Selector container daftar. */
  container: string;
  /** Selector absolut satu item di dalam container. */
  item: string;
  /** `tag|jumlah anak` item pertama saat disimpan. */
  signature: string;
  savedAt: number;
}

export function recipeKey(siteKey: string): string {
  return `recipe:${siteKey}`;
}

export function isRecipe(value: unknown): value is Recipe {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.siteKey === 'string' &&
    typeof record.container === 'string' &&
    typeof record.item === 'string' &&
    typeof record.signature === 'string' &&
    typeof record.savedAt === 'number'
  );
}

function escapeClass(name: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(name);
  return name.replace(/[^\w-]/g, '\\$&');
}

function stableClasses(el: Element): string[] {
  const raw = el.getAttribute('class') ?? '';
  return raw
    .split(/\s+/)
    .map((name) => name.trim())
    .filter((name) => name.length > 0 && name.length <= 40 && !UNSTABLE_CLASS.test(name))
    .slice(0, 2);
}

function nthOfType(el: Element): number {
  const parent = el.parentElement;
  if (!parent) return 1;
  const sameTag = Array.from(parent.children).filter((child) => child.tagName === el.tagName);
  return sameTag.indexOf(el) + 1;
}

/**
 * Selector ringkas untuk satu elemen. Kelas yang stabil dipakai lebih dulu;
 * kalau tidak ada, jatuh ke `nth-of-type`. Kedalaman dibatasi supaya recipe
 * tidak patah hanya karena satu wrapper baru di atasnya.
 */
export function cssSelector(el: Element): string {
  const parts: string[] = [];
  let node: Element | null = el;

  for (let depth = 0; node && depth < MAX_ANCESTOR_DEPTH; depth += 1) {
    if (node === node.ownerDocument.documentElement) break;

    const tag = node.tagName.toLowerCase();
    const classes = stableClasses(node);
    if (classes.length > 0) {
      parts.unshift(`${tag}${classes.map((name) => `.${escapeClass(name)}`).join('')}`);
    } else {
      parts.unshift(`${tag}:nth-of-type(${nthOfType(node)})`);
    }

    const parent: Element | null = node.parentElement;
    // Container daftar hampir selalu punya kelas yang stabil; berhenti di sini
    // membuat selector jauh lebih tahan terhadap perubahan di atasnya.
    if (parent && stableClasses(parent).length > 0 && depth > 0) break;
    node = parent;
  }

  return parts.join(' > ');
}

export function itemSignature(el: Element): string {
  return `${el.tagName.toLowerCase()}|${el.children.length}`;
}

function signatureMatches(expected: string, actual: string): boolean {
  const [expectedTag, expectedCount] = expected.split('|');
  const [actualTag, actualCount] = actual.split('|');
  if (!expectedTag || expectedTag !== actualTag) return false;
  const diff = Math.abs(Number(expectedCount) - Number(actualCount));
  // Satu-dua elemen tambahan (badge, harga coret) masih bentuk yang sama.
  return Number.isFinite(diff) && diff <= 2;
}

export function buildRecipe(
  siteKey: string,
  container: Element,
  item: Element,
  now = Date.now(),
): Recipe {
  return {
    siteKey,
    container: cssSelector(container),
    item: cssSelector(item),
    signature: itemSignature(item),
    savedAt: now,
  };
}

export interface RecipeMatch {
  items: Element[];
  container: Element | null;
  /** Ada = recipe tidak bisa dipakai; pemanggil harus jatuh ke deteksi otomatis. */
  reason: string | null;
}

/**
 * Menerapkan recipe ke dokumen sekarang. `null` = tidak relevan (situs lain).
 *
 * Alasan penolakan dipisah dari "tidak ada item": halaman terakhir yang kosong
 * bukan kerusakan struktur, sedangkan selector yang tidak cocok adalah.
 */
export function applyRecipe(recipe: Recipe, doc: Document, siteKey: string): RecipeMatch | null {
  if (recipe.siteKey !== siteKey) return null;

  const container = doc.querySelector(recipe.container);
  const items = Array.from(doc.querySelectorAll(recipe.item));

  if (items.length === 0) {
    return {
      items: [],
      container,
      reason: 'Struktur halaman berubah; pilih ulang daftarnya dengan picker.',
    };
  }

  if (!signatureMatches(recipe.signature, itemSignature(items[0]!))) {
    return {
      items,
      container,
      reason: 'Bentuk item berubah; pilih ulang daftarnya dengan picker.',
    };
  }

  return { items, container, reason: null };
}
