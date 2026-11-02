/**
 * Sumber `network`: data diambil dari response JSON yang dipakai situs sendiri.
 *
 * Ini satu-satunya jalan untuk SPA (React/Vue/Next client) yang tidak pernah
 * menaruh daftar di HTML dan tidak punya JSON tersemat di DOM. Modul ini murni:
 * tidak menyentuh `window`/`chrome.*`, supaya bisa dites dengan fixture.
 */

import type { ApiPlan, PageItem, PageSnapshot } from '@/src/shared/types';
import { applySecrets, redactBodyTemplate, redactUrl, type SecretSource } from './secrets';

/** Satu pintu untuk helper token: dipakai SW, content script, dan test. */
export * from './secrets';
import { absoluteUrl, urlKey } from '@/src/shared/url';
import {
  findCursorParam,
  inferBodyPageParam,
  inferPagination,
  readNextCursor,
} from '@/src/net/paginate';
import { autoMapAll, findItemArrays, getAtPath, toPageItems } from './json';

export interface NetworkCapture {
  url: string;
  method: string;
  status: number;
  contentType: string;
  /** Body request POST/GraphQL; null untuk GET. Header lain tidak direkam. */
  requestBody?: string | null;
  requestContentType?: string | null;
  /** Body dipotong saat capture: JSON-nya tidak utuh, jangan diparse. */
  truncated: boolean;
  capturedAt: number;
  body: string;
}

export const NETWORK_LIMITS = {
  /** Cukup untuk beberapa request pagination, tidak menahan seluruh sesi. */
  maxCaptures: 12,
  maxBodyBytes: 512_000,
  minItems: 3,
  /** Body di atas ini tidak dikirim ke SW walau diparse. */
  maxRenderBytes: 2_000_000,
} as const;

function mappedFieldCount(api: ApiPlan): number {
  return Object.values(api.mapping).filter(Boolean).length;
}

function isOffsetParam(param: string): boolean {
  return /^(offset|start|skip|from)$/i.test(param);
}

export interface NetworkSource {
  api: ApiPlan;
  items: PageItem[];
  itemCount: number;
  score: number;
  notes: string[];
  /** URL request asli, untuk ditampilkan di UI. */
  requestUrl: string;
}

export interface NetworkAnalysis {
  source: NetworkSource | null;
  /** Alasan capture ini ditolak, dipakai probe notes. */
  note: string | null;
}

/**
 * Mengubah satu capture jadi rencana API yang siap dipakai SW.
 * Menolak dengan alasan, bukan diam: user perlu tahu kenapa API tidak dipakai.
 */
export function analyzeCapture(
  capture: NetworkCapture,
  baseUrl: string,
): NetworkAnalysis {
  const reject = (note: string): NetworkAnalysis => ({ source: null, note });

  // `fetch('/api/jobs?page=1')` sangat umum. Rencana yang menyimpan URL relatif
  // akan menembak path di origin mana pun tab berada saat replay — salah situs.
  const requestUrl = absoluteUrl(capture.url, baseUrl);
  if (!requestUrl) return reject(`URL ${capture.url} tidak bisa dipakai ulang.`);

  if (capture.truncated) {
    return reject(`Response ${capture.url} terpotong saat direkam.`);
  }
  if (capture.status >= 400) {
    return reject(`Response ${capture.url} berstatus ${capture.status}.`);
  }
  const method = (capture.method || 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'POST') {
    return reject(
      `Request ${method} ${capture.url} belum didukung; replay hanya GET dan POST.`,
    );
  }
  if (method === 'POST' && !capture.requestBody) {
    // Replay POST tanpa body identik akan mengirim permintaan yang berbeda dari
    // milik situs: hasilnya halaman salah yang tidak terlihat salah.
    return reject(`Request POST ${capture.url} tanpa body terekam; tidak bisa direplay.`);
  }

  let requestBody: unknown = null;
  if (capture.requestBody) {
    try {
      requestBody = JSON.parse(capture.requestBody);
    } catch {
      return reject(`Body request ${capture.url} bukan JSON; tidak bisa diubah per halaman.`);
    }
  }

  let json: unknown;
  try {
    json = JSON.parse(capture.body);
  } catch {
    return reject(`Response ${capture.url} bukan JSON utuh.`);
  }

  const arrays = findItemArrays(json, { minItems: NETWORK_LIMITS.minItems });
  if (arrays.length === 0) {
    return reject(`Tidak ada array item di ${capture.url}.`);
  }

  const found = arrays[0]!;
  const sample = found.items.find(
    (item) => item !== null && typeof item === 'object' && !Array.isArray(item),
  );
  if (!sample) return reject(`Array ${found.path} tidak berisi objek.`);

  const { mapping, extraFields } = autoMapAll(sample as Record<string, unknown>);
  if (!mapping.title && !mapping.url && Object.keys(extraFields).length === 0) {
    return reject(`Array ${found.path} tidak punya nilai yang bisa diambil.`);
  }

  const items = toPageItems(found.items, mapping, baseUrl, extraFields);
  if (items.length === 0) return reject(`Array ${found.path} tidak menghasilkan item.`);

  const hint = inferPagination(requestUrl, json);
  const bodyPage = method === 'POST' ? inferBodyPageParam(requestBody) : null;
  // Token di URL/body TIDAK boleh masuk DB. Nilai aslinya hanya ada di hook
  // MAIN world, dan diisi ulang saat replay dari request terbaru.
  const storedUrl = redactUrl(requestUrl);
  const bodyTemplate =
    method === 'POST' ? redactBodyTemplate(capture.requestBody) : null;
  // `?cursor=...` terbaca sebagai parameter halaman oleh inferPagination; itu
  // bukan nomor halaman, jadi dipisah supaya tidak diisi angka 1,2,3.
  const urlCursorParam =
    hint.pageParam && /^(cursor|nextcursor|next_cursor|after|next|endcursor)$/i.test(hint.pageParam)
      ? hint.pageParam
      : null;
  const pageParam = hint.pageParam && !urlCursorParam ? hint.pageParam : null;
  const cursorParam =
    findCursorParam(requestUrl, requestBody) ??
    (urlCursorParam ? { path: urlCursorParam, kind: 'query' as const } : null);
  const cursor = readNextCursor(json);

  if (!pageParam && !bodyPage && !(cursorParam && cursor !== null)) {
    return reject(
      `Pagination ${requestUrl} tidak terbaca (tidak ada parameter halaman/cursor).`,
    );
  }
  if (!pageParam && !bodyPage && cursorParam && cursor === null) {
    return reject(
      `Cursor di ${requestUrl} tidak ditemukan pada respons; tidak bisa dilanjutkan.`,
    );
  }

  const pageSize = hint.pageSize ?? found.items.length;
  const offset = pageParam ? isOffsetParam(pageParam) : bodyPage?.kind === 'offset';

  const api: ApiPlan = {
    url: storedUrl,
    method,
    // Body POST disimpan dengan nilai token diganti placeholder: struktur dan
    // field lain tetap identik dengan milik situs.
    bodyTemplate,
    bodyPageParam: bodyPage?.path ?? null,
    contentType: capture.requestContentType ?? null,
    cursorParam: cursorParam?.path ?? null,
    cursorKind: cursorParam?.kind ?? null,
    arrayPath: found.path,
    mapping,
    extraFields,
    pageParam,
    pageKind: pageParam ? (offset ? 'offset' : 'page') : bodyPage?.kind ?? 'page',
    pageValue: hint.pageValue ?? bodyPage?.value ?? (offset ? 0 : 1),
    pageSize: pageSize > 0 ? pageSize : null,
    total: hint.total,
    verified: false,
    verifyNote: null,
  };

  return {
    source: {
      api,
      items,
      itemCount: items.length,
      score: 120 + Math.min(items.length, 40) + mappedFieldCount(api) * 2,
      notes: [
        `JSON jaringan dipakai (${found.path || '$'} · ${items.length} item).`,
      ],
      requestUrl: storedUrl,
    },
    note: null,
  };
}

export interface NetworkScan {
  sources: NetworkSource[];
  notes: string[];
}

/** Semua capture diperiksa; yang skornya tertinggi dipakai probe. */
export function scanCaptures(
  captures: NetworkCapture[],
  baseUrl: string,
): NetworkScan {
  const sources: NetworkSource[] = [];
  const notes: string[] = [];

  for (const capture of captures) {
    const { source, note } = analyzeCapture(capture, baseUrl);
    if (source) sources.push(source);
    else if (note) notes.push(note);
  }

  sources.sort((a, b) => b.score - a.score);
  return { sources, notes };
}

/**
 * URL halaman ke-`pageIndex` (0 = halaman pertama yang tertangkap).
 * Parameter lain dipertahankan apa adanya, termasuk filter yang dipilih user.
 */
function setAtPath(target: unknown, path: string, value: unknown): void {
  if (!target || typeof target !== 'object') return;
  const parts = path.split('.').filter(Boolean);
  let node = target as Record<string, unknown>;
  for (const part of parts.slice(0, -1)) {
    const next = node[part];
    if (!next || typeof next !== 'object') return;
    node = next as Record<string, unknown>;
  }
  const last = parts[parts.length - 1];
  if (last) node[last] = value;
}

export interface ApiRequestParts {
  url: string;
  method: string;
  body: string | null;
  contentType: string | null;
}

/**
 * Request halaman ke-`pageIndex` (0 = halaman pertama yang tertangkap).
 *
 * Body POST dikirim identik dengan milik situs; hanya field halaman (atau
 * cursor) yang diubah. Cookie dan Authorization tidak pernah ikut di sini —
 * keduanya milik browser (`credentials: 'include'` di MAIN world).
 */
export function apiRequest(
  api: ApiPlan,
  pageIndex: number,
  cursor: string | null = null,
  secrets: SecretSource | null = null,
): ApiRequestParts {
  const step = api.pageKind === 'offset' ? (api.pageSize ?? 0) : 1;
  const nextValue = api.pageValue + pageIndex * step;

  let url = api.url;
  try {
    const parsed = new URL(api.url);
    if (api.pageParam) {
      parsed.searchParams.set(api.pageParam, String(nextValue));
    }
    if (api.cursorParam && api.cursorKind === 'query' && cursor) {
      parsed.searchParams.set(api.cursorParam, cursor);
    }
    url = parsed.toString();
  } catch {
    /* URL rusak: pakai apa adanya, replay akan gagal dengan pesan jelas */
  }

  let body = api.bodyTemplate;
  if (api.bodyTemplate) {
    try {
      const parsedBody: unknown = JSON.parse(api.bodyTemplate);
      if (api.bodyPageParam) setAtPath(parsedBody, api.bodyPageParam, nextValue);
      if (api.cursorParam && api.cursorKind === 'body' && cursor) {
        setAtPath(parsedBody, api.cursorParam, cursor);
      }
      body = JSON.stringify(parsedBody);
    } catch {
      /* template bukan JSON: kirim apa adanya */
    }
  }

  // Placeholder token diisi dari request asli terbaru yang ditangkap hook.
  const filled = applySecrets(url, body, secrets);
  return {
    url: filled.url,
    method: api.method || 'GET',
    body: filled.body,
    contentType: api.contentType,
  };
}

/** URL halaman ke-`pageIndex`; tetap ada untuk tampilan dan pemeriksaan. */
export function apiPageUrl(api: ApiPlan, pageIndex: number, cursor: string | null = null): string {
  if (!api.pageParam && !(api.cursorParam && api.cursorKind === 'query')) return api.url;
  return apiRequest(api, pageIndex, cursor).url;
}

/**
 * Apakah masih ada halaman berikutnya. Tiga sinyal dipakai berurutan:
 * jumlah item yang diterima, `total` dari situs, dan ada/tidaknya parameter.
 */
export function hasMorePages(
  api: ApiPlan,
  pageIndex: number,
  received: number,
  cursor: string | null = null,
): boolean {
  if (received === 0) return false;
  if (api.pageSize !== null && received < api.pageSize) return false;
  if (api.total !== null && api.pageSize !== null) {
    if ((pageIndex + 1) * api.pageSize >= api.total) return false;
  }
  // Tanpa nomor halaman, lanjutan hanya mungkin kalau respons memberi cursor.
  if (!api.pageParam && !api.bodyPageParam) {
    if (!api.cursorParam) return false;
    return typeof cursor === 'string' && cursor.length > 0;
  }
  return true;
}

/** Response satu halaman → snapshot yang bisa dicerna engine. */
export function snapshotFromApiPage(
  json: unknown,
  api: ApiPlan,
  pageUrl: string,
  pageIndex: number,
): PageSnapshot {
  const array = getAtPath(json, api.arrayPath);
  const items = Array.isArray(array)
    ? toPageItems(array, api.mapping, pageUrl, api.extraFields ?? {})
    : [];
  const nextCursor = readNextCursor(json);
  const more = hasMorePages(api, pageIndex, items.length, nextCursor);

  return {
    items,
    nextUrl: more ? apiPageUrl(api, pageIndex + 1, nextCursor) : null,
    source: 'network',
    selector: api.arrayPath || '$',
    nextCursor,
  };
}

/**
 * Seberapa banyak halaman 2 mengulang halaman 1. Situs lowongan sering
 * menaruh 1-3 item sponsor di setiap halaman, jadi sebagian kecil item berulang
 * itu normal; rencana hanya ditolak kalau hampir seluruh halaman 2 berulang
 * (parameter halaman/cursor tidak berpengaruh).
 */
export interface PageOverlap {
  /** Persentase item halaman 2 yang juga muncul di halaman 1 (0-1). */
  ratio: number;
  /** Ada = rencana tidak layak dipakai. */
  rejected: string | null;
  /** Catatan non-fatal untuk probe notes. */
  note: string | null;
}

const REJECT_OVERLAP = 0.9;

export function pageOverlap(
  first: PageItem[],
  second: PageItem[],
  baseUrl: string,
): PageOverlap {
  const before = new Set(first.map((item) => urlKey(item.url, baseUrl)).filter(Boolean));
  const after = [...new Set(second.map((item) => urlKey(item.url, baseUrl)).filter(Boolean))];

  if (before.size === 0 || after.length === 0) {
    return { ratio: 0, rejected: null, note: null };
  }

  const repeated = after.filter((key) => before.has(key)).length;
  const ratio = repeated / after.length;
  const percent = Math.round(ratio * 100);

  if (ratio >= REJECT_OVERLAP) {
    return {
      ratio,
      rejected: `Halaman 2 hampir identik dengan halaman 1 (${percent}% item sama): parameter halaman/cursor tidak berpengaruh. Rencana API ditolak; ambil lewat halaman biasa.`,
      note: null,
    };
  }
  if (repeated > 0) {
    return {
      ratio,
      note: `Halaman 2 mengulang ${percent}% item halaman 1 (sponsor/duplikat); rencana tetap dipakai.`,
      rejected: null,
    };
  }
  return { ratio, rejected: null, note: null };
}

/** Alias lama: hanya alasan penolakan. */
export function identicalPageNote(
  first: PageItem[],
  second: PageItem[],
  baseUrl: string,
): string | null {
  return pageOverlap(first, second, baseUrl).rejected;
}

/**
 * Status yang berarti "berhenti, jangan dipaksa". Meneruskan hanya akan memicu
 * pemblokiran yang lebih keras dan membuang kuota user.
 */
export function blockedReason(status: number, body: string): string | null {
  const text = body.slice(0, 2_000).toLowerCase();
  if (status === 403) return 'Situs menolak akses (403). Run dihentikan, tidak dipaksa.';
  if (status === 401) return 'Sesi/login tidak berlaku (401). Masuk dulu, lalu Lanjutkan.';
  if (/captcha|cf-challenge|are you a robot|recaptcha|hcaptcha/.test(text)) {
    return 'Situs meminta verifikasi captcha. Run dihentikan.';
  }
  if (status >= 400 && /(sign in|log in|login required|masuk untuk|please log ?in)/.test(text)) {
    return 'Halaman meminta login (sesi mungkin habis). Masuk dulu, lalu Lanjutkan.';
  }
  return null;
}

/** Teks yang aman ditampilkan: URL tanpa query panjang. */
export function shortRequestUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname}`;
  } catch {
    return url;
  }
}
