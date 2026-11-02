import { NETWORK_LIMITS, type NetworkCapture } from '../core/source/network';
import {
  BRIDGE_SOURCE,
  isBridgeMessage,
  type BridgeMessage,
  type ReplayResult,
} from './bridge';
import type { CaptureRecord } from './hook';

/**
 * Sisi content script (ISOLATED world) dari jembatan jaringan.
 *
 * Tugasnya tiga:
 * 1. Menarik capture JSON dari MAIN world saat probe butuh.
 * 2. Menyalakan/mematikan hook di MAIN world.
 * 3. Menjalankan replay `fetch` di konteks halaman, supaya cookie dan CORS
 *    tetap seperti milik situs, bukan seperti milik ekstensi.
 */

const REPLAY_TIMEOUT_MS = 15_000;
/** MAIN world menjawab seketika; batas ini cuma untuk halaman yang memblokir. */
const LIST_TIMEOUT_MS = 1_000;

function toNetworkCapture(record: CaptureRecord): NetworkCapture {
  return {
    url: record.url,
    method: record.method,
    status: record.status,
    contentType: record.contentType,
    // Body request ikut menyeberang supaya POST/GraphQL bisa direplay identik.
    // Header lain sengaja tidak: cookie/Authorization tidak pernah direkam.
    requestBody: record.requestBody ?? null,
    requestContentType: record.requestContentType ?? null,
    truncated: record.truncated || record.size > NETWORK_LIMITS.maxRenderBytes,
    capturedAt: record.at,
    body: record.sample,
  };
}

export class PageBridge {
  private readonly pendingReplay = new Map<string, (result: ReplayResult) => void>();
  private readonly pendingList = new Map<string, (captures: CaptureRecord[]) => void>();
  private listener: ((event: MessageEvent) => void) | null = null;
  private sequence = 0;

  start(): void {
    if (this.listener) return;

    this.listener = (event: MessageEvent) => {
      if (event.source !== window) return;
      const data: unknown = event.data;
      if (!isBridgeMessage(data) || data.dir !== 'main->page') return;
      const message = data as Extract<BridgeMessage, { dir: 'main->page' }>;

      if (message.type === 'captures') {
        const resolve = this.pendingList.values().next().value;
        if (!resolve) return;
        this.pendingList.clear();
        resolve(message.captures);
        return;
      }

      if (message.type === 'replay') {
        const resolve = this.pendingReplay.get(message.id);
        if (!resolve) return;
        this.pendingReplay.delete(message.id);
        resolve({
          ok: message.ok,
          status: message.status,
          url: message.url,
          body: message.body,
          truncated: message.truncated,
          error: message.error,
        });
      }
    };

    window.addEventListener('message', this.listener);
  }

  stop(): void {
    if (this.listener) window.removeEventListener('message', this.listener);
    this.listener = null;
    this.pendingReplay.clear();
    this.pendingList.clear();
  }

  private post(message: BridgeMessage): void {
    try {
      window.postMessage(message, '*');
    } catch {
      /* halaman dengan CSP ketat: fitur ini mati, sisanya tetap jalan */
    }
  }

  arm(): void {
    this.start();
    this.post({ source: BRIDGE_SOURCE, dir: 'page->main', type: 'arm' });
  }

  disarm(): void {
    this.post({ source: BRIDGE_SOURCE, dir: 'page->main', type: 'disarm' });
  }

  /**
   * Capture yang dipegang MAIN world, terbaru dulu. Kalau MAIN world tidak
   * menjawab (CSP/halaman aneh), hasilnya kosong — probe tetap jalan dengan DOM.
   */
  list(): Promise<NetworkCapture[]> {
    this.start();
    const id = `l${++this.sequence}`;

    return new Promise<NetworkCapture[]>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingList.delete(id);
        resolve([]);
      }, LIST_TIMEOUT_MS);

      this.pendingList.set(id, (captures) => {
        clearTimeout(timer);
        resolve(captures.map(toNetworkCapture).reverse());
      });

      this.post({ source: BRIDGE_SOURCE, dir: 'page->main', type: 'list', id });
    });
  }

  replay(
    url: string,
    opts: { method?: string; body?: string | null; contentType?: string | null } = {},
  ): Promise<ReplayResult> {
    this.start();
    const id = `r${++this.sequence}`;

    return new Promise<ReplayResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingReplay.delete(id);
        resolve({
          ok: false,
          status: 0,
          url,
          body: '',
          truncated: false,
          error: 'Replay API tidak menjawab dalam 15 detik.',
        });
      }, REPLAY_TIMEOUT_MS);

      this.pendingReplay.set(id, (result) => {
        clearTimeout(timer);
        resolve(result);
      });

      this.post({
        source: BRIDGE_SOURCE,
        dir: 'page->main',
        type: 'replay',
        id,
        url,
        method: opts.method,
        body: opts.body ?? null,
        contentType: opts.contentType ?? null,
      });
    });
  }
}
