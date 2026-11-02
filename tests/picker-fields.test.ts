import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { inferDomFields } from '../src/picker/fields';
import { fieldsOf } from '../src/picker/extract';
import { mergeWithNetwork } from '../src/picker/merge';
import type { PageItem } from '../src/shared/types';

function loadFixture(name: string): void {
  const html = readFileSync(resolve(process.cwd(), 'tests/fixtures', name), 'utf8');
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  document.body.replaceChildren();
  for (const node of Array.from(parsed.body.children)) {
    document.body.appendChild(document.adoptNode(node));
  }
}

function item(url: string, fields: Record<string, string> = {}): PageItem {
  return { url, title: url, fields, raw: '' };
}

describe('inferDomFields', () => {
  it('memetakan gaji, lokasi, tanggal, dan perusahaan', () => {
    const fields = inferDomFields(
      ['Tokopedia', 'Jakarta Selatan', 'Rp 25 - 35 jt / bulan', '3 hari lalu'],
      { company: 'Tokopedia' },
    );

    expect(fields).toEqual({
      company: 'Tokopedia',
      location: 'Jakarta Selatan',
      salary: 'Rp 25 - 35 jt / bulan',
      date: '3 hari lalu',
    });
  });

  it('semua blok yang tidak dikenali tetap jadi kolom info_N, tidak hilang', () => {
    const fields = inferDomFields(['Full-time', 'Pengalaman 3-5 tahun', 'Segera dibutuhkan'], {
      company: 'PT Sinar Jaya',
    });

    expect(fields.company).toBe('PT Sinar Jaya');
    expect(fields.info_1).toBe('Full-time');
    expect(fields.info_2).toBe('Pengalaman 3-5 tahun');
    // Daftar film/buku punya lebih dari dua potong metadata; sisanya ikut.
    expect(fields.info_3).toBe('Segera dibutuhkan');
  });

  it('mengutamakan nama berbadan hukum sebagai perusahaan', () => {
    const fields = inferDomFields(['Full-time', 'PT Maju Bersama', 'Bandung']);
    expect(fields.company).toBe('PT Maju Bersama');
    expect(fields.location).toBe('Bandung');
  });
});

describe('fieldsOf (DOM nyata)', () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it('mengisi kolom kanonik dari kartu tanpa info posisional', () => {
    loadFixture('grid-cards.html');
    const card = document.querySelector('.job-card')!;
    const { title, url, fields } = fieldsOf(card, 'https://contoh.test/lowongan');

    expect(title).toBe('Senior Data Engineer');
    expect(url).toContain('/lowongan/data-engineer-1');
    expect(fields).toMatchObject({
      company: 'Tokopedia',
      location: 'Jakarta Selatan',
      salary: 'Rp 25 - 35 jt / bulan',
    });
    expect(fields.info_1).toBeUndefined();
  });
});

describe('mergeWithNetwork', () => {
  const BASE = 'https://contoh.test/lowongan';

  it('memakai field jaringan untuk item yang cocok dan menjaga urutan pilihan', () => {
    const picked = [
      item('https://contoh.test/l/1', { info_1: 'Tokopedia' }),
      item('https://contoh.test/l/2', { info_1: 'Traveloka' }),
      item('https://contoh.test/l/3', { info_1: 'Bukalapak' }),
    ];
    const network = [
      item('https://contoh.test/l/2', { company: 'Traveloka', salary: 'Rp 18 jt' }),
      item('https://contoh.test/l/1', { company: 'Tokopedia', salary: 'Rp 25 jt' }),
      item('https://contoh.test/l/3', { company: 'Bukalapak', salary: 'Rp 12 jt' }),
    ];

    const merged = mergeWithNetwork(picked, BASE, [
      { items: network, selector: 'data.jobs' },
    ]);

    expect(merged).not.toBeNull();
    expect(merged!.coverage).toBe(1);
    expect(merged!.selector).toBe('data.jobs');
    expect(merged!.items.map((entry) => entry.url)).toEqual(picked.map((entry) => entry.url));
    expect(merged!.items[0]!.fields).toEqual({ company: 'Tokopedia', salary: 'Rp 25 jt' });
    // `info_1` hasil tebakan DOM dibuang karena jaringan sudah memberi field.
    expect(merged!.items[0]!.fields.info_1).toBeUndefined();
  });

  it('menolak sumber yang hanya menutupi sebagian kecil pilihan', () => {
    const picked = [1, 2, 3, 4, 5].map((n) => item(`https://contoh.test/l/${n}`));
    const merged = mergeWithNetwork(picked, BASE, [
      { items: [item('https://contoh.test/l/1')], selector: '$' },
    ]);

    expect(merged).toBeNull();
  });

  it('tanpa sumber jaringan, picker tetap memakai hasil DOM', () => {
    expect(mergeWithNetwork([item('https://contoh.test/l/1')], BASE, [])).toBeNull();
  });
});
