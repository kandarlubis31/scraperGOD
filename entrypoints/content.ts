import { browser } from 'wxt/browser';
import { inferCandidates, type Candidate } from '../src/picker/infer';
import { COLUMNS, fieldsOf, rowsOf, toTSV } from '../src/picker/extract';
import { mergeWithNetwork } from '../src/picker/merge';
import { PickerLauncher } from '../src/picker/launcher';
import { applyRecipe, buildRecipe, type Recipe } from '../src/picker/recipe';
import { loadRecipe, saveRecipe } from '../src/picker/recipe-store';
import { PickerUI } from '../src/picker/ui';
import { LAUNCHER_ENABLED_KEY, launcherEnabledFrom } from '../src/shared/settings';
import { siteKey } from '../src/shared/url';
import { probeDocument } from '../src/core/probe';
import {
  canScrollFurther,
  EXPAND_POLL_MS,
  EXPAND_WAIT_MS,
  findBlockedTriggers,
  findMoreButton,
  inspectTriggers,
} from '../src/core/probe/more';
import type { PaginationFacts } from '../src/core/probe/diagnose';
import { clampTarget, needsConfirmation } from '../src/picker/target';
import { findNextUrl, guessNextUrl } from '../src/core/probe/next';
import { findSecretSource, scanCaptures } from '../src/core/source/network';
import { PageBridge } from '../src/net/page-bridge';
import { MESSAGE, type TabProbeResponse, type TabReplayResponse } from '../src/messaging/protocol';
import { PAGE_SNAPSHOT_LIMITS, type PageItem } from '../src/shared/types';

/** Satu-satunya buffer capture: di MAIN world. Ini cuma pengambilnya. */
const bridge = new PageBridge();

/** Jarak antar-inferensi saat kursor menyapu cepat antar-daftar. */
const DETECT_MIN_INTERVAL_MS = 100;

let ui: PickerUI | null = null;
let launcher: PickerLauncher | null = null;
/** Recipe situs ini: daftar yang dipilih user, dipakai ulang oleh run. */
let recipe: Recipe | null = null;
let active = false;
let candidates: Candidate[] = [];
let levelIndex = 0;
let selected: Candidate | null = null;
let hovered: Element | null = null;
let pointer = { x: 0, y: 0 };
let moveRaf = 0;
let scrollRaf = 0;
let detectTimer = 0;
let lockedRefreshTimer = 0;
let lastDetectAt = 0;
let previousCursor = '';
let previousUserSelect = '';
/** Daftar yang dipilih user dengan klik; sorotan tidak berpindah saat terkunci. */
let locked = false;

function isOwnUi(el: Element | null): boolean {
  return el !== null && el.closest('[data-scrapergod-ui]') !== null;
}

function isOwnEvent(event: Event): boolean {
  return event
    .composedPath()
    .some(
      (node) => node instanceof Element && node.hasAttribute('data-scrapergod-ui'),
    );
}

function activeItem(): Element | null {
  if (!hovered || !selected) return null;
  return (
    selected.items.find(
      (item) => item === hovered || item.contains(hovered),
    ) ?? null
  );
}

function itemsFromElements(elements: Element[], baseUrl: string): PageItem[] {
  return elements.map((element) => {
    const { title, url, fields } = fieldsOf(element, baseUrl);
    return {
      url,
      title,
      fields,
      raw: (element.outerHTML ?? '').slice(0, 2_000),
    };
  });
}

/** Recipe dibaca sekali di awal dan saat disimpan; `pageSnapshot` tetap sinkron. */
async function refreshRecipe(): Promise<void> {
  try {
    recipe = await loadRecipe(location.href);
  } catch {
    recipe = null;
  }
}

async function refreshLauncher(): Promise<void> {
  if (!launcher) return;
  let enabled = true;
  try {
    enabled = launcherEnabledFrom(await browser.storage.local.get(LAUNCHER_ENABLED_KEY));
  } catch {
    // storage tidak bisa dibaca: biarkan tombol tampil, itu defaultnya.
  }
  launcher.setEnabled(enabled && !active);
}

/** User menekan × pada ikon melayang: matikan di semua situs. */
async function hideLauncherFromPage(): Promise<void> {
  launcher?.setEnabled(false);
  try {
    await browser.storage.local.set({ [LAUNCHER_ENABLED_KEY]: false });
  } catch {
    // Storage gagal: ikon tetap hilang untuk halaman ini; panel bisa
    // menyalakannya lagi kapan saja.
  }
}

function render(): void {
  if (!ui || !selected) return;
  ui.highlight(selected.items, activeItem());
  ui.showHud({
    count: selected.items.length,
    level: `${levelIndex + 1}/${candidates.length}`,
    rows: rowsOf(selected.items.slice(0, 2)),
    at: pointer,
  });
}

function detect(): void {
  if (!ui || !hovered) return;

  // Kursor masih di dalam daftar yang sudah terpilih: tidak ada yang berubah.
  // Ini jalur terpanas saat menyapu kursor di atas tabel — tanpa jalan pintas
  // ini seluruh daftar di-infer ulang puluhan kali per detik.
  if (
    selected &&
    selected.items.some((item) => item === hovered || item.contains(hovered))
  ) {
    ui.setActive(activeItem());
    return;
  }

  const result = inferCandidates(hovered);
  candidates = result.candidates;

  if (!result.best) {
    selected = null;
    ui.showEmpty(pointer);
    return;
  }

  levelIndex = Math.max(0, candidates.indexOf(result.best));
  selected = candidates[levelIndex] ?? null;
  render();
}

function scheduleDetect(): void {
  window.clearTimeout(detectTimer);
  // Dulu selalu ditunda 120 ms dan timer-nya di-reset di setiap gerakan: sorotan
  // baru muncul setelah kursor BERHENTI, jadi terasa tersendat. Sekarang jalan
  // segera saat mesin menganggur, dibatasi 100 ms saat menyapu cepat.
  const wait = Math.max(
    0,
    DETECT_MIN_INTERVAL_MS - (performance.now() - lastDetectAt),
  );
  detectTimer = window.setTimeout(() => {
    lastDetectAt = performance.now();
    detect();
  }, wait);
}

function cycleLevel(delta: number): void {
  if (candidates.length === 0) return;
  const next = Math.max(0, Math.min(candidates.length - 1, levelIndex + delta));
  if (next === levelIndex) return;
  levelIndex = next;
  selected = candidates[levelIndex] ?? null;
  render();
}

async function writeClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // jatuh ke fallback di bawah
  }

  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.cssText =
      'position:fixed;top:-9999px;left:-9999px;opacity:0;pointer-events:none';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

async function copySelection(): Promise<void> {
  if (!selected) return;
  const rows = rowsOf(selected.items);
  const ok = await writeClipboard(toTSV(rows, COLUMNS));
  ui?.toast(
    ok ? `${rows.length} baris · TSV` : 'Gagal menyalin ke clipboard',
  );
  if (ok) ui?.flashCopied(rows.length);
}

function itemOf(element: Element, baseUrl: string): PageItem {
  const { title, url, fields } = fieldsOf(element, baseUrl);
  return {
    url,
    title,
    fields,
    raw: (element.outerHTML ?? '').slice(0, 2_000),
  };
}

/**
 * "Ambil" di picker = run nyata di database, bukan cuma tempelan di
 * storage.local. Dengan begitu hasilnya bisa dipratinjau dan diekspor dari
 * side panel seperti run biasa.
 */
async function takeSelection(): Promise<void> {
  if (ui?.dialogOpen) return;
  // Tombol Ambil bisa ditekan sebelum ada daftar terpilih (kursor di ruang
  // kosong). Diam saja membuat user mengira tombolnya rusak.
  if (!selected) {
    ui?.toast('Pilih daftar dulu · klik satu kartu di halaman');
    return;
  }

  const baseUrl = location.href;
  const picked = selected.items.map((element) => itemOf(element, baseUrl));

  // Set besar tidak disimpan diam-diam: user memilih "halaman ini saja" atau
  // menetapkan target M, dan target itu yang mengatur pagination.
  const ask = needsConfirmation(picked.length);
  const decision = ask ? await (ui?.askTarget(picked.length) ?? Promise.resolve(null)) : null;
  if (ask && !decision) return;

  const target = decision ? clampTarget(decision.target, picked.length) : picked.length;
  const wantMore = decision?.mode === 'continue';

  // Kalau halaman ini menyediakan JSON dengan item yang sama, data itulah yang
  // disimpan: field-nya sudah dipetakan, bukan ditebak dari teks.
  let items = picked;
  let source: 'network' | 'dom' = 'dom';
  let selector: string | null = null;
  try {
    const captures = await bridge.list();
    const scan = scanCaptures(captures, baseUrl);
    const merged = mergeWithNetwork(
      picked,
      baseUrl,
      scan.sources.map((entry) => ({
        items: entry.items,
        selector: entry.api.arrayPath || '$',
      })),
    );
    if (merged) {
      items = merged.items;
      source = 'network';
      selector = merged.selector;
    }
  } catch {
    // Hook tidak bisa dijangkau (CSP/halaman aneh): simpan hasil DOM apa adanya.
  }

  // Halaman ini sudah ada di DOM; pagination hanya perlu kalau target lebih
  // besar dari jumlah item yang terlihat.
  const continueRun = wantMore && target > items.length;
  const take = items.slice(0, continueRun ? items.length : Math.min(target, items.length));

  // Recipe disimpan apa pun modenya, supaya halaman berikutnya di situs ini
  // memakai daftar item yang sama.
  const draft =
    selected?.container && selected.items[0]
      ? buildRecipe(siteKey(baseUrl), selected.container, selected.items[0])
      : null;

  let saved = 0;
  try {
    const message = continueRun
      ? {
          type: 'pick:run',
          page: {
            url: baseUrl,
            title: document.title,
            source,
            itemSelector: draft?.item ?? null,
            container: draft?.container ?? null,
            items: take,
            target,
          },
        }
      : {
          type: 'pick:save',
          page: {
            url: baseUrl,
            title: document.title,
            source,
            selector,
            items: take,
          },
        };

    const response = (await browser.runtime.sendMessage(message)) as
      | { ok: true; data: { recordCount: number } }
      | { ok: false; error: string }
      | undefined;

    if (!response?.ok) {
      ui?.toast(`Gagal menyimpan: ${response?.error ?? 'SW tidak merespons'}`);
      return;
    }
    saved = response.data.recordCount;
  } catch (error) {
    ui?.toast(
      `Gagal menyimpan: ${error instanceof Error ? error.message : String(error)}`,
    );
    return;
  }

  // Pilihan user disimpan sebagai recipe supaya "Mulai ambil" di panel memakai
  // daftar yang sama, bukan tebakan ulang level daftar di setiap halaman.
  if (draft) void saveRecipe(draft).then(refreshRecipe);

  const fromApi = source === 'network' ? ' · data API' : '';
  if (continueRun) {
    ui?.toast(`${saved} item tersimpan · lanjut sampai ${target} item`);
  } else {
    ui?.toast(
      saved < take.length
        ? `${saved} dari ${take.length} item tersimpan (URL ganda digabung)${fromApi}`
        : `${saved} item tersimpan${fromApi} · buka side panel untuk ekspor`,
    );
  }

  window.setTimeout(stop, 700);
}

function onPointerMove(event: PointerEvent): void {
  if (!active) return;
  pointer = { x: event.clientX, y: event.clientY };

  if (moveRaf) return;
  moveRaf = requestAnimationFrame(() => {
    moveRaf = 0;
    const el = document.elementFromPoint(pointer.x, pointer.y);
    if (!el || isOwnUi(el)) return;

    // Terkunci: sorotan DAN posisi HUD dibekukan. Kalau HUD ikut bergerak,
    // kursor tidak akan pernah bisa sampai ke tombol Ambil/Lepas.
    if (locked) return;

    hovered = el;
    ui?.setActive(activeItem());
    // `follow`, bukan `place`: HUD diam saat kursor mendekat.
    ui?.follow(pointer.x, pointer.y);
    scheduleDetect();
  });
}

function onScroll(): void {
  if (!active) return;
  if (scrollRaf) return;
  scrollRaf = requestAnimationFrame(() => {
    scrollRaf = 0;
    if (!active) return;
    // Setiap frame cuma menggeser kotak (transform), bukan inferensi ulang.
    ui?.reposition();
    // Terkunci: item baru dari infinite scroll digambar setelah gulir berhenti,
    // supaya menggulir tetap mulus.
    if (locked && selected) {
      window.clearTimeout(lockedRefreshTimer);
      lockedRefreshTimer = window.setTimeout(refreshLockedHighlight, 180);
    }
  });
}

/** Setelah gulir berhenti, sorotan disusun ulang sekali (item bisa bertambah). */
function refreshLockedHighlight(): void {
  if (!active || !locked || !ui || !hovered) return;
  const result = inferCandidates(hovered);
  if (!result.best) return;
  candidates = result.candidates;
  levelIndex = Math.max(0, candidates.indexOf(result.best));
  selected = candidates[levelIndex] ?? null;
  render();
}

function onResize(): void {
  if (active) ui?.reposition();
}

/**
 * Menutup event halaman sampai ke handler situs mana pun, termasuk yang
 * dipasang di `window`/`document` fase capture — `stopImmediatePropagation`
 * perlu karena listener situs di node yang sama tetap jalan tanpa itu.
 */
function shield(event: Event): void {
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();
}

function onKeyDown(event: KeyboardEvent): void {
  if (!active) return;

  // Dialog target memegang fokus: Enter tidak boleh memicu "Ambil" bawaan HUD
  // saat user sedang mengisi angka.
  if (ui?.dialogOpen) {
    if (event.key === 'Escape') {
      shield(event);
      ui.cancelDialog();
      return;
    }
    // Ketikan di dalam dialog dibiarkan; di luar dialog situs tidak boleh
    // melihat apa pun.
    if (!isOwnEvent(event)) shield(event);
    return;
  }

  if (event.key === 'Escape') {
    if (!isOwnEvent(event)) shield(event);
    stop();
    return;
  }

  // Event dari HUD/picker sendiri dibiarkan: tombol HUD butuh Enter/klik
  // bawaannya sendiri.
  if (isOwnEvent(event)) return;

  if (event.key === 'Enter') {
    shield(event);
    if (event.shiftKey) void copySelection();
    else void takeSelection();
    return;
  }
  if (event.key === '[') {
    shield(event);
    cycleLevel(-1);
    return;
  }
  if (event.key === ']') {
    shield(event);
    cycleLevel(1);
    return;
  }

  // Sisa tombol (spasi, panah, shortcut situs) tidak boleh sampai ke halaman
  // selama memilih. Esc selalu keluar, jadi tidak ada jalan buntu.
  shield(event);
}

/** `keyup`/`keypress` juga dipakai situs untuk shortcut; tutup keduanya. */
function blockKeyboardTail(event: Event): void {
  if (!active || ui?.dialogOpen || isOwnEvent(event)) return;
  shield(event);
}

/**
 * Event pointer tidak boleh dilihat situs, tapi `click` harus tetap terbentuk.
 * Karena itu hanya propagasinya yang dihentikan — tanpa `preventDefault`.
 * `pointermove` sengaja tidak ikut: picker memakainya melacak kursor.
 */
const HIDDEN_POINTER_EVENTS = [
  'pointerdown',
  'pointerup',
  'pointerover',
  'pointerenter',
  'mouseover',
  'mouseenter',
] as const;

function hidePointer(event: Event): void {
  if (!active || isOwnEvent(event)) return;
  event.stopPropagation();
}

/**
 * Membekukan interaksi halaman selama picker aktif.
 *
 * Tidak mungkin membekukan JavaScript situs (dan tidak perlu): yang dicegah
 * adalah SEMUA input masuk — klik, drag, submit form, sentuhan, dan tombol
 * keyboard — di fase capture sehingga handler situs tidak pernah menerimanya.
 * Render, animasi, dan scroll tetap jalan supaya daftar masih bisa dibaca.
 */
function blockEvent(event: Event): void {
  if (!active || isOwnEvent(event)) return;
  event.preventDefault();
  event.stopPropagation();
}

/**
 * Klik di halaman = pilih & kunci daftar ini, bukan membuka link. Ini jalur
 * tanpa keyboard: setelah terkunci, user tinggal klik tombol di HUD.
 */
function onPageClick(event: MouseEvent): void {
  if (!active || isOwnEvent(event)) return;
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();

  const element = document.elementFromPoint(event.clientX, event.clientY);
  if (!element || isOwnUi(element)) return;

  hovered = element;
  const result = inferCandidates(element);
  candidates = result.candidates;

  if (!result.best) {
    locked = false;
    ui?.setLocked(false);
    selected = null;
    ui?.showEmpty(pointer);
    return;
  }

  levelIndex = Math.max(0, candidates.indexOf(result.best));
  selected = candidates[levelIndex] ?? null;
  // HUD diletakkan sekali di dekat klik, lalu dibekukan.
  ui?.place(event.clientX, event.clientY, true);
  locked = true;
  ui?.setLocked(true);
  render();
  ui?.toast(`Daftar dikunci (${selected?.items.length ?? 0} item) · klik Ambil`);
}

/** Dobel klik = Ambil, supaya seluruh alur bisa tanpa keyboard. */
function onPageDoubleClick(event: MouseEvent): void {
  if (!active || isOwnEvent(event)) return;
  event.preventDefault();
  event.stopPropagation();
  void takeSelection();
}

function unlockSelection(): void {
  locked = false;
  ui?.setLocked(false);

  const el = document.elementFromPoint(pointer.x, pointer.y);
  if (el && !isOwnUi(el)) {
    hovered = el;
    scheduleDetect();
  }
  ui?.toast('Kunci dilepas · arahkan kursor bebas');
}

function start(): void {
  if (active) return;

  active = true;
  locked = false;
  candidates = [];
  levelIndex = 0;
  selected = null;
  hovered = null;

  ui = new PickerUI({
    onAction: (action) => {
      if (action === 'copy') void copySelection();
      else if (action === 'unlock') unlockSelection();
      else if (action === 'level-up') cycleLevel(1);
      else if (action === 'level-down') cycleLevel(-1);
      else void takeSelection();
    },
  });

  // Tombol melayang tidak boleh menghalangi sorotan picker.
  launcher?.setEnabled(false);
  // Halaman "dibekukan": fokus dipindah keluar input dan teks tidak bisa
  // diseleksi. Semua listener di bawah dipasang di `window` fase capture,
  // supaya handler situs tidak pernah menerima event-nya lebih dulu.
  (document.activeElement as HTMLElement | null)?.blur?.();
  previousCursor = document.documentElement.style.cursor;
  previousUserSelect = document.documentElement.style.userSelect;
  document.documentElement.style.cursor = 'crosshair';
  document.documentElement.style.userSelect = 'none';

  window.addEventListener('pointermove', onPointerMove, true);
  window.addEventListener('click', onPageClick, true);
  window.addEventListener('dblclick', onPageDoubleClick, true);
  window.addEventListener('mousedown', blockEvent, true);
  window.addEventListener('mouseup', blockEvent, true);
  // `pointerdown`/`touchstart` sengaja TIDAK diblokir: preventDefault di sana
  // membuat browser berhenti mengirim `click`, sehingga klik-untuk-mengunci
  // ikut hilang. `mousedown` sudah cukup menahan fokus, seleksi, dan drag.
  window.addEventListener('auxclick', blockEvent, true);
  window.addEventListener('submit', blockEvent, true);
  window.addEventListener('dragstart', blockEvent, true);
  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('keyup', blockKeyboardTail, true);
  window.addEventListener('keypress', blockKeyboardTail, true);
  for (const type of HIDDEN_POINTER_EVENTS) {
    window.addEventListener(type, hidePointer, true);
  }
  window.addEventListener('scroll', onScroll, true);
  window.addEventListener('resize', onResize);

  ui.toast('Klik kartu untuk memilih · dobel klik untuk ambil');
}

function stop(): void {
  if (!active) return;

  active = false;
  window.clearTimeout(detectTimer);
  window.clearTimeout(lockedRefreshTimer);
  if (moveRaf) cancelAnimationFrame(moveRaf);
  if (scrollRaf) cancelAnimationFrame(scrollRaf);
  moveRaf = 0;
  scrollRaf = 0;

  window.removeEventListener('pointermove', onPointerMove, true);
  window.removeEventListener('click', onPageClick, true);
  window.removeEventListener('dblclick', onPageDoubleClick, true);
  window.removeEventListener('mousedown', blockEvent, true);
  window.removeEventListener('mouseup', blockEvent, true);
  window.removeEventListener('auxclick', blockEvent, true);
  window.removeEventListener('submit', blockEvent, true);
  window.removeEventListener('dragstart', blockEvent, true);
  window.removeEventListener('keydown', onKeyDown, true);
  window.removeEventListener('keyup', blockKeyboardTail, true);
  window.removeEventListener('keypress', blockKeyboardTail, true);
  for (const type of HIDDEN_POINTER_EVENTS) {
    window.removeEventListener(type, hidePointer, true);
  }
  window.removeEventListener('scroll', onScroll, true);
  window.removeEventListener('resize', onResize);

  document.documentElement.style.cursor = previousCursor;
  document.documentElement.style.userSelect = previousUserSelect;
  locked = false;
  ui?.destroy();
  ui = null;
  candidates = [];
  selected = null;
  // Tombol melayang kembali setelah picker selesai, kecuali dimatikan di panel.
  void refreshLauncher();
}

function toggle(): void {
  if (active) stop();
  else start();
}

/**
 * Fakta untuk laporan Diagnosa pagination. Hanya di sini layout dan keadaan
 * DOM bisa dibaca; penyusunan kalimatnya ada di `src/core/probe/diagnose.ts`.
 */
async function paginationFacts(): Promise<PaginationFacts> {
  const url = location.href;
  const notes: string[] = [];
  let sources: ReturnType<typeof scanCaptures>['sources'] = [];

  try {
    const captures = await bridge.list();
    const scan = scanCaptures(captures, url);
    sources = scan.sources;
    notes.push(...scan.notes.slice(0, 3));
    if (captures.length === 0) {
      notes.push(
        'Belum ada request JSON yang terekam. Nyalakan "Rekam API situs" di panel lalu muat ulang halaman sekali.',
      );
    }
  } catch {
    notes.push('Tidak bisa membaca request JSON halaman ini.');
  }

  const probe = probeDocument(document, url, sources);
  const bestNetwork = probe.best
    ? sources.find((source) => source.items === probe.best?.items)
    : undefined;
  if (!bestNetwork) {
    notes.push(
      'Rencana API butuh parameter halaman (page/offset) atau cursor yang terbukti, plus verifikasi halaman 2 yang isinya berbeda.',
    );
  }

  const found = findNextUrl(document, url);
  const guessed = found ? null : guessNextUrl(url);

  return {
    url,
    itemCount: probe.best?.itemCount ?? 0,
    api: bestNetwork?.api ?? null,
    apiNotes: notes,
    more: inspectTriggers(document, { baseUrl: url }),
    nextUrl: found ?? guessed,
    nextUrlVia: found ? 'dari halaman' : guessed ? 'tebakan dari parameter URL' : null,
    scroll: scrollFacts(),
  };
}

/** Scroll window dan container `overflow:auto` yang isinya lebih tinggi. */
function scrollFacts(): { window: boolean; containers: string[] } {
  const scroller = viewportScroller();
  const windowScroll = scroller
    ? canScrollFurther({
        scrollHeight: scroller.scrollHeight,
        scrollTop: scroller.scrollTop,
        clientHeight: scroller.clientHeight,
      })
    : false;

  const containers: string[] = [];
  for (const el of Array.from(document.querySelectorAll<HTMLElement>('body *')).slice(0, 3000)) {
    if (containers.length >= 3) break;
    const slack = el.scrollHeight - el.clientHeight;
    if (slack < 40) continue;
    const style = getComputedStyle(el);
    if (!/(auto|scroll)/.test(style.overflowY)) continue;
    const id = el.id ? `#${el.id}` : '';
    const cls =
      typeof el.className === 'string' && el.className.trim()
        ? `.${el.className.trim().split(/\s+/)[0]}`
        : '';
    containers.push(`${el.tagName.toLowerCase()}${id}${cls} (sisa ${slack}px)`);
  }

  return { window: windowScroll, containers };
}

type ExpandStatus = 'grown' | 'unchanged' | 'timeout';

function viewportScroller(): Element | null {
  return document.scrollingElement ?? document.documentElement;
}

/** Halaman masih bisa bertambah walau tidak ada link "berikutnya"? */
function canExpandPage(): boolean {
  if (findMoreButton(document, { baseUrl: location.href })) return true;
  const scroller = viewportScroller();
  if (!scroller) return false;
  return canScrollFurther({
    scrollHeight: scroller.scrollHeight,
    scrollTop: scroller.scrollTop,
    clientHeight: scroller.clientHeight,
  });
}

/**
 * Sidik jari murah untuk mendeteksi pertumbuhan daftar.
 *
 * Dulu setiap 250 ms seluruh dokumen diprobe ulang (`probeDocument` =
 * `findDomList` + semua JSON tersemat). Di halaman besar itu membuat tab
 * tersendat selama 6 detik penuh. Sekarang cukup satu probe di awal, lalu
 * polling hanya membaca jumlah anak container yang sama.
 */
interface ListMark {
  container: Element | null;
  signature: string;
  count: number;
}

function markOf(container: Element | null): ListMark {
  if (!container) {
    // Sumber JSON: tidak ada container daftar. Perubahan tinggi halaman sudah
    // cukup untuk menandai "ada yang bertambah setelah scroll".
    return {
      container: null,
      signature: `${document.body?.childElementCount ?? 0}|${document.documentElement.scrollHeight}`,
      count: 0,
    };
  }
  const count = container.children.length;
  const last = container.lastElementChild?.textContent ?? '';
  return { container, count, signature: `${count}|${last.slice(-160)}` };
}

function listMark(): ListMark {
  const matched = recipe ? applyRecipe(recipe, document, siteKey(location.href)) : null;
  if (matched && matched.reason === null && matched.container) {
    return markOf(matched.container);
  }
  const probe = probeDocument(document, location.href);
  return markOf(probe.best?.container ?? null);
}

/**
 * Klik yang menyerupai input manusia. Banyak situs mendengar `pointerdown`
 * atau memeriksa `event.isTrusted`, jadi `.click()` saja sering tidak memicu
 * apa pun. Urutannya tetap tidak bisa membuat `isTrusted` jadi true — itu
 * batas nyata dari sisi ekstensi.
 */
function clickLikeHuman(node: HTMLElement): void {
  node.scrollIntoView({ block: 'center' });
  const base = { bubbles: true, cancelable: true, composed: true, view: window, button: 0 };
  try {
    node.dispatchEvent(
      new PointerEvent('pointerdown', { ...base, pointerId: 1, pointerType: 'mouse', isPrimary: true, buttons: 1 }),
    );
    node.dispatchEvent(new MouseEvent('mousedown', { ...base, buttons: 1 }));
    node.dispatchEvent(
      new PointerEvent('pointerup', { ...base, pointerId: 1, pointerType: 'mouse', isPrimary: true, buttons: 0 }),
    );
    node.dispatchEvent(new MouseEvent('mouseup', base));
    node.dispatchEvent(new MouseEvent('click', base));
  } catch {
    // PointerEvent tidak tersedia: tetap beri satu klik biasa.
    node.click();
  }
}

/**
 * Satu langkah perluasan: klik tombol "muat lebih banyak", atau scroll ke bawah
 * untuk memancing infinite scroll.
 *
 * Status dibedakan supaya engine bisa jujur: `timeout` berarti daftar BELUM
 * sempat bertambah, bukan "tidak ada item baru".
 */
async function expandOnce(): Promise<{ status: ExpandStatus; notes: string[] }> {
  const notes: string[] = [];
  const before = listMark();
  const options = { baseUrl: location.href };
  // `baseUrl` membuat lebih.ts menolak link yang akan berpindah dokumen:
  // mengkliknya memindahkan tab, bukan menambah isi daftar.
  const button = findMoreButton(document, options);

  if (!button) {
    // Dilewati bukan berarti habis: catat supaya laporan akhir jujur.
    notes.push(...findBlockedTriggers(document, options));
    const scroller = viewportScroller();
    const canScroll = scroller
      ? canScrollFurther({
          scrollHeight: scroller.scrollHeight,
          scrollTop: scroller.scrollTop,
          clientHeight: scroller.clientHeight,
        })
      : false;
    if (!canScroll) return { status: 'unchanged', notes };
    window.scrollTo(0, document.body.scrollHeight);
  } else {
    clickLikeHuman(button);
  }

  const deadline = Date.now() + EXPAND_WAIT_MS;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, EXPAND_POLL_MS));
    const now = markOf(before.container);
    if (now.signature !== before.signature) {
      // Daftar virtualized membuang item lama dari DOM saat scroll: jumlah
      // turun berarti snapshot bolong, dan itu harus dikatakan.
      if (before.count > 0 && now.count < before.count) {
        notes.push('Daftar kemungkinan virtualized: jumlah item di halaman turun. Hasil bisa bolong.');
      }
      return { status: 'grown', notes };
    }
  }

  return { status: 'timeout', notes };
}

async function expandSnapshot(itemSelector: string | null = null) {
  const result = await expandOnce();
  return pageSnapshot(result, itemSelector);
}

/** Ringkasan sumber data, untuk panel "kenapa sumber ini yang dipakai". */
async function probeSummary(): Promise<TabProbeResponse> {
  const url = location.href;
  const notes: string[] = [];

  let sources: ReturnType<typeof scanCaptures>['sources'] = [];
  let captureCount = 0;
  try {
    const captures = await bridge.list();
    captureCount = captures.length;
    const scan = scanCaptures(captures, url);
    sources = scan.sources;
    if (sources.length === 0 && scan.notes.length > 0) notes.push(...scan.notes.slice(0, 2));
  } catch {
    notes.push('Tidak bisa membaca request JSON halaman ini.');
  }

  const probe = probeDocument(document, url, sources);

  // Recipe yang tersimpan harus terlihat di panel: user menekan "Mulai ambil"
  // dan mengharapkan jumlah item yang sama dengan yang dia pilih dulu.
  const matched = recipe ? applyRecipe(recipe, document, siteKey(url)) : null;
  if (matched?.reason) notes.push(matched.reason);
  if (matched && matched.reason === null && matched.items.length > 0) {
    const items = itemsFromElements(matched.items, url);
    probe.candidates.unshift({
      source: 'dom',
      label: `Recipe · ${recipe!.item} (${items.length} item)`,
      itemCount: items.length,
      score: 999,
      mapping: null,
      items,
      container: matched.container,
    });
    probe.best = probe.candidates[0] ?? null;
  }

  const bestNetwork = probe.best
    ? sources.find((source) => source.items === probe.best?.items)
    : undefined;

  return {
    url,
    title: document.title,
    notes: [...probe.notes, ...notes],
    candidates: probe.candidates.map((candidate) => ({
      source: candidate.source,
      label: candidate.label,
      itemCount: candidate.itemCount,
      score: candidate.score,
    })),
    best: probe.best
      ? {
          source: probe.best.source,
          label: probe.best.label,
          itemCount: probe.best.itemCount,
        }
      : null,
    api: bestNetwork?.api ?? null,
    captures: captureCount,
  };
}

/** Satu halaman siap tulis ke DB: item, sumber, dan URL halaman berikutnya. */
function pageSnapshot(
  expand?: { status: ExpandStatus; notes: string[] },
  itemSelector: string | null = null,
) {
  const url = location.href;
  const limit = PAGE_SNAPSHOT_LIMITS.maxItemsPerPage;
  const matched = recipe ? applyRecipe(recipe, document, siteKey(url)) : null;
  const useRecipe = matched !== null && matched.reason === null && matched.items.length > 0;
  // Run yang dimulai dari picker membawa selector item-nya sendiri: halaman
  // berikutnya harus memakai set yang sama, bukan tebakan ulang.
  const forced = itemSelector ? Array.from(document.querySelectorAll(itemSelector)) : [];
  const useForced = forced.length > 0;
  const probe = probeDocument(document, url);

  // `notes` sengaja HANYA berisi masalah nyata (pemicu dilewati, daftar
  // virtualized, recipe patah). Penjelasan probe tidak ikut: engine
  // menyimpannya sebagai `lastError`, dan "kenapa sumber ini dipakai" bukan error.
  const notes = [
    ...new Set([
      ...(expand?.notes ?? []),
      ...(matched?.reason ? [matched.reason] : []),
      ...findBlockedTriggers(document, { baseUrl: url }),
    ]),
  ];

  return {
    url,
    items: useForced
      ? itemsFromElements(forced, url).slice(0, limit)
      : useRecipe
        ? itemsFromElements(matched!.items, url).slice(0, limit)
        : probe.best
          ? probe.best.items.slice(0, limit)
          : [],
    // Link "berikutnya" dulu; kalau situs hanya punya pagination bernomor atau
    // tombol berikon, parameter URL dinaikkan. Pengaman `duplicate-page` di
    // engine akan menghentikan run kalau tebakan ini ternyata tidak berpengaruh.
    nextUrl: findNextUrl(document, url) ?? guessNextUrl(url),
    source: useForced || useRecipe ? ('dom' as const) : probe.best?.source ?? 'dom',
    selector: useForced ? itemSelector : useRecipe ? recipe!.item : probe.best?.label ?? null,
    notes,
    canExpand: canExpandPage(),
    expandStatus: expand?.status,
  };
}

export default defineContentScript({
  matches: ['*://*/*'],
  runAt: 'document_idle',
  main() {
    // Pickers tidak lagi dipanggil dengan shortcut keyboard: kombinasi global
    // bisa direbut ekstensi lain tanpa pemberitahuan. Jalur masuknya tombol
    // melayang, klik kanan di halaman, popup, dan tombol di side panel.
    launcher = new PickerLauncher({
      onOpen: () => toggle(),
      onHide: () => void hideLauncherFromPage(),
    });
    void refreshLauncher();
    void refreshRecipe();

    browser.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (LAUNCHER_ENABLED_KEY in changes) void refreshLauncher();
      if (Object.keys(changes).some((key) => key.startsWith('recipe:'))) void refreshRecipe();
    });

    browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message?.type === MESSAGE.togglePicker) {
        toggle();
        sendResponse({ active });
        return true;
      }

      if (message?.type === MESSAGE.pickerState) {
        // Tanpa mengubah apa pun: popup cuma perlu tahu label tombolnya.
        sendResponse({ active });
        return true;
      }

      if (message?.type === MESSAGE.probe) {
        void probeSummary().then(sendResponse);
        return true;
      }

      if (message?.type === MESSAGE.fetchPage) {
        const itemSelector =
          typeof message.itemSelector === 'string' ? message.itemSelector : null;
        if (message.expand === true) {
          // Perluasan menunggu DOM situs, jadi balasan dikirim belakangan.
          void expandSnapshot(itemSelector).then(sendResponse);
          return true;
        }
        sendResponse(pageSnapshot(undefined, itemSelector));
        return true;
      }

      if (message?.type === MESSAGE.diagnose) {
        void paginationFacts().then(sendResponse);
        return true;
      }

      if (message?.type === MESSAGE.armNet) {
        bridge.arm();
        sendResponse({ ok: true });
        return true;
      }

      if (message?.type === MESSAGE.disarmNet) {
        bridge.disarm();
        sendResponse({ ok: true });
        return true;
      }

      if (message?.type === MESSAGE.netSecrets) {
        // Nilai token hanya hidup di hook MAIN world; tidak pernah disimpan.
        const plan = {
          url: typeof message.url === 'string' ? message.url : '',
          method: typeof message.method === 'string' ? message.method : 'GET',
        };
        void bridge.list().then((captures) => sendResponse(findSecretSource(plan, captures)));
        return true;
      }

      if (message?.type === MESSAGE.replayNet) {
        const url = typeof message.url === 'string' ? message.url : '';
        if (!url) {
          sendResponse({ ok: false, status: 0, url: '', body: '', truncated: false, error: 'URL kosong.' });
          return true;
        }
        // Body POST ikut diteruskan; hanya content-type dari header yang dipakai.
        void bridge
          .replay(url, {
            method: typeof message.method === 'string' ? message.method : 'GET',
            body: typeof message.body === 'string' ? message.body : null,
            contentType: typeof message.contentType === 'string' ? message.contentType : null,
          })
          .then((result) => sendResponse(result satisfies TabReplayResponse));
        return true;
      }

      return undefined;
    });
  },
});
