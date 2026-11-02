/**
 * Pembacaan nilai dari JSON hasil probe.
 *
 * Ini bagian yang harus tetap murni: tidak menyentuh DOM, tidak menyentuh
 * chrome.*, supaya bisa dites dengan fixture dan dipakai ulang di offscreen.
 */

import type { FieldMapping } from '@/src/shared/types';
import { absoluteUrl } from '@/src/shared/url';

export type { FieldMapping };

export const CANONICAL_FIELDS = [
  'title',
  'url',
  'company',
  'location',
  'salary',
  'date',
  'description',
] as const;

export type CanonicalField = (typeof CANONICAL_FIELDS)[number];

/**
 * Alias key per peran. Sengaja dibuat lebar: situs lowongan memakai nama yang
 * berbeda-beda, dan salah tebak di sini lebih murah daripada minta user
 * memetakan manual.
 */
const KEY_ALIASES: Record<CanonicalField, RegExp> = {
  title: /^(title|name|jobtitle|job_title|position|headline|label|subject)$/i,
  url: /^(url|link|href|joburl|job_url|permalink|applyurl|apply_url|detailUrl|detail_url|slug)$/i,
  company: /^(company|companyname|company_name|employer|organization|organisation|advertiser|brand|hiringOrganization)$/i,
  location: /^(location|city|area|region|place|address|workplace|jobLocation|locationName|location_name)$/i,
  salary: /^(salary|salaryrange|salary_range|compensation|pay|wage|salaryText|salary_text)$/i,
  date: /^(date|dateposted|date_posted|postedat|posted_at|createdat|created_at|publishedat|published_at|updatedat|updated_at)$/i,
  description: /^(description|snippet|summary|teaser|excerpt|requirements|qualifications)$/i,
};

function ownKeys(value: Record<string, unknown>): string[] {
  return Object.keys(value).filter((key) => key !== '@type' && key !== '__typename');
}

export function getAtPath(value: unknown, path: string): unknown {
  if (!path) return value;
  let node: unknown = value;
  for (const segment of path.split('.')) {
    if (node === null || typeof node !== 'object') return undefined;
    node = (node as Record<string, unknown>)[segment];
  }
  return node;
}

/** Mengubah nilai JSON jadi satu sel teks yang stabil. */
export function asText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.replace(/\s+/g, ' ').trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    return value.map((entry) => asText(entry)).filter(Boolean).join(', ');
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const key of ['name', 'title', 'label', 'value', 'text', 'addressLocality', 'city']) {
      const inner = record[key];
      if (typeof inner === 'string' && inner.trim()) return inner.trim();
    }
    return '';
  }
  return '';
}

export interface DetectedArray {
  path: string;
  items: unknown[];
}

/**
 * Cari array-of-object terbesar di dalam JSON. Array of primitives sengaja
 * ditolak: itu hampir selalu daftar tag/filter, bukan item.
 */
export function findItemArrays(
  root: unknown,
  options: { minItems?: number; maxDepth?: number; maxArrays?: number } = {},
): DetectedArray[] {
  const { minItems = 2, maxDepth = 6, maxArrays = 24 } = options;
  const found: DetectedArray[] = [];

  const walk = (node: unknown, path: string, depth: number): void => {
    if (found.length >= maxArrays || depth > maxDepth) return;

    if (Array.isArray(node)) {
      const objects = node.filter(
        (entry) => entry !== null && typeof entry === 'object' && !Array.isArray(entry),
      );
      if (objects.length >= minItems && objects.length / node.length >= 0.6) {
        found.push({ path, items: node.filter((e) => typeof e === 'object') });
      }
      return;
    }

    if (node === null || typeof node !== 'object') return;
    for (const key of ownKeys(node as Record<string, unknown>)) {
      const child = (node as Record<string, unknown>)[key];
      walk(child, path ? `${path}.${key}` : key, depth + 1);
    }
  };

  walk(root, '', 0);
  return found.sort((a, b) => b.items.length - a.items.length);
}

function collectPaths(
  sample: Record<string, unknown>,
  prefix = '',
  depth = 0,
): { path: string; key: string; value: unknown }[] {
  const out: { path: string; key: string; value: unknown }[] = [];
  for (const key of ownKeys(sample)) {
    const value = sample[key];
    const path = prefix ? `${prefix}.${key}` : key;
    out.push({ path, key, value });
    if (value && typeof value === 'object' && !Array.isArray(value) && depth < 2) {
      out.push(...collectPaths(value as Record<string, unknown>, path, depth + 1));
    }
  }
  return out;
}

/** Mapping otomatis dari sampel item; null berarti user harus memilih manual. */
export function autoMapFields(sample: Record<string, unknown>): FieldMapping {
  const mapping: FieldMapping = {
    title: null,
    url: null,
    company: null,
    location: null,
    salary: null,
    date: null,
    description: null,
  };

  const paths = collectPaths(sample);
  // Diutamakan yang nilainya string dan bukan objek pembungkus.
  const ordered = [...paths].sort((a, b) => {
    const aStr = typeof a.value === 'string' ? 0 : 1;
    const bStr = typeof b.value === 'string' ? 0 : 1;
    return aStr - bStr || a.path.length - b.path.length;
  });

  for (const field of CANONICAL_FIELDS) {
    const pattern = KEY_ALIASES[field];
    const match = ordered.find(
      (entry) => pattern.test(entry.key) && asText(entry.value).length > 0,
    );
    mapping[field] = match ? match.path : null;
  }

  return mapping;
}

export function mappingToRecord(mapping: FieldMapping): Record<string, string> {
  const out: Record<string, string> = {};
  for (const field of CANONICAL_FIELDS) {
    const path = mapping[field];
    if (path) out[field] = path;
  }
  return out;
}

/**
 * Key yang tidak boleh jadi kolom: nilainya rahasia sesi, dan `fields` ikut
 * tersimpan di DB serta ikut diekspor. Kalau key-nya lolos, nilainya bocor.
 */
const SECRET_KEY =
  /(token|csrf|xsrf|auth|session|secret|password|jwt|bearer|api[_-]?key|cookie|credential)/i;

/** Batas kolom tambahan per item: cukup untuk metadata, tidak membanjiri tabel. */
export const MAX_EXTRA_FIELDS = 24;
/** Nilai lebih panjang dari ini biasanya paragraf/HTML, bukan metadata. */
const MAX_EXTRA_VALUE = 300;

export interface AutoMapResult {
  /** Peran kanonik yang dikenali (title, url, company, ...). */
  mapping: FieldMapping;
  /** Key JSON lain yang ikut disimpan apa adanya: `year`, `rating`, `genre`, ... */
  extraFields: Record<string, string>;
}

/**
 * Pemetaan universal: selain 7 field kanonik, semua nilai skalar lain di item
 * ikut disimpan dengan nama key aslinya.
 *
 * Ini yang membuat situs film/buku/produk tetap berguna walau tidak ada
 * `company`/`salary` sama sekali. Tanpa ini, satu-satunya yang tersimpan dari
 * daftar film adalah judul dan URL.
 */
export function autoMapAll(sample: Record<string, unknown>): AutoMapResult {
  const mapping = autoMapFields(sample);
  const used = new Set(
    Object.values(mapping).filter((path): path is string => Boolean(path)),
  );
  const extraFields: Record<string, string> = {};
  const taken = new Set<string>();

  const paths = collectPaths(sample, '', 0).filter((entry) => !used.has(entry.path));
  // Path pendek dulu: `rating` lebih berguna daripada `attributes.rating.value`.
  paths.sort((a, b) => a.path.split('.').length - b.path.split('.').length);

  for (const entry of paths) {
    if (Object.keys(extraFields).length >= MAX_EXTRA_FIELDS) break;
    if (SECRET_KEY.test(entry.key) || SECRET_KEY.test(entry.path)) continue;
    if (entry.value !== null && typeof entry.value === 'object' && !Array.isArray(entry.value)) {
      continue;
    }
    const text = asText(entry.value);
    if (!text || text.length > MAX_EXTRA_VALUE) continue;

    // Nama kolom: key terakhir, tapi field bersarang memakai path lengkap
    // (`director.name` → `director_name`) supaya `name` tidak tertukar dengan
    // `company.name`.
    let name = (entry.path.includes('.') ? entry.path : entry.key).replace(/[^\w-]/g, '_');
    if (!name) continue;
    if (taken.has(name)) name = entry.path.replace(/[^\w-]/g, '_');
    if (!name || taken.has(name)) continue;

    taken.add(name);
    extraFields[name] = entry.path;
  }

  return { mapping, extraFields };
}

export interface MappedItem {
  url: string;
  title: string;
  fields: Record<string, string>;
  raw: string;
}

const RAW_LIMIT = 4_000;

export function toPageItems(
  items: unknown[],
  mapping: FieldMapping,
  baseUrl: string,
  extraFields: Record<string, string> = {},
): MappedItem[] {
  const out: MappedItem[] = [];

  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;

    const title = mapping.title ? asText(getAtPath(record, mapping.title)) : '';
    const rawUrl = mapping.url ? asText(getAtPath(record, mapping.url)) : '';
    const url = rawUrl ? absoluteUrl(rawUrl, baseUrl) : '';

    const fields: Record<string, string> = {};
    for (const field of CANONICAL_FIELDS) {
      if (field === 'title' || field === 'url') continue;
      const path = mapping[field];
      if (!path) continue;
      const text = asText(getAtPath(record, path));
      if (text) fields[field] = text;
    }

    // Metadata lain (tahun, rating, genre, ...) tetap ikut. Nama kolom tidak
    // boleh menimpa field kanonik yang sudah terisi.
    for (const [name, path] of Object.entries(extraFields)) {
      if (fields[name]) continue;
      const text = asText(getAtPath(record, path));
      if (text && text.length <= MAX_EXTRA_VALUE) fields[name] = text;
    }

    let raw = '';
    try {
      raw = JSON.stringify(item).slice(0, RAW_LIMIT);
    } catch {
      raw = '';
    }

    out.push({ url: url || rawUrl, title, fields, raw });
  }

  return out;
}
