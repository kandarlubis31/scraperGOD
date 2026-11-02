/**
 * Sumber data berlapis: JSON yang disediakan situs lebih kaya daripada DOM
 * (field terpotong, angka diformat, deskripsi di-truncate), jadi selalu dicoba
 * lebih dulu.
 */

import { findItemArrays } from '../source/json';

export interface EmbeddedArray {
  label: string;
  path: string;
  items: unknown[];
}

const MAX_SCRIPT_LENGTH = 4_000_000;

function parseJson(text: string | null | undefined): unknown {
  if (!text) return undefined;
  if (text.length > MAX_SCRIPT_LENGTH) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** `itemListElement` sering membungkus item asli di properti `item`. */
export function unwrapListItems(items: unknown[]): unknown[] {
  const unwrapped = items.map((entry) => {
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      const inner = (entry as Record<string, unknown>).item;
      if (inner && typeof inner === 'object') return inner;
    }
    return entry;
  });
  return unwrapped;
}

function flattenGraph(value: unknown): unknown[] {
  if (Array.isArray(value)) return value.flatMap(flattenGraph);
  if (value && typeof value === 'object') {
    const graph = (value as Record<string, unknown>)['@graph'];
    if (Array.isArray(graph)) return [value, ...graph.flatMap(flattenGraph)];
  }
  return [value];
}

function labelFor(script: HTMLScriptElement, index: number): string {
  const id = script.id ? `#${script.id}` : '';
  const type = script.getAttribute('type') ?? 'json';
  return `${type}${id || ` [${index + 1}]`}`;
}

/**
 * Mengumpulkan semua array-of-object dari script JSON di halaman:
 * JSON-LD, `__NEXT_DATA__`, `__NUXT_DATA__`, dan `<script type="application/json">`.
 */
export function collectEmbeddedArrays(doc: Document): EmbeddedArray[] {
  const out: EmbeddedArray[] = [];
  const scripts = Array.from(
    doc.querySelectorAll<HTMLScriptElement>(
      'script[type="application/ld+json"], script[type="application/json"], script#__NEXT_DATA__, script#__NUXT_DATA__',
    ),
  );

  scripts.forEach((script, index) => {
    const parsed = parseJson(script.textContent);
    if (parsed === undefined) return;
    const label = labelFor(script, index);

    const roots = flattenGraph(parsed);
    for (const root of roots) {
      for (const found of findItemArrays(root)) {
        const items =
          found.path.endsWith('itemListElement') || found.path === ''
            ? unwrapListItems(found.items)
            : found.items;
        if (items.length === 0) continue;
        out.push({
          label: found.path ? `${label} · ${found.path}` : label,
          path: found.path,
          items,
        });
      }
    }
  });

  return out.sort((a, b) => b.items.length - a.items.length);
}
