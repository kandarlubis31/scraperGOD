/**
 * Hook jaringan (spike S4): membungkus `fetch` dan `XMLHttpRequest` untuk
 * menangkap response JSON milik halaman.
 *
 * Aturan main:
 * - Tidak menyentuh body request, tidak mengubah response.
 * - Hanya membaca kalau `armed()` true (default false), jadi biaya nol sampai
 *   user menyalakan mode "sumber API" untuk domain tersebut.
 * - Sample dipotong; body besar tidak pernah disimpan utuh.
 */

export interface CaptureRecord {
  url: string;
  method: string;
  status: number;
  contentType: string;
  /**
   * Body request apa adanya, HANYA untuk string. Header sengaja tidak pernah
   * disimpan: cookie dan Authorization tidak boleh masuk DB.
   */
  requestBody: string | null;
  requestContentType: string | null;
  size: number;
  sample: string;
  /** true = `sample` terpotong; JSON-nya tidak bisa diparse. */
  truncated: boolean;
  arrayPath: string | null;
  itemCount: number | null;
  total: number | null;
  at: number;
}

export interface JsonSummary {
  primaryArrayPath: string | null;
  primaryArrayLength: number | null;
  total: number | null;
}

export interface HookOptions {
  armed: () => boolean;
  onCapture: (record: CaptureRecord) => void;
  maxSampleBytes?: number;
}

export interface HookTarget {
  fetch?: (...args: any[]) => Promise<any>;
  XMLHttpRequest?: any;
}

const MAX_BODY_BYTES = 2_000_000;
/** Body request di atas ini terlalu besar untuk dijadikan template replay. */
const MAX_REQUEST_BODY = 64_000;
const ARRAY_DEPTH_LIMIT = 4;
const TOTAL_KEYS = [
  'total',
  'totalCount',
  'total_count',
  'totalResults',
  'total_results',
  'numFound',
  'resultCount',
];

/** Cari array of objects terbesar + angka total, untuk ditebak sebagai sumber data. */
export function summarizeJson(value: unknown): JsonSummary {
  const arrays: { path: string; length: number }[] = [];

  const walk = (node: unknown, path: string, depth: number): void => {
    if (depth > ARRAY_DEPTH_LIMIT || node === null || typeof node !== 'object') {
      return;
    }

    if (Array.isArray(node)) {
      const objectItems = node.filter(
        (item) => item !== null && typeof item === 'object',
      );
      if (objectItems.length >= 2) {
        arrays.push({ path: path || '$', length: node.length });
      }
      if (node.length > 0) walk(node[0], `${path}[0]`, depth + 1);
      return;
    }

    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      walk(child, path ? `${path}.${key}` : key, depth + 1);
    }
  };

  walk(value, '', 0);

  return {
    primaryArrayPath: arrays.sort((a, b) => b.length - a.length)[0]?.path ?? null,
    primaryArrayLength: arrays[0]?.length ?? null,
    total: findTotal(value),
  };
}

function findTotal(value: unknown): number | null {
  const seen = new Set<unknown>();

  const walk = (node: unknown, depth: number): number | null => {
    if (!node || typeof node !== 'object' || depth > 3 || seen.has(node)) {
      return null;
    }
    seen.add(node);

    if (Array.isArray(node)) {
      for (const item of node.slice(0, 3)) {
        const found = walk(item, depth + 1);
        if (found !== null) return found;
      }
      return null;
    }

    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      if (
        TOTAL_KEYS.includes(key) &&
        typeof child === 'number' &&
        Number.isFinite(child)
      ) {
        return child;
      }
      if (key === 'total' && child && typeof child === 'object') {
        const inner = (child as Record<string, unknown>).value;
        if (typeof inner === 'number') return inner;
      }
      if (child && typeof child === 'object') {
        const found = walk(child, depth + 1);
        if (found !== null) return found;
      }
    }

    return null;
  };

  return walk(value, 0);
}

function headerValue(response: any, name: string): string {
  const headers = response?.headers;
  if (!headers) return '';
  if (typeof headers.get === 'function') return String(headers.get(name) ?? '');
  return '';
}

/** Hanya content-type yang boleh keluar dari header request. */
function readRequestContentType(headers: any): string | null {
  if (!headers) return null;
  try {
    if (typeof headers.get === 'function') return headers.get('content-type') ?? null;
    if (Array.isArray(headers)) {
      for (const pair of headers) {
        if (Array.isArray(pair) && String(pair[0]).toLowerCase() === 'content-type') {
          return String(pair[1]);
        }
      }
      return null;
    }
    if (typeof headers === 'object') {
      for (const [key, value] of Object.entries(headers)) {
        if (key.toLowerCase() === 'content-type') return String(value);
      }
    }
  } catch {
    /* headers aneh: jangan gagalkan request halaman */
  }
  return null;
}

function inspectResponse(
  url: string,
  method: string,
  response: any,
  options: HookOptions,
  requestBody: string | null,
  requestContentType: string | null,
): void {
  const contentType = headerValue(response, 'content-type');
  if (!/json/i.test(contentType)) return;

  const clone = typeof response.clone === 'function' ? response.clone() : response;
  if (typeof clone?.text !== 'function') return;

  void clone
    .text()
    .then((body: string) => {
      if (!body || body.length > MAX_BODY_BYTES) return;
      const trimmed = body.trimStart();
      if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return;

      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        return;
      }

      const summary = summarizeJson(parsed);
      const limit = options.maxSampleBytes ?? 8192;
      options.onCapture({
        url,
        method,
        status: Number(response?.status ?? 0),
        contentType,
        requestBody,
        requestContentType,
        size: body.length,
        sample: trimmed.slice(0, limit),
        truncated: trimmed.length > limit,
        arrayPath: summary.primaryArrayPath,
        itemCount: summary.primaryArrayLength,
        total: summary.total,
        at: Date.now(),
      });
    })
    .catch(() => {
      /* response tidak terbaca: abaikan, jangan ganggu halaman */
    });
}

/**
 * Menulis properti tanpa pernah melempar.
 *
 * Halaman boleh membekukan `window` atau prototype-nya (sebagian situs memang
 * begitu), dan modul ES berjalan di strict mode: satu assignment ke properti
 * read-only langsung melempar TypeError. Dulu itu mematikan seluruh content
 * script MAIN world ("crashed on startup") padahal hook ini opsional.
 */
function safeAssign(target: any, key: string, value: unknown): boolean {
  try {
    target[key] = value;
    return true;
  } catch {
    /* read-only di strict mode */
  }

  try {
    Object.defineProperty(target, key, {
      value,
      configurable: true,
      writable: true,
      enumerable: true,
    });
    return true;
  } catch {
    return false;
  }
}

export function installFetchHook(target: HookTarget, options: HookOptions): void {
  const original = target.fetch;
  if (typeof original !== 'function') return;
  if ((original as any).__scrapergodHooked) return;

  const hooked = function (this: unknown, input: any, init?: any) {
    const promise = original.call(target, input, init);
    if (!options.armed()) return promise;

    const url =
      typeof input === 'string' ? input : String(input?.url ?? '');
    const method = String(init?.method ?? input?.method ?? 'GET').toUpperCase();
    const body = init?.body;
    const requestBody =
      typeof body === 'string' && body.length <= MAX_REQUEST_BODY ? body : null;
    const requestContentType =
      readRequestContentType(init?.headers) ??
      readRequestContentType((input as any)?.headers) ??
      null;

    return Promise.resolve(promise).then((response) => {
      try {
        inspectResponse(url, method, response, options, requestBody, requestContentType);
      } catch {
        /* jangan pernah merusak request halaman */
      }
      return response;
    });
  };

  (hooked as any).__scrapergodHooked = true;
  // Gagal memasang = tidak apa-apa: halaman tetap memakai fetch aslinya.
  safeAssign(target, 'fetch', hooked);
}

export function installXhrHook(target: HookTarget, options: HookOptions): void {
  const XHR = target.XMLHttpRequest;
  const proto = XHR?.prototype;
  if (!proto || proto.__scrapergodHooked) return;

  const originalOpen = proto.open;
  const originalSend = proto.send;
  const originalSetHeader = proto.setRequestHeader;
  // Prototype tanpa `open`/`send` bukan XHR yang kita kenal: jangan sentuh.
  if (typeof originalOpen !== 'function' || typeof originalSend !== 'function') return;

  const openHook = function (this: any, method: string, url: string | URL, ...rest: any[]) {
    try {
      this.__scrapergodRequest = {
        method: String(method).toUpperCase(),
        url: String(url),
      };
    } catch {
      /* objek XHR terkunci: lewati pencatatan, jangan ganggu request */
    }
    return originalOpen.call(this, method, url, ...rest);
  };

  const setHeaderHook = function (this: any, name: string, value: string) {
    try {
      if (String(name).toLowerCase() === 'content-type') {
        this.__scrapergodContentType = String(value);
      }
    } catch {
      /* objek XHR terkunci */
    }
    return originalSetHeader?.call(this, name, value);
  };

  const sendHook = function (this: any, body?: unknown) {
    try {
      this.__scrapergodBody =
        typeof body === 'string' && body.length <= MAX_REQUEST_BODY ? String(body) : null;
    } catch {
      /* objek XHR terkunci */
    }
    // XHR bisa dipakai ulang untuk beberapa request; tanpa penanda ini,
    // listener menumpuk dan satu response dicatat berkali-kali.
    if (this.__scrapergodListening) return originalSend.apply(this, [body]);

    const listen = () => {
      this.addEventListener('load', () => {
      if (!options.armed()) return;
      try {
        const request = this.__scrapergodRequest ?? { method: 'GET', url: '' };
        const contentType = String(this.getResponseHeader?.('content-type') ?? '');
        if (!/json/i.test(contentType)) return;

        const responseType = this.responseType ?? '';
        if (responseType !== '' && responseType !== 'text') return;

        const body = String(this.responseText ?? '');
        if (!body || body.length > MAX_BODY_BYTES) return;
        const parsed = JSON.parse(body);
        const summary = summarizeJson(parsed);
        const limit = options.maxSampleBytes ?? 8192;
        options.onCapture({
          url: request.url,
          method: request.method,
          status: Number(this.status ?? 0),
          contentType,
          requestBody: this.__scrapergodBody ?? null,
          requestContentType: this.__scrapergodContentType ?? null,
          size: body.length,
          sample: body.slice(0, limit),
          truncated: body.length > limit,
          arrayPath: summary.primaryArrayPath,
          itemCount: summary.primaryArrayLength,
          total: summary.total,
          at: Date.now(),
        });
      } catch {
        /* respons bukan JSON yang valid: abaikan */
      }
      });
    };

    try {
      listen();
    } catch {
      /* addEventListener diblokir halaman */
    }

    return originalSend.apply(this, [body]);
  };

  // Dipasang semua atau tidak sama sekali: XHR setengah ter-hook bisa membuat
  // request situs kehilangan URL/metodenya dan merusak halaman.
  const installed =
    safeAssign(proto, 'open', openHook) &&
    safeAssign(proto, 'setRequestHeader', setHeaderHook) &&
    safeAssign(proto, 'send', sendHook);

  if (!installed) {
    safeAssign(proto, 'open', originalOpen);
    safeAssign(proto, 'setRequestHeader', originalSetHeader);
    safeAssign(proto, 'send', originalSend);
    return;
  }

  safeAssign(proto, '__scrapergodHooked', true);
}
