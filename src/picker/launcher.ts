/**
 * Tombol melayang di halaman: pintu masuk picker tanpa shortcut keyboard.
 *
 * Dipasang di Shadow DOM supaya CSS situs tidak bisa mengubah bentuknya, dan
 * host-nya diberi `data-scrapergod-ui` supaya picker tidak pernah memilih
 * tombol ini sebagai item daftar.
 *
 * Host sengaja kecil (seukuran tombol): elemen `position:fixed` selebar layar
 * akan menutupi halaman dan mematikan klik.
 */

const HOST_STYLE =
  'position:fixed;right:18px;bottom:18px;z-index:2147483647;pointer-events:none;';

const SHADOW_STYLE = `
  :host { all: initial; }
  .wrap { position: relative; pointer-events: none; }
  button {
    pointer-events: auto;
    display: grid;
    place-items: center;
    width: 40px;
    height: 40px;
    padding: 0;
    border: 1px solid rgba(255, 255, 255, 0.18);
    border-radius: 999px;
    background: #10131a;
    color: #4f8ef7;
    box-shadow: 0 6px 18px rgba(0, 0, 0, 0.35);
    cursor: pointer;
    opacity: 0.72;
    transition: opacity 0.15s ease, transform 0.15s ease;
  }
  button:hover, button:focus-visible {
    opacity: 1;
    transform: translateY(-2px);
    outline: none;
  }
  button:active { transform: translateY(0); }
  /* Tombol kecil untuk mematikan ikon ini di semua situs. */
  .hide {
    position: absolute;
    top: -5px;
    right: -5px;
    width: 18px;
    height: 18px;
    border-radius: 999px;
    background: #1f2937;
    color: #cbd5e1;
    border-color: rgba(255, 255, 255, 0.22);
    font: 12px/1 ui-sans-serif, system-ui, sans-serif;
    /* Selalu terlihat: kalau hanya muncul saat hover, user tidak tahu ikon
       ini bisa dimatikan. Pembungkusnya tidak kena hit-test, jadi :hover pada
       pembungkus tidak bisa diandalkan. */
    opacity: 0.75;
    transform: none;
  }
  .hide:hover, .hide:focus-visible { opacity: 1; background: #334155; transform: none; }
  svg { width: 20px; height: 20px; display: block; }
  @media (prefers-reduced-motion: reduce) { button { transition: none; } }
`;

const ICON = `
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
       stroke-linecap="round" aria-hidden="true">
    <circle cx="10.5" cy="10.5" r="6.5" />
    <path d="M15.5 15.5 21 21" />
    <path d="M10.5 7.5v6M7.5 10.5h6" />
  </svg>
`;

export interface LauncherOptions {
  onOpen: () => void;
  /**
   * User menekan tombol kecil (×) di pojok ikon: matikan ikon di semua situs.
   * Tanpa ini, satu-satunya cara mematikan adalah membuka side panel.
   */
  onHide?: () => void;
  /** Untuk tes: dokumen lain selain `document`. */
  doc?: Document;
}

export class PickerLauncher {
  private host: HTMLDivElement | null = null;
  private button: HTMLButtonElement | null = null;

  constructor(private readonly options: LauncherOptions) {}

  get isMounted(): boolean {
    return this.host !== null;
  }

  setEnabled(enabled: boolean): void {
    if (enabled) this.mount();
    else this.unmount();
  }

  private mount(): void {
    if (this.host) return;
    const doc = this.options.doc ?? document;
    if (!doc.documentElement) return;

    const host = doc.createElement('div');
    host.setAttribute('data-scrapergod-ui', '');
    host.style.cssText = HOST_STYLE;

    const root = host.attachShadow({ mode: 'closed' });
    const style = doc.createElement('style');
    style.textContent = SHADOW_STYLE;
    const wrap = doc.createElement('div');
    wrap.className = 'wrap';

    const button = doc.createElement('button');
    button.type = 'button';
    button.title = 'Ambil daftar di halaman ini';
    button.setAttribute('aria-label', 'Ambil daftar di halaman ini');
    button.innerHTML = ICON;

    // Tombol ini hidup di dalam halaman user: jangan sampai klik-nya memicu
    // navigasi/form milik situs, dan jangan biarkan situs menghentikannya lebih
    // dulu dengan listener capture.
    button.addEventListener(
      'click',
      (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.options.onOpen();
      },
      true,
    );

    const hide = doc.createElement('button');
    hide.type = 'button';
    hide.className = 'hide';
    hide.textContent = '\u00d7';
    hide.title = 'Sembunyikan ikon ini (bisa dinyalakan lagi dari side panel)';
    hide.setAttribute(
      'aria-label',
      'Sembunyikan ikon picker; bisa dinyalakan lagi dari side panel',
    );
    hide.addEventListener(
      'click',
      (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.unmount();
        this.options.onHide?.();
      },
      true,
    );

    wrap.append(button, hide);
    root.append(style, wrap);
    doc.documentElement.appendChild(host);
    this.host = host;
    this.button = button;
  }

  private unmount(): void {
    this.host?.remove();
    this.host = null;
    this.button = null;
  }

  /** Dipakai tes untuk memastikan tidak ada sisa elemen setelah dimatikan. */
  get element(): HTMLButtonElement | null {
    return this.button;
  }
}
