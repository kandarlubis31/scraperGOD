/**
 * Spike S7: dari URL request + body response JSON, tebak parameter pagination
 * yang dipakai situs. Ini yang nanti dipakai `api-replay` untuk mengambil
 * halaman berikutnya tanpa klik.
 */

export interface PageHint {
  pageParam: string | null;
  pageValue: number | null;
  pageSize: number | null;
  nextCursor: string | null;
  hasMore: boolean | null;
  total: number | null;
}

const PAGE_PARAMS =
  /^(page|_page|p|pg|pageNo|page_no|pageNum|page_num|offset|start|skip|from|after|cursor|nextCursor|next_cursor)$/i;
const SIZE_PARAMS =
  /^(limit|_limit|pageSize|page_size|perPage|per_page|size|take|count)$/i;
const BODY_SIZE_KEYS = [
  'limit',
  'pageSize',
  'page_size',
  'perPage',
  'per_page',
  'size',
];
const BODY_MORE_KEYS = ['hasMore', 'has_more', 'hasNext', 'has_next'];
const BODY_CURSOR_KEYS = [
  'nextCursor',
  'next_cursor',
  'nextPageToken',
  'next_page_token',
  'nextToken',
  'next_token',
  'endCursor',
  'end_cursor',
  'cursor',
  'after',
  'next',
];

/** Nama field yang biasa dipakai untuk mengirim cursor di request. */
const CURSOR_REQUEST_KEYS = ['cursor', 'after', 'nextCursor', 'next_cursor', 'nextToken', 'endCursor'];

/** Key halaman yang dikirim di dalam body request (termasuk GraphQL). */
const BODY_PAGE_KEYS = ['page', 'offset', 'from', 'start', 'skip'];
const OFFSET_BODY_KEYS = ['offset', 'from', 'start', 'skip'];

function readSize(body: unknown): number | null {
  if (!body || typeof body !== 'object') return null;
  const record = body as Record<string, unknown>;
  for (const key of BODY_SIZE_KEYS) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return null;
}

function readBoolean(body: unknown, keys: string[]): boolean | null {
  if (!body || typeof body !== 'object') return null;
  const record = body as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'boolean') return value;
  }
  return null;
}

function readCursor(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const record = body as Record<string, unknown>;
  for (const key of BODY_CURSOR_KEYS) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) return value;
    // `next` kadang berupa object { cursor: "..." }
    if (value && typeof value === 'object') {
      const inner = (value as Record<string, unknown>).cursor;
      if (typeof inner === 'string' && inner.length > 0) return inner;
    }
  }
  // GraphQL: pageInfo { hasNextPage, endCursor }
  const pageInfo = record.pageInfo ?? (record.data as Record<string, unknown> | undefined)?.pageInfo;
  if (pageInfo && typeof pageInfo === 'object') {
    const inner = (pageInfo as Record<string, unknown>).endCursor;
    if (typeof inner === 'string' && inner.length > 0) return inner;
  }
  return null;
}

/** Cursor untuk request berikutnya, dari response halaman ini. */
export function readNextCursor(body: unknown): string | null {
  return readCursor(body);
}

export interface BodyPageHint {
  /** Path field halaman di body: `page`, `offset`, atau `variables.page`. */
  path: string;
  value: number;
  kind: 'page' | 'offset';
}

function readBodyPage(record: Record<string, unknown>, prefix: string): BodyPageHint | null {
  for (const key of BODY_PAGE_KEYS) {
    const value = record[key];
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    return {
      path: prefix ? `${prefix}.${key}` : key,
      value,
      kind: OFFSET_BODY_KEYS.includes(key) ? 'offset' : 'page',
    };
  }
  return null;
}

/**
 * Field halaman di dalam body request. GraphQL menaruhnya di `variables`,
 * endpoint REST biasa di root.
 */
export function inferBodyPageParam(body: unknown): BodyPageHint | null {
  if (!body || typeof body !== 'object') return null;
  const record = body as Record<string, unknown>;
  const root = readBodyPage(record, '');
  if (root) return root;
  const variables = record.variables;
  if (variables && typeof variables === 'object') {
    return readBodyPage(variables as Record<string, unknown>, 'variables');
  }
  return null;
}

export interface CursorParamHint {
  path: string;
  kind: 'query' | 'body';
}

/** Di mana cursor DIKIRIM (bukan di mana cursor diterima). */
export function findCursorParam(requestUrl: string, requestBody: unknown): CursorParamHint | null {
  try {
    const params = new URL(requestUrl, 'https://example.invalid').searchParams;
    for (const [key] of params.entries()) {
      if (CURSOR_REQUEST_KEYS.includes(key)) return { path: key, kind: 'query' };
    }
  } catch {
    /* URL aneh: lanjut ke body */
  }

  if (!requestBody || typeof requestBody !== 'object') return null;
  const record = requestBody as Record<string, unknown>;
  for (const key of CURSOR_REQUEST_KEYS) {
    if (key in record) return { path: key, kind: 'body' };
  }
  const variables = record.variables;
  if (variables && typeof variables === 'object') {
    for (const key of CURSOR_REQUEST_KEYS) {
      if (key in (variables as Record<string, unknown>)) {
        return { path: `variables.${key}`, kind: 'body' };
      }
    }
  }
  return null;
}

function readTotal(body: unknown): number | null {
  if (!body || typeof body !== 'object') return null;
  const record = body as Record<string, unknown>;
  const candidates = ['total', 'totalCount', 'total_count', 'totalResults'];
  for (const key of candidates) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (value && typeof value === 'object') {
      const inner = (value as Record<string, unknown>).value;
      if (typeof inner === 'number') return inner;
    }
  }
  const hits = record.hits;
  if (hits && typeof hits === 'object') {
    const total = (hits as Record<string, unknown>).total;
    if (typeof total === 'number') return total;
    if (total && typeof total === 'object') {
      const inner = (total as Record<string, unknown>).value;
      if (typeof inner === 'number') return inner;
    }
  }
  return null;
}

export function inferPagination(
  requestUrl: string,
  body: unknown,
): PageHint {
  const hint: PageHint = {
    pageParam: null,
    pageValue: null,
    pageSize: readSize(body),
    nextCursor: readCursor(body),
    hasMore: readBoolean(body, BODY_MORE_KEYS),
    total: readTotal(body),
  };

  let params: URLSearchParams;
  try {
    params = new URL(requestUrl, 'https://example.invalid').searchParams;
  } catch {
    return hint;
  }

  for (const [key, value] of params.entries()) {
    if (!PAGE_PARAMS.test(key)) continue;
    hint.pageParam = key;

    if (/^(offset|start|skip|from)$/i.test(key)) {
      const offset = Number(value);
      if (Number.isFinite(offset)) {
        hint.pageValue = offset;
        hint.pageSize = hint.pageSize ?? null;
      }
    } else if (/^cursor|^after|^next/i.test(key)) {
      hint.nextCursor = hint.nextCursor ?? value;
    } else {
      const page = Number(value);
      hint.pageValue = Number.isFinite(page) ? page : null;
    }
    break;
  }

  if (hint.pageSize === null) {
    for (const [key, value] of params.entries()) {
      if (!SIZE_PARAMS.test(key)) continue;
      const size = Number(value);
      if (Number.isFinite(size)) {
        hint.pageSize = size;
        break;
      }
    }
  }

  return hint;
}
