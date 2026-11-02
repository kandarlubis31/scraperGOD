import { describe, expect, it } from 'vitest';
import { autoMapAll, toPageItems } from '@/src/core/source/json';
import { findNextUrl, guessNextUrl } from '@/src/core/probe/next';
import { localItemKey } from '@/src/core/run/engine';
import { fieldsOf } from '@/src/picker/extract';

const BASE = 'https://contoh.test/film?page=3';

function doc(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html');
}

describe('metadata universal dari JSON', () => {
  it('menyimpan field non-lawanan kerja (tahun, rating, genre) dan membuang token', () => {
    const sample = {
      title: 'Blade Runner 2049',
      url: '/film/1',
      year: 2017,
      rating: 8.0,
      genres: ['Sci-Fi', 'Drama'],
      director: { name: 'Denis Villeneuve' },
      sessionToken: 'rahasia',
      csrfToken: 'rahasia',
    };

    const { mapping, extraFields } = autoMapAll(sample);

    expect(mapping.title).toBe('title');
    expect(mapping.url).toBe('url');
    expect(extraFields).toMatchObject({
      year: 'year',
      rating: 'rating',
      genres: 'genres',
      director_name: 'director.name',
    });
    expect(Object.values(extraFields)).not.toContain('sessionToken');
    expect(Object.values(extraFields)).not.toContain('csrfToken');

    const [item] = toPageItems([sample], mapping, BASE, extraFields);
    expect(item!.title).toBe('Blade Runner 2049');
    expect(item!.fields.year).toBe('2017');
    expect(item!.fields.rating).toBe('8');
    expect(item!.fields.genres).toBe('Sci-Fi, Drama');
    expect(item!.fields.director_name).toBe('Denis Villeneuve');
    expect(item!.fields.sessionToken).toBeUndefined();
  });

  it('kolom tambahan tidak menimpa field kanonik', () => {
    const { mapping, extraFields } = autoMapAll({ title: 'A', company: 'PT A', salary: 'Rp 1 jt' });
    const [item] = toPageItems([{ title: 'A', company: 'PT A', salary: 'Rp 1 jt' }], mapping, BASE, {
      ...extraFields,
      company: 'title',
    });
    expect(item!.fields.company).toBe('PT A');
  });
});

describe('judul item', () => {
  it('mengutamakan link di dalam heading, bukan link terpanjang', () => {
    const page = doc(`
      <article class="card">
        <h3><a href="/film/1">Dune</a></h3>
        <a href="/sutradara">Lihat semua film dari Denis Villeneuve</a>
        <a href="/simpan">Simpan</a>
      </article>
    `);

    const { title, url } = fieldsOf(page.querySelector('.card')!, BASE);
    expect(title).toBe('Dune');
    expect(url).toContain('/film/1');
  });
});

describe('item tanpa URL', () => {
  it('tetap punya identitas yang stabil, jadi tidak dibuang saat disimpan', () => {
    const first = localItemKey({ url: '', title: 'Dune', fields: { year: '2021' }, raw: '' });
    const again = localItemKey({ url: '', title: 'Dune ', fields: { year: '2021' }, raw: '' });
    const other = localItemKey({ url: '', title: 'Dune', fields: { year: '1984' }, raw: '' });

    expect(first).toBe(again);
    expect(first).not.toBe(other);
    expect(first.startsWith('no-url:')).toBe(true);
    expect(localItemKey({ url: '', title: '', fields: {}, raw: '' })).toBe('');
  });
});

describe('pagination', () => {
  it('memakai pagination bernomor kalau tidak ada teks "next"', () => {
    const page = doc(`
      <nav class="pagination">
        <a href="/film?page=2">2</a>
        <a href="/film?page=3" class="active" aria-current="page">3</a>
        <a href="/film?page=4">4</a>
      </nav>
    `);
    expect(findNextUrl(page, BASE)).toBe('https://contoh.test/film?page=4');
  });

  it('membaca tombol berikon dari class pagination-next', () => {
    const page = doc('<a class="pagination-next" href="/film?page=2"><svg></svg></a>');
    expect(findNextUrl(page, BASE)).toBe('https://contoh.test/film?page=2');
  });

  it('tidak tertipu class yang mengandung "next" di tengah kata', () => {
    const page = doc('<a class="nextjs-link" href="/lain">Detail</a>');
    expect(findNextUrl(page, BASE)).toBeNull();
  });

  it('menaikkan parameter halaman di URL kalau tidak ada link', () => {
    expect(guessNextUrl('https://contoh.test/film?page=3&genre=action')).toBe(
      'https://contoh.test/film?page=4&genre=action',
    );
    expect(guessNextUrl('https://contoh.test/film/page/2')).toBe(
      'https://contoh.test/film/page/3',
    );
    // offset/cursor tidak ditebak: ukuran halaman tidak diketahui.
    expect(guessNextUrl('https://contoh.test/api?offset=40')).toBeNull();
    expect(guessNextUrl('https://contoh.test/film')).toBeNull();
  });
});
