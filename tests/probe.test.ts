import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { probeDocument } from '@/src/core/probe';
import { findNextUrl } from '@/src/core/probe/next';
import { canScrollFurther, findMoreButton, isClickable } from '@/src/core/probe/more';
import { autoMapFields, findItemArrays } from '@/src/core/source/json';

const BASE = 'https://contoh.test/jobs?page=1';

function fixture(name: string): Document {
  const html = readFileSync(resolve(process.cwd(), 'tests/fixtures', name), 'utf8');
  return new DOMParser().parseFromString(html, 'text/html');
}

/**
 * jsdom tidak menghitung layout, jadi semua `getBoundingClientRect` bernilai
 * 0×0. Fungsi ini memberi ukuran supaya elemen lolos pengaman visibilitas —
 * sama seperti elemen yang benar-benar dirender browser.
 */
function visible(doc: Document): Document {
  doc.querySelectorAll('button, [role="button"], a[href], input').forEach((el) => {
    el.getBoundingClientRect = () =>
      ({
        width: 120,
        height: 32,
        top: 100,
        left: 100,
        right: 220,
        bottom: 132,
        x: 100,
        y: 100,
        toJSON: () => ({}),
      }) as DOMRect;
  });
  return doc;
}

describe('source probe', () => {
  it('membaca JSON-LD dan mengangkat item dari itemListElement', () => {
    const result = probeDocument(fixture('jsonld.html'), BASE);

    expect(result.best?.source).toBe('embedded');
    expect(result.best?.itemCount).toBe(2);
    expect(result.best?.label).toContain('ld+json');

    const first = result.best!.items[0]!;
    expect(first.title).toBe('Senior Data Engineer');
    expect(first.url).toBe('https://contoh.test/lowongan/data-engineer-1');
    expect(first.fields['company']).toBe('Tokopedia');
    expect(first.fields['location']).toBe('Jakarta Selatan');
    expect(first.fields['date']).toBe('2026-10-28');
    expect(first.raw).toContain('JobPosting');
  });

  it('membaca __NEXT_DATA__ dan memilih array jobs.items, bukan filters', () => {
    const result = probeDocument(fixture('next-data.html'), BASE);

    expect(result.best?.source).toBe('embedded');
    expect(result.best?.label).toContain('__NEXT_DATA__');
    expect(result.best?.label).toContain('jobs.items');
    expect(result.best?.itemCount).toBe(3);

    const first = result.best!.items[0]!;
    expect(first.title).toBe('Frontend Engineer');
    expect(first.url).toBe('https://contoh.test/jobs/frontend-engineer-a1');
    expect(first.fields['company']).toBe('Glints');
    expect(first.fields['location']).toBe('Bandung');
    expect(first.fields['salary']).toBe('Rp 10–15 jt/bln');
    expect(first.fields['description']).toBe('React + TypeScript.');
  });

  it('membaca <script type="application/json"> dan field bersarang', () => {
    const result = probeDocument(fixture('embedded-json.html'), BASE);

    expect(result.best?.source).toBe('embedded');
    expect(result.best?.itemCount).toBe(2);

    const first = result.best!.items[0]!;
    expect(first.title).toBe('Magang Backend');
    expect(first.url).toBe('https://contoh.test/magang/backend/octx');
    expect(first.fields['company']).toBe('Bukalapak');
    expect(first.fields['location']).toBe('Jakarta');
  });

  it('jatuh ke DOM kalau tidak ada JSON, dan tetap dapat semua kartu', () => {
    const result = probeDocument(fixture('grid-cards.html'), BASE);

    expect(result.best?.source).toBe('dom');
    expect(result.best?.itemCount).toBe(12);
    expect(result.best?.items[0]?.title.length).toBeGreaterThan(3);
    expect(result.notes.join(' ')).toContain('DOM');
  });

  it('mengembalikan null kalau halaman tidak punya daftar', () => {
    const doc = new DOMParser().parseFromString('<body><p>Halo</p></body>', 'text/html');
    const result = probeDocument(doc, BASE);

    expect(result.best).toBeNull();
    expect(result.notes.length).toBeGreaterThan(0);
  });

  it('hanya menganggap array of object sebagai daftar item', () => {
    const arrays = findItemArrays({
      jobs: [{ title: 'a' }, { title: 'b' }],
      tags: ['react', 'vue', 'svelte'],
      meta: { total: 2 },
    });

    expect(arrays).toHaveLength(1);
    expect(arrays[0]!.path).toBe('jobs');
  });

  it('auto-map mengabaikan key yang tidak relevan', () => {
    const mapping = autoMapFields({
      jobTitle: 'Data Engineer',
      slug: '/jobs/1',
      companyName: 'Tokopedia',
      tags: ['a', 'b'],
    });

    expect(mapping.title).toBe('jobTitle');
    expect(mapping.url).toBe('slug');
    expect(mapping.company).toBe('companyName');
    expect(mapping.salary).toBeNull();
  });
});

describe('next page', () => {
  it('menemukan link halaman berikutnya dan melewati yang disabled', () => {
    const doc = fixture('pagination-next.html');
    expect(findNextUrl(doc, BASE)).toBe('https://contoh.test/jobs?page=3');
  });

  it('mengembalikan null kalau tidak ada next', () => {
    const doc = fixture('grid-cards.html');
    expect(findNextUrl(doc, BASE)).toBeNull();
  });
});

describe('muat lebih banyak / infinite scroll', () => {
  it('menemukan tombol "Muat lebih banyak" yang aktif', () => {
    const button = findMoreButton(visible(fixture('load-more.html')), { baseUrl: BASE });
    expect(button?.textContent?.trim()).toBe('Muat lebih banyak');
    expect(button?.hasAttribute('disabled')).toBe(false);
  });

  it('mengabaikan tombol disabled, tombol yang sedang memuat, dan "Lihat selengkapnya"', () => {
    const doc = new DOMParser().parseFromString(
      `<body>
         <button disabled>Muat lebih banyak</button>
         <button class="is-loading">Load more</button>
         <a href="/x">Lihat selengkapnya</a>
         <span role="button" aria-disabled="true">Load more</span>
       </body>`,
      'text/html',
    );

    expect(findMoreButton(visible(doc))).toBeNull();
  });

  it('mengembalikan null di halaman tanpa pemicu', () => {
    expect(findMoreButton(visible(fixture('grid-cards.html')))).toBeNull();
    expect(findMoreButton(visible(fixture('pagination-next.html')))).toBeNull();
  });

  it('menghitung sisa ruang scroll', () => {
    expect(canScrollFurther({ scrollHeight: 2_000, scrollTop: 0, clientHeight: 800 })).toBe(true);
    expect(canScrollFurther({ scrollHeight: 800, scrollTop: 0, clientHeight: 800 })).toBe(false);
    expect(canScrollFurther({ scrollHeight: 0, scrollTop: 0, clientHeight: 0 })).toBe(false);
  });

  it('menolak tombol tanpa ukuran, dan menerimanya setelah punya ukuran', () => {
    // Di halaman nyata, rect 0×0 inilah yang terlihat untuk elemen di dalam
    // wadah `display:none` atau `visibility:hidden`.
    const doc = fixture('load-more.html');

    expect(findMoreButton(doc)).toBeNull();
    expect(findMoreButton(visible(doc))).not.toBeNull();
  });

  it('isClickable menolak display:none, visibility:hidden, opacity 0, pointer-events none, dan aria-hidden', () => {
    const cases = [
      '<button style="display: none">Muat lebih banyak</button>',
      '<button style="visibility: hidden">Muat lebih banyak</button>',
      '<button style="opacity: 0">Muat lebih banyak</button>',
      '<button style="pointer-events: none">Muat lebih banyak</button>',
      '<button aria-hidden="true">Muat lebih banyak</button>',
      '<button hidden>Muat lebih banyak</button>',
    ];

    for (const html of cases) {
      // Dokumen hasil `DOMParser` tidak punya `defaultView`, jadi
      // `getComputedStyle` tidak bisa dipakai. Pakai dokumen hidup seperti di
      // halaman sungguhan.
      document.body.innerHTML = html;
      const doc = visible(document);
      expect(isClickable(doc.querySelector('button')!), html).toBe(false);
      expect(findMoreButton(doc), html).toBeNull();
    }

    document.body.innerHTML = '';
  });

  it('mengabaikan pemicu di dalam form dan tombol yang menunjuk form lain', () => {
    const insideForm = visible(
      new DOMParser().parseFromString(
        '<body><form><button type="button">Muat lebih banyak</button></form></body>',
        'text/html',
      ),
    );
    const otherForm = visible(
      new DOMParser().parseFromString(
        '<body><form id="login"></form><button type="submit" form="login">Load more</button></body>',
        'text/html',
      ),
    );

    expect(findMoreButton(insideForm)).toBeNull();
    expect(findMoreButton(otherForm)).toBeNull();
  });

  it('teks berbahaya menang atas frasa "lebih banyak"', () => {
    const doc = visible(
      new DOMParser().parseFromString(
        `<body>
           <button type="button">Muat lebih banyak lamaran</button>
           <button type="button" aria-label="tampilkan lebih banyak">Daftar sekarang</button>
           <button type="button">Lamar sekarang</button>
           <button type="button">Hapus semua</button>
         </body>`,
        'text/html',
      ),
    );

    expect(findMoreButton(doc)).toBeNull();
  });

  it('mengabaikan link yang berpindah halaman, tapi boleh hash sehalaman', () => {
    const away = visible(
      new DOMParser().parseFromString(
        '<body><a href="/jobs?page=2">Load more</a></body>',
        'text/html',
      ),
    );
    const samePage = visible(
      new DOMParser().parseFromString(
        '<body><a href="#more">Load more</a></body>',
        'text/html',
      ),
    );

    expect(findMoreButton(away, { baseUrl: BASE })).toBeNull();
    expect(findMoreButton(samePage, { baseUrl: BASE })).not.toBeNull();
  });
});
