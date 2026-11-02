import { fieldsOf } from '@/src/picker/extract';
import type { PageItem, SourceKind } from '@/src/shared/types';
import { autoMapAll, toPageItems, type FieldMapping } from '../source/json';
import type { NetworkSource } from '../source/network';
import { collectEmbeddedArrays } from './embedded';
import { findDomList } from './dom';

/**
 * Probe: memilih sumber data terbaik yang tersedia di satu halaman.
 *
 * Urutan sesuai DRD: JSON jaringan → JSON tersemat → DOM. Hasil probe membawa
 * alasan, supaya UI bisa menjelaskan kenapa sumber itu dipilih, bukan
 * diam-diam memilih yang paling mudah.
 */

export interface ProbeCandidate {
  source: SourceKind;
  label: string;
  itemCount: number;
  score: number;
  mapping: FieldMapping | null;
  items: PageItem[];
  /** Elemen induk item (khusus jalur DOM); dipakai untuk memantau pertumbuhan. */
  container?: Element | null;
}

export interface ProbeResult {
  best: ProbeCandidate | null;
  candidates: ProbeCandidate[];
  notes: string[];
}

const RAW_LIMIT = 2_000;

function mappedFieldCount(mapping: FieldMapping): number {
  return Object.values(mapping).filter(Boolean).length;
}

/**
 * Jalur DOM memakai `fieldsOf`, bukan `rowOf`: `rowOf` hanya memberi dua blok
 * posisional, sehingga gaji/tanggal/lokasi (dan metadata lain) hilang dari run
 * walaupun picker sudah bisa mengisinya.
 */
function domItems(items: Element[], baseUrl: string): PageItem[] {
  return items.map((item) => {
    const { title, url, fields } = fieldsOf(item, baseUrl);
    return {
      url,
      title,
      fields,
      raw: (item.outerHTML ?? '').slice(0, RAW_LIMIT),
    };
  });
}

export function probeDocument(
  doc: Document,
  baseUrl: string,
  network: NetworkSource[] = [],
): ProbeResult {
  const candidates: ProbeCandidate[] = [];
  const notes: string[] = [];

  // JSON jaringan ditaruh paling atas: ini satu-satunya sumber yang field-nya
  // masih utuh (DOM sering cuma menampilkan potongan) dan yang bisa dipakai
  // ulang untuk pagination tanpa navigasi.
  for (const source of network) {
    candidates.push({
      source: 'network',
      label: `JSON jaringan · ${source.api.arrayPath || '$'} (${source.itemCount} item)`,
      itemCount: source.itemCount,
      score: source.score,
      mapping: source.api.mapping,
      items: source.items,
    });
  }

  for (const found of collectEmbeddedArrays(doc)) {
    const sample = found.items.find(
      (item) => item !== null && typeof item === 'object' && !Array.isArray(item),
    );
    if (!sample) continue;

    const { mapping, extraFields } = autoMapAll(sample as Record<string, unknown>);
    const items = toPageItems(found.items, mapping, baseUrl, extraFields);
    if (items.length === 0) continue;

    candidates.push({
      source: 'embedded',
      label: found.label,
      itemCount: items.length,
      score: 100 + Math.min(items.length, 40) + mappedFieldCount(mapping) * 2,
      mapping,
      items,
    });
  }

  const list = findDomList(doc);
  if (list) {
    const items = domItems(list.items, baseUrl);
    if (items.length > 0) {
      candidates.push({
        source: 'dom',
        label: `DOM · ${list.container.tagName.toLowerCase()} (${list.items.length} item)`,
        itemCount: items.length,
        score: 40 + Math.min(items.length, 20),
        mapping: null,
        items,
        container: list.container,
      });
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0] ?? null;

  if (!best) {
    notes.push('Tidak ada JSON tersemat dan tidak ada daftar berulang yang terdeteksi.');
  } else if (best.source === 'network') {
    notes.push(
      'JSON dari request situs dipakai — pagination bisa diambil lewat API tanpa membuka tiap halaman.',
    );
  } else if (best.source === 'embedded') {
    notes.push(`JSON tersemat dipakai (${best.label}) — field lebih lengkap daripada DOM.`);
  } else {
    notes.push('Hanya DOM yang tersedia; teks panjang bisa terpotong "Lihat selengkapnya".');
  }

  const embedded = candidates.filter((candidate) => candidate.source === 'embedded');
  if (embedded.length > 1) {
    notes.push(`${embedded.length} array JSON ditemukan; yang terbesar dipakai.`);
  }

  return { best, candidates, notes };
}
