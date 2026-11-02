import { describe, expect, it } from 'vitest';
import { installFetchHook, installXhrHook, type HookTarget } from '@/src/net/hook';

/**
 * Halaman boleh membekukan `window`, `fetch`, atau prototype XHR. Modul ES
 * berjalan di strict mode, jadi assignment ke properti read-only melempar
 * TypeError — dan dulu itu mematikan seluruh content script MAIN world
 * ("crashed on startup"). Hook ini opsional, jadi tidak boleh melempar.
 */

const options = { armed: () => true, onCapture: () => undefined };

describe('pemasangan hook jaringan tahan halaman yang membekukan objek', () => {
  it('fetch read-only tidak melempar', () => {
    const target = {} as Record<string, unknown>;
    Object.defineProperty(target, 'fetch', {
      value: () => Promise.resolve({}),
      writable: false,
      configurable: false,
    });

    expect(() => installFetchHook(target as unknown as HookTarget, options)).not.toThrow();
  });

  it('prototype XMLHttpRequest yang dibekukan tidak melempar', () => {
    function FakeXhr() {
      /* hanya kerangka untuk prototype */
    }
    FakeXhr.prototype.open = () => undefined;
    FakeXhr.prototype.send = () => undefined;
    FakeXhr.prototype.setRequestHeader = () => undefined;
    Object.freeze(FakeXhr.prototype);

    const target = { XMLHttpRequest: FakeXhr } as unknown as HookTarget;
    expect(() => installXhrHook(target, options)).not.toThrow();
  });

  it('fetch biasa tetap terpasang dan menandai dirinya sekali saja', () => {
    const calls: string[] = [];
    const target: Record<string, unknown> = {
      fetch: (url: string) => {
        calls.push(url);
        return Promise.resolve({});
      },
    };

    installFetchHook(target as unknown as HookTarget, options);
    const first = target.fetch;
    installFetchHook(target as unknown as HookTarget, options);

    expect(target.fetch).toBe(first);
  });
});
