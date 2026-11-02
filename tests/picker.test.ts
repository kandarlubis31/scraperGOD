import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { inferCandidates } from '../src/picker/infer';
import {
  COLUMNS,
  absoluteUrl,
  rowOf,
  toTSV,
} from '../src/picker/extract';

function loadFixture(name: string): void {
  const html = readFileSync(
    resolve(process.cwd(), 'tests/fixtures', name),
    'utf8',
  );
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  document.body.replaceChildren();
  for (const node of Array.from(parsed.body.children)) {
    document.body.appendChild(document.adoptNode(node));
  }
}

function hover(selector: string): Element {
  const el = document.querySelector(selector);
  if (!el) throw new Error(`Selector tidak ada di fixture: ${selector}`);
  return el;
}

describe('inferensi set', () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it('grid kartu: menemukan 12 item dan container yang benar', () => {
    loadFixture('grid-cards.html');
    const { best } = inferCandidates(hover('.job-title'), { layout: false });

    expect(best).not.toBeNull();
    expect(best!.items).toHaveLength(12);
    expect(best!.container.className).toBe('job-grid');
    expect(best!.coverage).toBe(1);
    expect(best!.items.every((item) => item.classList.contains('job-card'))).toBe(
      true,
    );
  });

  it('hover di teks dalam kartu tetap menemukan set level kartu', () => {
    loadFixture('grid-cards.html');
    const { best } = inferCandidates(hover('.company'), { layout: false });

    expect(best!.items).toHaveLength(12);
    expect(best!.items[0]!.tagName).toBe('ARTICLE');
  });

  it('tabel: memilih 10 baris <tr>, bukan 5 sel <td>', () => {
    loadFixture('table.html');
    const { best, candidates } = inferCandidates(hover('td a'), {
      layout: false,
    });

    expect(best).not.toBeNull();
    expect(best!.items).toHaveLength(10);
    expect(best!.items[0]!.tagName).toBe('TR');
    expect(best!.container.tagName).toBe('TBODY');

    const rows = candidates.filter((c) => c.items[0]?.tagName === 'TR');
    expect(rows).toHaveLength(1);
  });

  it('daftar <ul>: menemukan 8 <li>', () => {
    loadFixture('list-ul.html');
    const { best } = inferCandidates(hover('.result .title'), {
      layout: false,
    });

    expect(best!.items).toHaveLength(8);
    expect(best!.items[0]!.tagName).toBe('LI');
  });

  it('iklan: kartu promo tidak ikut terpilih', () => {
    loadFixture('cards-with-ads.html');
    const { best } = inferCandidates(hover('.job-title'), { layout: false });

    expect(best!.items).toHaveLength(10);
    expect(best!.items.some((item) => item.classList.contains('promo-card'))).toBe(
      false,
    );
    expect(best!.coverage).toBeCloseTo(10 / 12, 5);
  });

  it('tinggi & bentuk berbeda: badge, tanpa lokasi, dan logo tetap satu set', () => {
    loadFixture('varying-height.html');
    const { best } = inferCandidates(hover('.title'), { layout: false });

    expect(best!.items).toHaveLength(9);
    const ids = best!.items.map((item) => item.getAttribute('data-qa'));
    expect(ids).toContain('4'); // punya badge ekstra
    expect(ids).toContain('5'); // tanpa lokasi
    expect(ids).toContain('6'); // punya <img>
    expect(ids).toContain('7'); // judul dengan <br>
  });

  it('halaman non-list: tidak ada kandidat', () => {
    document.body.innerHTML = `
      <article class="post">
        <h1>Cara menulis query SQL yang cepat</h1>
        <p>Paragraf pembuka yang cukup panjang untuk dibaca.</p>
        <p>Paragraf kedua berisi penjelasan tambahan.</p>
      </article>
    `;
    const { best } = inferCandidates(hover('.post p'), { layout: false });
    expect(best).toBeNull();
  });

  it('kandidat diurutkan dari set terluar ke terdalam', () => {
    loadFixture('table.html');
    const { candidates } = inferCandidates(hover('td a'), { layout: false });
    const depths = candidates.map((c) => c.depth);
    expect(depths).toEqual([...depths].sort((a, b) => a - b));
    expect(new Set(depths).size).toBeGreaterThan(1);
  });
});

describe('ekstraksi & TSV', () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it('mengambil judul, url absolut tanpa parameter pelacak, dan info', () => {
    loadFixture('grid-cards.html');
    const row = rowOf(hover('.job-card'));

    expect(row[0]).toBe('Senior Data Engineer');
    expect(row[1]).toContain('/lowongan/data-engineer-1');
    expect(row[1]).not.toContain('utm_');
    expect(row[1]).not.toContain('trk=');
    expect(row[1]).not.toContain('ref=');
    expect(row[1]!.startsWith('http')).toBe(true);
    expect(row[2]).toBe('Tokopedia');
    expect(row[3]).toBe('Jakarta Selatan');
  });

  it('membuang parameter pelacak dan menolak skema non-http', () => {
    expect(
      absoluteUrl('/a?utm_source=x&id=7&ref=home', 'https://contoh.test/'),
    ).toBe('https://contoh.test/a?id=7');
    expect(absoluteUrl('javascript:alert(1)', 'https://contoh.test/')).toBe('');
  });

  it('TSV punya header, jumlah baris benar, dan meng-escape sel', () => {
    const tsv = toTSV(
      [
        ['Judul A', 'https://contoh.test/1', 'PT A', 'Jakarta'],
        ['Judul\tB', 'https://contoh.test/2', 'PT "B"', 'Bandung'],
      ],
      COLUMNS,
    );

    const lines = tsv.split('\r\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe(COLUMNS.join('\t'));
    expect(lines[1]).toBe('Judul A\thttps://contoh.test/1\tPT A\tJakarta');
    expect(lines[2]).toContain('"Judul\tB"');
    expect(lines[2]).toContain('"PT ""B"""');
  });

  it('toTSV mempertahankan baris baru di dalam sel', () => {
    const tsv = toTSV([['baris1\nbaris2']], ['teks']);
    expect(tsv).toBe('teks\r\n"baris1\nbaris2"');
  });
});
