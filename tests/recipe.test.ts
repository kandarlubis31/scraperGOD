import { beforeEach, describe, expect, it } from 'vitest';
import { PickerLauncher } from '../src/picker/launcher';
import { applyRecipe, buildRecipe, cssSelector } from '../src/picker/recipe';

const SITE = 'https://contoh.test/daftar';

function renderList(count = 3): void {
  document.body.innerHTML = `
    <main>
      <div class="grid">
        ${Array.from({ length: count })
          .map(
            (_, index) => `
          <article class="card">
            <h3><a href="/item/${index + 1}">Item ${index + 1}</a></h3>
            <span class="meta">2024</span>
          </article>`,
          )
          .join('')}
      </div>
    </main>
  `;
}

describe('recipe per situs', () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it('menyimpan daftar yang dipilih dan memakainya lagi di halaman berikutnya', () => {
    renderList(3);
    const card = document.querySelector('.card')!;
    const recipe = buildRecipe(SITE, card.parentElement!, card);

    const match = applyRecipe(recipe, document, SITE);
    expect(match).not.toBeNull();
    expect(match!.reason).toBeNull();
    expect(match!.items).toHaveLength(3);
    expect(match!.container?.className).toBe('grid');
  });

  it('tidak dipakai di situs lain', () => {
    renderList(3);
    const card = document.querySelector('.card')!;
    const recipe = buildRecipe(SITE, card.parentElement!, card);

    expect(applyRecipe(recipe, document, 'https://lain.test/daftar')).toBeNull();
  });

  it('menolak dengan alasan kalau bentuk item berubah, bukan diam-diam kosong', () => {
    renderList(3);
    const card = document.querySelector('.card')!;
    const recipe = buildRecipe(SITE, card.parentElement!, card);

    // Empat elemen baru: bentuk item jauh berbeda dari saat disimpan.
    card.append(
      document.createElement('span'),
      document.createElement('span'),
      document.createElement('span'),
      document.createElement('span'),
    );

    const match = applyRecipe(recipe, document, SITE);
    expect(match!.reason).toContain('Bentuk item berubah');
  });

  it('menolak kalau selector tidak menemukan apa pun', () => {
    renderList(3);
    const card = document.querySelector('.card')!;
    const recipe = buildRecipe(SITE, card.parentElement!, card);

    document.body.innerHTML = '<main><div class="lain">kosong</div></main>';

    const match = applyRecipe(recipe, document, SITE);
    expect(match!.items).toHaveLength(0);
    expect(match!.reason).toContain('Struktur halaman berubah');
  });

  it('selector tidak memakai class yang terlihat seperti hash build', () => {
    document.body.innerHTML = '<div class="css-1x2y3z"><p class="teks">halo</p></div>';
    const selector = cssSelector(document.querySelector('.teks')!);
    expect(selector).not.toContain('css-1x2y3z');
    expect(document.querySelectorAll(selector)).toHaveLength(1);
  });
});

describe('tombol melayang', () => {
  beforeEach(() => {
    document.body.replaceChildren();
    document.querySelectorAll('[data-scrapergod-ui]').forEach((el) => el.remove());
  });

  it('memasang satu tombol, membuka picker saat diklik, dan hilang saat dimatikan', () => {
    let opened = 0;
    const launcher = new PickerLauncher({ onOpen: () => (opened += 1), doc: document });

    launcher.setEnabled(true);
    expect(document.querySelectorAll('[data-scrapergod-ui]')).toHaveLength(1);

    launcher.element!.click();
    expect(opened).toBe(1);

    launcher.setEnabled(false);
    expect(document.querySelectorAll('[data-scrapergod-ui]')).toHaveLength(0);
  });

  it('setEnabled(true) dua kali tidak memasang tombol ganda', () => {
    const launcher = new PickerLauncher({ onOpen: () => undefined, doc: document });
    launcher.setEnabled(true);
    launcher.setEnabled(true);
    expect(document.querySelectorAll('[data-scrapergod-ui]')).toHaveLength(1);
    launcher.setEnabled(false);
  });
});
