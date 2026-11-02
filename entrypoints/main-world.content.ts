import { NETWORK_LIMITS } from '../src/core/source/network';
import {
  ARM_STORAGE_KEY,
  BRIDGE_SOURCE,
  isBridgeMessage,
  type BridgeMessage,
} from '../src/net/bridge';
import { installFetchHook, installXhrHook, type CaptureRecord } from '../src/net/hook';

/**
 * Hook jaringan di MAIN world, `document_start`, supaya response JSON milik
 * situs diamati sebelum aplikasi SPA-nya berjalan.
 *
 * Default MATI. Dinyalakan hanya lewat content script (jembatan
 * `page-bridge.ts`), dan pilihannya disimpan di sessionStorage tab ini saja —
 * bukan di semua situs, bukan permanen.
 *
 * Capture disimpan di sini (satu tempat, ukurannya dibatasi) lalu ditarik oleh
 * content script saat probe. Content script tidak perlu siap sebelum fetch
 * pertama situs: itu yang membuat perekaman API bisa diandalkan.
 */

const REPLAY_MAX_BYTES = 4_000_000;

function post(message: BridgeMessage): void {
  try {
    window.postMessage(message, '*');
  } catch {
    /* CSP ketat: fitur ini mati, sisa ekstensi tetap jalan */
  }
}

function readArm(): boolean {
  try {
    return sessionStorage.getItem(ARM_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function writeArm(armed: boolean): void {
  try {
    if (armed) sessionStorage.setItem(ARM_STORAGE_KEY, '1');
    else sessionStorage.removeItem(ARM_STORAGE_KEY);
  } catch {
    /* sessionStorage diblokir: arm tetap berlaku untuk dokumen ini */
  }
}

/**
 * Seluruh isi MAIN world dibungkus: perekaman API ini opsional, dan satu
 * halaman yang membekukan `window`/`fetch` tidak boleh membuat Chrome
 * melaporkan "content script crashed on startup". Kalau gagal, picker dan
 * pengambilan DOM tetap jalan.
 */
function startBridge(): void {
  let armed = readArm();
  const captures: CaptureRecord[] = [];

  const onCapture = (record: CaptureRecord) => {
    captures.push(record);
    if (captures.length > NETWORK_LIMITS.maxCaptures) captures.shift();
  };

  installFetchHook(window as unknown as Parameters<typeof installFetchHook>[0], {
    armed: () => armed,
    onCapture,
    maxSampleBytes: NETWORK_LIMITS.maxBodyBytes,
  });
  installXhrHook(window as unknown as Parameters<typeof installXhrHook>[0], {
    armed: () => armed,
    onCapture,
    maxSampleBytes: NETWORK_LIMITS.maxBodyBytes,
  });

  window.addEventListener('message', (event: MessageEvent) => {
    if (event.source !== window) return;
    const data: unknown = event.data;
    if (!isBridgeMessage(data) || data.dir !== 'page->main') return;

    if (data.type === 'arm') {
      armed = true;
      writeArm(true);
      post({ source: BRIDGE_SOURCE, dir: 'main->page', type: 'armed', armed: true });
      return;
    }

    if (data.type === 'disarm') {
      armed = false;
      writeArm(false);
      captures.length = 0;
      post({ source: BRIDGE_SOURCE, dir: 'main->page', type: 'armed', armed: false });
      return;
    }

    if (data.type === 'list') {
      post({
        source: BRIDGE_SOURCE,
        dir: 'main->page',
        type: 'captures',
        // Salinan dangkal: objek capture tidak dimutasi setelah dibuat.
        captures: [...captures],
      });
      return;
    }

    if (data.type === 'replay') {
      const { id, url } = data;
      const method = (data.method ?? 'GET').toUpperCase();
      const body = typeof data.body === 'string' ? data.body : null;
      // Hanya content-type yang diteruskan; cookie tetap milik situs
      // (`credentials: 'include'`), bukan header buatan ekstensi.
      const headers: Record<string, string> = {
        accept: 'application/json, text/plain, */*',
      };
      if (data.contentType) headers['content-type'] = data.contentType;

      void (async () => {
        try {
          const response = await fetch(url, {
            method,
            credentials: 'include',
            headers,
            body: method === 'GET' || method === 'HEAD' ? undefined : body ?? undefined,
          });
          const text = await response.text();
          post({
            source: BRIDGE_SOURCE,
            dir: 'main->page',
            type: 'replay',
            id,
            ok: response.ok,
            status: response.status,
            url: response.url || url,
            body: text.slice(0, REPLAY_MAX_BYTES),
            truncated: text.length > REPLAY_MAX_BYTES,
          });
        } catch (error) {
          post({
            source: BRIDGE_SOURCE,
            dir: 'main->page',
            type: 'replay',
            id,
            ok: false,
            status: 0,
            url,
            body: '',
            truncated: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      })();
    }
  });

  // Beri tahu content script status awal, kalau ini reload setelah arm.
  post({ source: BRIDGE_SOURCE, dir: 'main->page', type: 'armed', armed });
}

export default defineContentScript({
  matches: ['*://*/*'],
  runAt: 'document_start',
  world: 'MAIN',
  main() {
    try {
      startBridge();
    } catch {
      // Halaman membekukan objek global atau memblokir storage. Perekaman API
      // mati untuk tab ini; picker, DOM, dan ekspor tetap berfungsi.
    }
  },
});
