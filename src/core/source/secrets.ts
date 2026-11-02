/**
 * Token, cookie, dan kunci sesi TIDAK boleh masuk DB.
 *
 * `ApiPlan` disimpan di Dexie dan bisa dibaca dari mana saja di ekstensi, jadi
 * nilai sensitif yang tertangkap hook diganti placeholder sebelum disimpan.
 * Saat replay, nilai aslinya diambil lagi dari request terbaru yang masih
 * dipegang hook di MAIN world. Kalau request itu sudah tidak ada (halaman
 * di-reload, tab ditutup), run berhenti dengan pesan yang jelas — bukan
 * menebak atau mengirim body yang setengah jadi.
 *
 * Modul ini murni: tidak menyentuh DOM, `window`, atau `chrome.*`.
 */

export const SECRET_PLACEHOLDER = '__SCRAPERGOD_SECRET__';

/**
 * Kata utuh yang menandakan nilai rahasia. Dicocokkan per kata, bukan sebagai
 * substring: `author`/`authorId` BUKAN rahasia, sedangkan `auth`,
 * `authorization`, dan `authToken` ya.
 */
const SECRET_WORDS = new Set([
  'token',
  'csrf',
  'xsrf',
  'secret',
  'password',
  'passwd',
  'jwt',
  'bearer',
  'session',
  'auth',
  'authorization',
  'cookie',
  'credential',
  'credentials',
]);

/** `csrfToken` → ['csrf','token'], `x-auth-token` → ['x','auth','token']. */
function keyWords(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase());
}

export function isSecretKey(key: string): boolean {
  const parts = keyWords(key);
  if (parts.length === 0) return false;

  // `apiKey`, `api_key`, dan `apikey` sama-sama berarti kunci API; `key`
  // sendirian tidak (banyak field bernama `key` yang bukan rahasia).
  if (parts.join('').includes('apikey')) return true;

  return parts.some(
    (part) =>
      SECRET_WORDS.has(part) ||
      // Kata gabungan tanpa pemisah: `accesstoken`, `csrftoken`, `authtoken`.
      part.endsWith('token') ||
      part.endsWith('secret') ||
      part.endsWith('password'),
  );
}

/** Nilai rahasia diganti placeholder; struktur body tetap utuh. */
export function redactBodyValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactBodyValue);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      // Nilai objek di bawah key rahasia ikut dibuang seluruhnya: menelusuri
      // isinya berarti membiarkan field bernama aman (mis. `id`) ikut tersimpan.
      out[key] = isSecretKey(key) ? SECRET_PLACEHOLDER : redactBodyValue(child);
    }
    return out;
  }
  return value;
}

/** Body request (JSON) dengan nilai rahasia disunting. Bukan JSON: null. */
export function redactBodyTemplate(body: string | null | undefined): string | null {
  if (!body) return null;
  try {
    return JSON.stringify(redactBodyValue(JSON.parse(body)));
  } catch {
    return null;
  }
}

/** Query param yang namanya cocok pola rahasia diganti placeholder. */
export function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    let changed = false;
    for (const key of [...parsed.searchParams.keys()]) {
      if (isSecretKey(key)) {
        parsed.searchParams.set(key, SECRET_PLACEHOLDER);
        changed = true;
      }
    }
    return changed ? parsed.toString() : url;
  } catch {
    return url;
  }
}

/** Rencana yang butuh nilai rahasia dari hook untuk bisa direplay. */
export function needsSecrets(api: { url: string; bodyTemplate?: string | null }): boolean {
  return api.url.includes(SECRET_PLACEHOLDER) || (api.bodyTemplate ?? '').includes(SECRET_PLACEHOLDER);
}

export interface SecretSource {
  url: string | null;
  body: string | null;
}

/** Bentuk minimal capture yang dibutuhkan pencarian; mudah dites. */
export interface CapturedRequest {
  url: string;
  method: string;
  requestBody?: string | null;
}

/**
 * Request terbaru yang cocok dengan rencana (origin + path + method). Query
 * tidak dibandingkan karena isinya memang berbeda per halaman.
 */
export function findSecretSource(
  plan: { url: string; method?: string | null },
  captures: CapturedRequest[],
): SecretSource | null {
  let target: URL;
  try {
    target = new URL(plan.url);
  } catch {
    return null;
  }
  const method = (plan.method ?? 'GET').toUpperCase();

  for (const capture of captures) {
    if ((capture.method || 'GET').toUpperCase() !== method) continue;
    let candidate: URL;
    try {
      candidate = new URL(capture.url, target);
    } catch {
      continue;
    }
    if (candidate.origin !== target.origin) continue;
    if (candidate.pathname !== target.pathname) continue;
    return { url: candidate.toString(), body: capture.requestBody ?? null };
  }

  return null;
}

function fillBody(node: unknown, source: unknown): unknown {
  if (node === SECRET_PLACEHOLDER) return source === undefined ? node : source;
  if (Array.isArray(node)) {
    const list = Array.isArray(source) ? source : [];
    return node.map((item, index) => fillBody(item, list[index]));
  }
  if (node && typeof node === 'object') {
    const src =
      source && typeof source === 'object' && !Array.isArray(source)
        ? (source as Record<string, unknown>)
        : {};
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      out[key] = fillBody(child, src[key]);
    }
    return out;
  }
  return node;
}

function fillUrl(url: string, sourceUrl: string | null): string {
  if (!url.includes(SECRET_PLACEHOLDER)) return url;
  try {
    const target = new URL(url);
    const source = sourceUrl ? new URL(sourceUrl) : null;
    for (const key of [...target.searchParams.keys()]) {
      if (target.searchParams.get(key) !== SECRET_PLACEHOLDER) continue;
      const real = source?.searchParams.get(key);
      if (real) target.searchParams.set(key, real);
    }
    return target.toString();
  } catch {
    return url;
  }
}

/**
 * Isi placeholder dari request asli terbaru. Placeholder yang tidak punya
 * padanan dibiarkan: pemanggil memeriksa `hasUnfilledSecrets` dan berhenti
 * dengan pesan jelas, bukan mengirim body yang salah.
 */
export function applySecrets(
  url: string,
  body: string | null,
  source: SecretSource | null,
): { url: string; body: string | null } {
  if (!source) return { url, body };
  const filledUrl = fillUrl(url, source.url);

  let filledBody = body;
  if (body && body.includes(SECRET_PLACEHOLDER)) {
    try {
      const template: unknown = JSON.parse(body);
      const original: unknown = source.body ? JSON.parse(source.body) : null;
      filledBody = JSON.stringify(fillBody(template, original));
    } catch {
      /* body bukan JSON: biarkan placeholder, pemeriksaan di bawah menangkap */
    }
  }

  return { url: filledUrl, body: filledBody };
}

/**
 * Nama key yang placeholder-nya belum terisi, supaya pesan berhenti bisa
 * menyebut apa yang hilang ("csrfToken", "variables.authToken").
 */
export function unfilledSecretKeys(parts: {
  url: string;
  body: string | null;
}): string[] {
  const keys: string[] = [];

  if (parts.url.includes(SECRET_PLACEHOLDER)) {
    try {
      for (const [key, value] of new URL(parts.url).searchParams.entries()) {
        if (value === SECRET_PLACEHOLDER) keys.push(key);
      }
    } catch {
      keys.push('url');
    }
  }

  const body = parts.body ?? '';
  if (body.includes(SECRET_PLACEHOLDER)) {
    const walk = (node: unknown, path: string): void => {
      if (node === SECRET_PLACEHOLDER) {
        keys.push(path || 'body');
        return;
      }
      if (Array.isArray(node)) {
        node.forEach((item, index) => walk(item, `${path}[${index}]`));
        return;
      }
      if (node && typeof node === 'object') {
        for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
          walk(child, path ? `${path}.${key}` : key);
        }
      }
    };
    try {
      walk(JSON.parse(body), '');
    } catch {
      keys.push('body');
    }
  }

  return [...new Set(keys)];
}

/** Masih ada placeholder tersisa = replay tidak boleh dilakukan. */
export function hasUnfilledSecrets(parts: { url: string; body: string | null }): boolean {
  return unfilledSecretKeys(parts).length > 0;
}
