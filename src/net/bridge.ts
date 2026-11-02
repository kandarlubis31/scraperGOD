/**
 * Jembatan MAIN world ↔ content script (ISOLATED world).
 *
 * Kenapa `postMessage` dan bukan `CustomEvent`: detail CustomEvent tidak
 * menyeberang antar world di Chrome (objeknya jadi `null` karena pemisahan
 * konteks). `postMessage` melakukan structured clone, jadi aman dan konsisten.
 *
 * Buffer capture hanya ada di MAIN world dan **ditarik** oleh content script
 * (`list`). Model tarik dipilih supaya tidak ada race: content script bisa saja
 * belum siap saat situs melakukan fetch pertamanya.
 */

import type { CaptureRecord } from './hook';

export const BRIDGE_SOURCE = 'scrapergod';

/** Disimpan di sessionStorage: bertahan saat reload, hilang saat tab ditutup. */
export const ARM_STORAGE_KEY = 'scrapergod:armed';

export type BridgeMessage =
  | { source: typeof BRIDGE_SOURCE; dir: 'main->page'; type: 'captures'; captures: CaptureRecord[] }
  | { source: typeof BRIDGE_SOURCE; dir: 'main->page'; type: 'armed'; armed: boolean }
  | {
      source: typeof BRIDGE_SOURCE;
      dir: 'main->page';
      type: 'replay';
      id: string;
      ok: boolean;
      status: number;
      url: string;
      body: string;
      truncated: boolean;
      error?: string;
    }
  | { source: typeof BRIDGE_SOURCE; dir: 'page->main'; type: 'arm' }
  | { source: typeof BRIDGE_SOURCE; dir: 'page->main'; type: 'disarm' }
  | { source: typeof BRIDGE_SOURCE; dir: 'page->main'; type: 'list'; id: string }
  | {
      source: typeof BRIDGE_SOURCE;
      dir: 'page->main';
      type: 'replay';
      id: string;
      url: string;
      /** POST/GraphQL: body identik milik situs, hanya field halaman yang naik. */
      method?: string;
      body?: string | null;
      contentType?: string | null;
    };

export function isBridgeMessage(value: unknown): value is BridgeMessage {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    record.source === BRIDGE_SOURCE &&
    (record.dir === 'main->page' || record.dir === 'page->main') &&
    typeof record.type === 'string'
  );
}

export interface ReplayResult {
  ok: boolean;
  status: number;
  url: string;
  body: string;
  truncated: boolean;
  error?: string;
}
