import { clampTarget, MAX_TARGET, type PickDecision } from './target';

/**
 * UI picker: overlay highlight + HUD melayang + toast, semuanya di shadow DOM
 * supaya CSS halaman tidak bocor masuk (dan sebaliknya).
 */

const CSS = `
  :host { all: initial; }
  * { box-sizing: border-box; }
  .layer {
    position: fixed; inset: 0; pointer-events: none; z-index: 2147483646;
  }
  .box {
    position: fixed; top: 0; left: 0; pointer-events: none; border-radius: 10px;
    will-change: transform;
    border: 2px solid rgba(56, 189, 248, 0.85);
    background: rgba(56, 189, 248, 0.08);
    transition: border-color 60ms linear, background 60ms linear;
  }
  .box.active {
    border-color: rgb(34, 211, 238);
    background: rgba(56, 189, 248, 0.16);
    box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.18);
  }
  .hud {
    position: fixed; pointer-events: auto; z-index: 2147483647;
    width: 322px; padding: 12px;
    background: #0b1220; color: #e2e8f0;
    border: 1px solid rgba(148, 163, 184, 0.25);
    border-radius: 12px;
    box-shadow: 0 18px 40px rgba(2, 6, 23, 0.45), 0 1px 0 rgba(255,255,255,0.04) inset;
    font: 13px/1.45 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    letter-spacing: 0;
  }
  .hud[hidden] { display: none; }
  .top { display: flex; align-items: center; gap: 6px; margin-bottom: 8px; }
  .count { font-size: 15px; font-weight: 650; color: #f8fafc; }
  .chip {
    font-size: 10px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase;
    padding: 2px 6px; border-radius: 999px;
    background: rgba(56, 189, 248, 0.12); color: #7dd3fc;
    border: 1px solid rgba(56, 189, 248, 0.28);
  }
  .chip.lvl { margin-left: auto; background: transparent; color: #94a3b8; border-color: rgba(148,163,184,0.25); }
  .rows { display: grid; gap: 4px; margin-bottom: 10px; }
  .row { display: flex; gap: 8px; align-items: baseline; min-width: 0; }
  .row .t { font-weight: 550; color: #e2e8f0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 58%; }
  .row .s { color: #94a3b8; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .empty { color: #94a3b8; margin: 2px 0 10px; }
  .actions { display: flex; gap: 6px; }
  button {
    flex: 1; font: inherit; font-weight: 600; padding: 7px 10px;
    border-radius: 8px; border: 1px solid transparent; cursor: pointer;
    transition: background 80ms linear, border-color 80ms linear;
  }
  button:focus-visible { outline: 2px solid #38bdf8; outline-offset: 2px; }
  .take { background: #38bdf8; color: #04202f; }
  .take:hover { background: #7dd3fc; }
  .copy { background: rgba(148, 163, 184, 0.14); color: #e2e8f0; border-color: rgba(148, 163, 184, 0.25); }
  .copy:hover { background: rgba(148, 163, 184, 0.22); }
  .lvlbtn {
    flex: none; padding: 0 7px; line-height: 20px; font-size: 13px;
    background: rgba(148, 163, 184, 0.14); color: #cbd5e1;
    border-color: rgba(148, 163, 184, 0.25);
  }
  .lvlbtn:hover { background: rgba(148, 163, 184, 0.26); }
  .unlock {
    flex: none; padding: 7px 9px;
    background: rgba(245, 185, 77, 0.16); color: #fbbf24;
    border-color: rgba(245, 185, 77, 0.35);
  }
  .unlock:hover { background: rgba(245, 185, 77, 0.28); }
  .unlock[hidden] { display: none; }
  .hint { margin-top: 8px; color: #64748b; font-size: 11px; }
  .toast {
    position: fixed; right: 20px; bottom: 20px; z-index: 2147483647;
    background: #0b1220; color: #e2e8f0; pointer-events: none;
    border: 1px solid rgba(148, 163, 184, 0.25); border-radius: 10px;
    padding: 9px 13px; font: 13px/1.4 ui-sans-serif, system-ui, sans-serif;
    box-shadow: 0 12px 30px rgba(2, 6, 23, 0.4);
    opacity: 0; transform: translateY(4px); transition: opacity 120ms, transform 120ms;
  }
  .toast.show { opacity: 1; transform: translateY(0); }
  .confirm {
    position: fixed; left: 50%; top: 50%; transform: translate(-50%, -50%);
    width: 336px; padding: 14px; z-index: 2147483647; pointer-events: auto;
    background: #0b1220; color: #e2e8f0; border-radius: 12px;
    border: 1px solid rgba(148, 163, 184, 0.28);
    box-shadow: 0 24px 60px rgba(2, 6, 23, 0.55);
    font: 13px/1.45 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  .confirm .q { font-weight: 600; margin-bottom: 8px; color: #f8fafc; }
  .confirm .qty-row {
    display: flex; align-items: center; gap: 6px;
    font-size: 12px; color: #cbd5e1; margin-bottom: 10px;
  }
  .confirm .qty {
    width: 84px; padding: 5px 7px; border-radius: 7px;
    border: 1px solid rgba(148, 163, 184, 0.3); background: #0f172a;
    color: #e2e8f0; font: inherit;
  }
  .confirm .actions.col { display: grid; gap: 6px; }
  .confirm .hint { margin-top: 8px; color: #94a3b8; font-size: 11px; }
  @media (prefers-reduced-motion: reduce) {
    .box, button, .toast { transition: none; }
  }
`;

export interface HudState {
  count: number;
  level: string;
  rows: string[][];
  at: { x: number; y: number };
}

export interface PickerUiHandlers {
  onAction: (action: 'take' | 'copy' | 'unlock' | 'level-down' | 'level-up') => void;
}

export class PickerUI {
  private host: HTMLElement;
  private layer: HTMLElement;
  private hud: HTMLElement;
  private toastEl: HTMLElement;
  private countEl: HTMLElement;
  private levelEl: HTMLElement;
  private rowsEl: HTMLElement;
  private takeBtn: HTMLButtonElement;
  private copyBtn: HTMLButtonElement;
  private unlockBtn: HTMLButtonElement;
  private boxes: HTMLElement[] = [];
  private items: Element[] = [];
  private activeIndex = -1;
  private toastTimer = 0;
  private copyTimer = 0;
  private dialog: HTMLElement | null = null;
  private dialogResolve: ((value: PickDecision | null) => void) | null = null;
  /** Daftar terkunci: HUD berhenti mengikuti kursor supaya bisa diklik. */
  private pinned = false;

  constructor(private handlers: PickerUiHandlers) {
    this.host = document.createElement('div');
    this.host.setAttribute('data-scrapergod-ui', '');
    this.host.style.cssText =
      'position:fixed;inset:0;z-index:2147483647;pointer-events:none;';
    const shadow = this.host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = CSS;

    this.layer = document.createElement('div');
    this.layer.className = 'layer';

    this.hud = document.createElement('div');
    this.hud.className = 'hud';
    this.hud.hidden = true;
    this.hud.innerHTML = `
      <div class="top">
        <span class="count"></span>
        <span class="chip src">DOM</span>
        <span class="chip lvl"></span>
        <button class="lvlbtn down" type="button" aria-label="Level lebih dalam">‹</button>
        <button class="lvlbtn up" type="button" aria-label="Level lebih luar">›</button>
      </div>
      <div class="rows"></div>
      <div class="actions">
        <button class="take" type="button"></button>
        <button class="copy" type="button">Copy</button>
        <button class="unlock" type="button" hidden>Lepas</button>
      </div>
      <div class="hint">Klik kartu = kunci · dobel klik = ambil · Esc batal</div>
    `;

    this.toastEl = document.createElement('div');
    this.toastEl.className = 'toast';

    shadow.append(style, this.layer, this.hud, this.toastEl);
    document.documentElement.appendChild(this.host);

    this.countEl = this.hud.querySelector<HTMLElement>('.count')!;
    this.levelEl = this.hud.querySelector<HTMLElement>('.lvl')!;
    this.rowsEl = this.hud.querySelector<HTMLElement>('.rows')!;
    this.takeBtn = this.hud.querySelector<HTMLButtonElement>('.take')!;
    this.copyBtn = this.hud.querySelector<HTMLButtonElement>('.copy')!;
    this.unlockBtn = this.hud.querySelector<HTMLButtonElement>('.unlock')!;

    this.takeBtn.addEventListener('click', () => this.handlers.onAction('take'));
    this.copyBtn.addEventListener('click', () => this.handlers.onAction('copy'));
    this.unlockBtn.addEventListener('click', () => this.handlers.onAction('unlock'));
    // Level daftar bisa dipilih pakai mouse saja (dulu cuma `[` dan `]`).
    this.hud
      .querySelector<HTMLButtonElement>('.lvlbtn.down')!
      .addEventListener('click', () => this.handlers.onAction('level-down'));
    this.hud
      .querySelector<HTMLButtonElement>('.lvlbtn.up')!
      .addEventListener('click', () => this.handlers.onAction('level-up'));
  }

  highlight(items: Element[], active: Element | null): void {
    // Kotak hanya dibangun ulang kalau daftar item-nya benar-benar berubah.
    // Dulu semua kotak dihapus dan dibuat lagi pada SETIAP deteksi — untuk
    // daftar 100+ item itu yang membuat hover tersendat.
    const same =
      items.length === this.items.length &&
      items.every((item, index) => item === this.items[index]);
    this.items = items;
    if (!same) {
      this.layer.replaceChildren();
      this.activeIndex = -1;
      this.boxes = items.map(() => {
        const box = document.createElement('div');
        box.className = 'box';
        this.layer.appendChild(box);
        return box;
      });
    }
    this.setActive(active);
    this.reposition();
  }

  setActive(active: Element | null): void {
    const next =
      active === null
        ? -1
        : this.items.findIndex((item) => item === active || item.contains(active));
    if (next === this.activeIndex) return;

    const previous = this.boxes[this.activeIndex];
    if (previous) previous.classList.remove('active');
    const current = this.boxes[next];
    if (current) current.classList.add('active');
    this.activeIndex = next;
  }

  /**
   * Posisi kotak ditulis lewat `transform`, bukan `left`/`top`, supaya browser
   * cuma menggeser lapisan (tanpa layout ulang). Semua `getBoundingClientRect`
   * dibaca dulu, baru ditulis: menulis style di sela pembacaan memaksa reflow
   * berulang dan itu terasa sebagai hover yang patah-patah.
   */
  reposition(): void {
    const rects: (DOMRect | null)[] = this.items.map((item) => {
      const rect = item.getBoundingClientRect();
      const offscreen =
        rect.bottom < 0 ||
        rect.top > window.innerHeight ||
        rect.right < 0 ||
        rect.left > window.innerWidth ||
        rect.width === 0 ||
        rect.height === 0;
      return offscreen ? null : rect;
    });

    this.items.forEach((_item, index) => {
      const box = this.boxes[index];
      if (!box) return;
      const rect = rects[index];
      if (!rect) {
        if (box.style.display !== 'none') box.style.display = 'none';
        return;
      }
      if (box.style.display === 'none') box.style.display = 'block';
      box.style.width = `${rect.width}px`;
      box.style.height = `${rect.height}px`;
      box.style.transform = `translate3d(${rect.left}px, ${rect.top}px, 0)`;
    });
  }

  /** Daftar terkunci: munculkan tombol Lepas dan bekukan posisi HUD. */
  setLocked(locked: boolean): void {
    this.hud.classList.toggle('locked', locked);
    this.unlockBtn.hidden = !locked;
    this.pinned = locked;
  }

  showHud(state: HudState): void {
    this.countEl.textContent = `${state.count} item`;
    this.levelEl.textContent = state.level;
    this.takeBtn.textContent = `Ambil ${state.count}`;

    this.rowsEl.replaceChildren(
      ...state.rows.slice(0, 2).map((row) => {
        const el = document.createElement('div');
        el.className = 'row';
        const title = document.createElement('span');
        title.className = 't';
        title.textContent = row[0] || '(tanpa judul)';
        const rest = document.createElement('span');
        rest.className = 's';
        rest.textContent = row.slice(1).filter(Boolean).join(' · ');
        el.append(title, rest);
        return el;
      }),
    );

    this.hud.hidden = false;
    this.place(state.at.x, state.at.y);
  }

  showEmpty(at: { x: number; y: number }): void {
    this.layer.replaceChildren();
    this.boxes = [];
    this.items = [];
    this.activeIndex = -1;
    this.countEl.textContent = 'Tidak ada list';
    this.levelEl.textContent = '';
    this.rowsEl.replaceChildren();
    const note = document.createElement('div');
    note.className = 'empty';
    note.textContent = 'Tidak ada item berulang di sini. Coba arahkan ke kartu lain.';
    this.rowsEl.appendChild(note);
    this.takeBtn.textContent = 'Ambil';
    this.takeBtn.disabled = true;
    this.hud.hidden = false;
    this.place(at.x, at.y);
  }

  /**
   * HUD hanya mengikuti kursor saat kursor JAUH darinya.
   *
   * Dulu `place()` dipanggil di setiap `pointermove`, jadi HUD selalu berada
   * 18px di depan kursor: kursor tidak pernah bisa menyusulnya, dan tombol
   * Ambil/Copy/Lepas terasa "kabur" saat didekati.
   */
  follow(x: number, y: number): void {
    if (this.pinned) return;
    const rect = this.hud.getBoundingClientRect();
    const halo = 80;
    const near =
      x >= rect.left - halo &&
      x <= rect.right + halo &&
      y >= rect.top - halo &&
      y <= rect.bottom + halo;
    if (near) return;
    this.place(x, y);
  }

  place(x: number, y: number, force = false): void {
    if (this.pinned && !force) return;
    const pad = 14;
    const gap = 18;
    const rect = this.hud.getBoundingClientRect();
    let left = x + gap;
    let top = y + gap;

    if (left + rect.width > window.innerWidth - pad) left = x - rect.width - gap;
    if (top + rect.height > window.innerHeight - pad) top = y - rect.height - gap;

    left = Math.max(pad, Math.min(left, window.innerWidth - rect.width - pad));
    top = Math.max(pad, Math.min(top, window.innerHeight - rect.height - pad));

    this.hud.style.left = `${Math.round(left)}px`;
    this.hud.style.top = `${Math.round(top)}px`;
  }

  flashCopied(count: number): void {
    this.copyBtn.textContent = `✓ ${count} baris`;
    window.clearTimeout(this.copyTimer);
    this.copyTimer = window.setTimeout(() => {
      this.copyBtn.textContent = 'Copy';
    }, 1500);
  }

  toast(message: string): void {
    this.toastEl.textContent = message;
    this.toastEl.classList.add('show');
    window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => {
      this.toastEl.classList.remove('show');
    }, 1800);
  }

  /** Ada = dialog target sedang terbuka; Enter/Esc HUD harus diam. */
  get dialogOpen(): boolean {
    return this.dialog !== null;
  }

  /**
   * Dialog target: satu halaman saja, atau lanjut sampai M item. Semua elemen
   * di dalam shadow root yang sama (`data-scrapergod-ui`), jadi klik ke sini
   * tidak dianggap klik ke halaman.
   */
  askTarget(count: number): Promise<PickDecision | null> {
    this.finishDialog(null);
    const shadow = this.host.shadowRoot;
    if (!shadow) return Promise.resolve(null);

    const box = document.createElement('div');
    box.className = 'confirm';
    box.setAttribute('data-scrapergod-ui', '');
    box.innerHTML = `
      <div class="q"></div>
      <label class="qty-row">Ambil maksimal <input class="qty" type="number" min="1" max="5000"> item</label>
      <div class="actions col">
        <button class="take page" type="button"></button>
        <button class="take go" type="button"></button>
        <button class="copy cancel" type="button">Batal</button>
      </div>
      <div class="hint">Kalau lanjut halaman, ekstensi membuka atau menggulir halaman berikutnya sampai target tercapai atau daftar habis. Enter = lanjut, Esc = batal.</div>
    `;

    const qty = box.querySelector<HTMLInputElement>('.qty')!;
    const pageBtn = box.querySelector<HTMLButtonElement>('.page')!;
    const goBtn = box.querySelector<HTMLButtonElement>('.go')!;
    const question = box.querySelector<HTMLElement>('.q')!;

    question.textContent = `Daftar ini berisi ${count} item di halaman ini. Berapa yang diambil?`;
    qty.value = String(Math.min(count, MAX_TARGET));
    qty.max = String(MAX_TARGET);
    pageBtn.textContent = `Ambil ${count} item halaman ini saja`;

    const targetOf = () => clampTarget(Number(qty.value), count);
    const relabel = () => {
      goBtn.textContent = `Ambil ${targetOf()} item + lanjut halaman berikutnya`;
    };
    relabel();
    qty.addEventListener('input', relabel);
    // Enter = pilihan utama (lanjut sampai target). Esc ditangani content
    // script saat dialog terbuka.
    qty.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      this.finishDialog({ mode: 'continue', target: targetOf() });
    });

    pageBtn.addEventListener('click', () => this.finishDialog({ mode: 'page', target: count }));
    goBtn.addEventListener('click', () =>
      this.finishDialog({ mode: 'continue', target: targetOf() }),
    );
    box
      .querySelector<HTMLButtonElement>('.cancel')!
      .addEventListener('click', () => this.finishDialog(null));

    shadow.append(box);
    this.dialog = box;

    return new Promise<PickDecision | null>((resolve) => {
      this.dialogResolve = resolve;
      qty.focus();
      qty.select();
    });
  }

  /** Batal dari keyboard: sama dengan menekan tombol Batal. */
  cancelDialog(): void {
    this.finishDialog(null);
  }

  private finishDialog(value: PickDecision | null): void {
    const resolve = this.dialogResolve;
    this.dialogResolve = null;
    this.dialog?.remove();
    this.dialog = null;
    resolve?.(value);
  }

  destroy(): void {
    this.finishDialog(null);
    window.clearTimeout(this.toastTimer);
    window.clearTimeout(this.copyTimer);
    this.host.remove();
  }
}
