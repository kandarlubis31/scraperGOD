import { browser } from 'wxt/browser';
import { buildExport, type ExportFile } from '@/src/core/export';
import {
  createRun,
  pump,
  savePickedRun,
  startPickRun,
  stopRun,
} from '@/src/core/run/engine';
import {
  apiRequest,
  blockedReason,
  needsSecrets,
  unfilledSecretKeys,
  pageOverlap,
  snapshotFromApiPage,
  type ApiRequestParts,
  type SecretSource,
} from '@/src/core/source/network';
import {
  DexieRunStore,
  ScraperGodDB,
  migrateLegacyDatabase,
} from '@/src/core/store/db';
import {
  MESSAGE,
  RequestSchema,
  type ApiResponse,
  type RunSnapshot,
  type TabProbeResponse,
  type TabReplayResponse,
} from '@/src/messaging/protocol';
import type { ApiPlan, PageSnapshot, Run } from '@/src/shared/types';

/** Menu klik kanan: pintu masuk picker tanpa shortcut keyboard. */
const MENU_PICKER = 'scrapergod:picker';
const MENU_PANEL = 'scrapergod:panel';

/**
 * Service worker: pemilik database, run engine, dan navigasi pagination.
 *
 * Dua hal yang membuat run bertahan saat SW dimatikan:
 * 1. `pump` menyimpan checkpoint per halaman (lihat src/core/run/engine.ts).
 * 2. Saat SW bangun (event apa pun), `resumeActiveRuns()` melanjutkan run yang
 *    masih `queued`/`running`. Lease mencegah dua worker menggarap run yang sama.
 */

const db = new ScraperGodDB();
const store = new DexieRunStore(db);
const TICK_ALARM = 'scrapergod:run-tick';
const TICK_PERIOD_MINUTES = 0.5;
const PAGE_READY_TIMEOUT_MS = 20_000;
/**
 * Batas menunggu daftar benar-benar terisi setelah navigasi. Content script
 * merespons begitu dokumen siap, sedangkan SPA sering baru mengisi daftar
 * belakangan; tanpa jeda ini halaman kosong langsung dianggap "daftar habis".
 */
const PAGE_ITEMS_TIMEOUT_MS = 8_000;
const API_CAPTURE_TIMEOUT_MS = 25_000;
const API_SETTLE_MS = 4_000;
const PUMP_OWNER = 'sw';
/** Jeda antar-halaman: sopan ke situs, dan memberi SPA waktu render. */
const PAGE_DELAY_MS = 1_200;
/** Halaman berurutan tanpa item baru sebelum run dihentikan. */
const IDLE_PAGE_LIMIT = 3;
/** Halaman berurutan yang isinya sudah dikenal sebelum run dihentikan. */
const KNOWN_PAGE_LIMIT = 1;

/** Menahan pump ganda di worker yang sama. Lease menahan sisanya. */
const pumping = new Set<string>();

/**
 * Migrasi dari nama database lama harus selesai sebelum query pertama, dan
 * hanya boleh jalan sekali per umur SW.
 */
const migration = migrateLegacyDatabase(db).catch((error: unknown) => {
  console.warn('[scrapergod] migrasi database gagal:', error);
});
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface TabPageResponse {
  url: string;
  items: PageSnapshot['items'];
  nextUrl: string | null;
  source: PageSnapshot['source'];
  selector: string | null;
  /** Halaman masih bisa di-"muat lebih banyak" / di-scroll. */
  canExpand?: boolean;
  expandStatus?: PageSnapshot['expandStatus'];
  notes?: string[];
}

async function sendToTab<T>(tabId: number, message: unknown): Promise<T> {
  return (await browser.tabs.sendMessage(tabId, message)) as T;
}

async function readTab(
  tabId: number,
  expand = false,
  itemSelector: string | null = null,
): Promise<{ url: string; snapshot: PageSnapshot }> {
  const response = await sendToTab<TabPageResponse>(tabId, {
    type: MESSAGE.fetchPage,
    expand,
    itemSelector,
  });
  if (!response || typeof response.url !== 'string') {
    throw new Error('Halaman tidak merespons.');
  }
  return {
    url: response.url,
    snapshot: {
      items: Array.isArray(response.items) ? response.items : [],
      nextUrl: response.nextUrl ?? null,
      source: response.source ?? 'dom',
      selector: response.selector ?? null,
      canExpand: response.canExpand === true,
      expandStatus: response.expandStatus,
      notes: Array.isArray(response.notes) ? response.notes : [],
    },
  };
}

/**
 * Mengambil snapshot halaman `url` di tab. Kalau tab sedang di halaman lain,
 * tab dinavigasi dulu, lalu ditunggu sampai content script melaporkan URL yang
 * benar — bukan cuma "tab.status === complete", karena SPA bisa selesai lebih
 * awal daripada render.
 */
async function fetchPageInTab(
  tabId: number,
  url: string,
  expand = false,
  itemSelector: string | null = null,
): Promise<PageSnapshot> {
  // Perluasan tidak boleh memakai cache di bawah: cache cuma membaca keadaan
  // sekarang tanpa memicu "muat lebih banyak" / scroll, jadi hasilnya sama
  // terus dan run akan berhenti karena "tidak ada item baru".
  if (expand) {
    try {
      const current = await readTab(tabId, true, itemSelector);
      if (current.url === url) return current.snapshot;
    } catch {
      // content script belum siap; jalur navigasi di bawah yang menangani
    }
    throw new Error('Halaman tidak bisa diperluas (content script tidak merespons).');
  }

  let cached: { url: string; snapshot: PageSnapshot } | null = null;
  try {
    cached = await readTab(tabId, false, itemSelector);
  } catch {
    // content script belum terpasang (halaman baru dimuat / halaman terlarang)
  }

  // Halaman yang benar tapi daftarnya masih kosong belum selesai: di SPA, DOM
  // sering siap sebelum datanya datang.
  const ready = (snapshot: PageSnapshot): boolean => snapshot.items.length > 0;
  if (cached && cached.url === url && ready(cached.snapshot)) return cached.snapshot;

  // Kalau content script belum bisa dihubungi, URL tab tetap harus diperiksa:
  // setelah SW mati, tab bisa sudah pindah halaman. Tanpa ini, run menunggu
  // 20 detik lalu gagal padahal tinggal satu `tabs.update`.
  let needsNavigation = cached !== null && cached.url !== url;
  if (!needsNavigation) {
    try {
      const tab = await browser.tabs.get(tabId);
      needsNavigation = Boolean(tab.url) && tab.url !== url;
    } catch {
      throw new Error('Tab tujuan sudah ditutup.');
    }
  }

  if (needsNavigation) {
    await browser.tabs.update(tabId, { url });
    cached = null;
  }

  /** Halaman sudah di URL yang benar tapi daftarnya kosong; bisa jadi memang habis. */
  let emptySnapshot: PageSnapshot | null =
    cached && cached.url === url ? cached.snapshot : null;

  const deadline = Date.now() + PAGE_READY_TIMEOUT_MS;
  const itemsDeadline = Date.now() + PAGE_ITEMS_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const current = await readTab(tabId, false, itemSelector);
      if (current.url === url) {
        if (ready(current.snapshot)) return current.snapshot;
        emptySnapshot = current.snapshot;
        // Daftar kosong terus setelah batas item: kembalikan apa adanya supaya
        // engine bisa memutuskan (halaman terakhir memang kosong).
        if (Date.now() > itemsDeadline) return current.snapshot;
      }
    } catch {
      // halaman masih memuat
    }
    if (emptySnapshot && Date.now() > itemsDeadline) return emptySnapshot;
    await sleep(400);
  }

  if (emptySnapshot) return emptySnapshot;
  throw new Error(`Halaman tidak siap dalam ${PAGE_READY_TIMEOUT_MS / 1000} detik.`);
}

/** 429/503: jeda bertambah, jangan menghantam situs beruntun. */
const REPLAY_ATTEMPTS = 3;
const REPLAY_BACKOFF_MS = [1_500, 4_000];

async function replayRequest(
  tabId: number,
  request: ApiRequestParts,
): Promise<TabReplayResponse> {
  let last: TabReplayResponse | null = null;

  for (let attempt = 0; attempt < REPLAY_ATTEMPTS; attempt += 1) {
    last = await sendToTab<TabReplayResponse>(tabId, {
      type: MESSAGE.replayNet,
      url: request.url,
      method: request.method,
      body: request.body,
      contentType: request.contentType,
    });
    const status = last?.status ?? 0;
    if (status !== 429 && status !== 503) return last;
    if (attempt < REPLAY_ATTEMPTS - 1) {
      await sleep(REPLAY_BACKOFF_MS[attempt] ?? 4_000);
    }
  }

  return last!;
}

/**
 * Nilai token asli dari request terbaru yang ditangkap hook. Hanya ada di tab
 * asal; tidak pernah dibaca dari database. `null` = halaman sudah di-reload
 * atau hook tidak aktif, jadi placeholder tidak bisa diisi.
 */
async function resolveSecrets(tabId: number, api: ApiPlan): Promise<SecretSource | null> {
  if (!needsSecrets(api)) return null;
  try {
    const response = await sendToTab<SecretSource | null>(tabId, {
      type: MESSAGE.netSecrets,
      url: api.url,
      method: api.method,
    });
    if (response && typeof response === 'object') return response;
  } catch {
    // content script belum siap; dianggap tidak ada token segar
  }
  return null;
}

/**
 * Pesan yang sama untuk semua jalur: user tahu key mana yang hilang dan harus
 * apa, bukan cuma gagal.
 */
function staleSecretMessage(keys: string[]): string {
  return `Body berisi token yang tidak disimpan (${keys.join(', ')}); muat ulang halaman lalu Lanjutkan.`;
}

/**
 * Mengambil satu halaman lewat API situs. Replay dijalankan di tab (MAIN
 * world), bukan di SW: cookie, header, dan CORS-nya sama dengan milik halaman,
 * jadi tidak butuh `host_permissions` tambahan dan tidak menimbulkan request
 * yang "beda" di mata situs.
 */
async function fetchApiPage(run: Run): Promise<PageSnapshot> {
  const api = run.api;
  if (!api) throw new Error('Run ini tidak punya rencana API.');
  if (run.tabId === null) throw new Error('Run API butuh tab asal.');

  const pageIndex = run.checkpoint.page;
  const cursor = run.checkpoint.cursor ?? null;
  const cursorPlan = !api.pageParam && !api.bodyPageParam && api.cursorParam !== null;
  if (cursorPlan && pageIndex > 0 && !cursor) {
    // Cursor tidak ada di checkpoint: menebak cursor berarti mengambil halaman
    // yang salah tanpa terlihat salah. Lebih baik berhenti dengan pesan jelas.
    throw new Error(
      'Cursor halaman tidak ada di checkpoint (mungkin kedaluwarsa). Mulai run baru; cursor tidak ditebak.',
    );
  }

  const secrets = await resolveSecrets(run.tabId, api);
  const request = apiRequest(api, pageIndex, cursor, secrets);
  const missingSecrets = unfilledSecretKeys(request);
  if (missingSecrets.length > 0) throw new Error(staleSecretMessage(missingSecrets));
  const response = await replayRequest(run.tabId, request);
  const blocked = blockedReason(response?.status ?? 0, response?.body ?? '');
  if (blocked) throw new Error(`Halaman ${pageIndex + 1}: ${blocked}`);
  const pageUrl = request.url;

  if (!response?.ok) {
    const detail =
      response?.error ??
      (response?.status === 0
        ? 'permintaan diblokir (tab mungkin sudah pindah halaman atau sesi login habis)'
        : `status ${response?.status ?? '?'}`);
    throw new Error(`API gagal untuk halaman ${pageIndex + 1}: ${detail}.`);
  }
  if (response.truncated) throw new Error('Response API melebihi batas 4 MB.');

  let json: unknown;
  try {
    json = JSON.parse(response.body);
  } catch {
    throw new Error('Response API bukan JSON (mungkin perlu login atau diblokir).');
  }

  return snapshotFromApiPage(json, api, pageUrl, pageIndex);
}

interface VerifyResult {
  api: ApiPlan;
  /** Ada = rencana tidak bisa melanjutkan; jangan dipakai. */
  reject: string | null;
  /** Catatan non-fatal (sebagian item berulang). */
  note: string | null;
}

/**
 * Halaman 2 yang hampir seluruhnya mengulang halaman 1 berarti rencananya
 * tidak bisa melanjutkan apa pun. Ditolak di depan dengan alasan, bukan
 * dibiarkan menghasilkan run "selesai" berisi satu halaman data.
 *
 * Hasilnya disimpan di rencana (`verified`): resume setelah SW mati tidak
 * mengirim dua request pembanding lagi.
 */
async function verifyApiPlan(tabId: number, api: ApiPlan): Promise<VerifyResult> {
  if (api.verified) return { api, reject: null, note: api.verifyNote };

  try {
    const secrets = await resolveSecrets(tabId, api);
    const firstRequest = apiRequest(api, 0, null, secrets);
    // Tanpa token segar, pembanding ini tidak ada artinya.
    if (unfilledSecretKeys(firstRequest).length > 0) return { api, reject: null, note: null };

    const first = await replayRequest(tabId, firstRequest);
    if (!first?.ok) return { api, reject: null, note: null };
    const firstJson: unknown = JSON.parse(first.body);
    if (!firstJson || typeof firstJson !== 'object') return { api, reject: null, note: null };

    const firstSnapshot = snapshotFromApiPage(firstJson, api, api.url, 0);
    const second = await replayRequest(
      tabId,
      apiRequest(api, 1, firstSnapshot.nextCursor ?? null, secrets),
    );
    if (!second?.ok) return { api, reject: null, note: null };
    const secondJson: unknown = JSON.parse(second.body);

    const overlap = pageOverlap(
      firstSnapshot.items,
      snapshotFromApiPage(secondJson, api, api.url, 1).items,
      api.url,
    );
    return {
      api: { ...api, verified: true, verifyNote: overlap.note },
      reject: overlap.rejected,
      note: overlap.note,
    };
  } catch {
    // Pemeriksaan gagal bukan alasan menolak rencana; engine tetap punya
    // pengaman duplicate-page.
    return { api, reject: null, note: null };
  }
}

/**
 * Merekam API situs: nyalakan hook, muat ulang tab sekali, lalu tunggu sampai
 * probe menemukan response JSON yang bisa dipaginasi.
 *
 * Reload memang diperlukan untuk SPA: request pertama sudah terjadi sebelum
 * user menekan tombol apa pun, jadi hook yang dinyalakan belakangan tidak akan
 * pernah melihatnya.
 */
async function captureApi(tabId: number): Promise<TabProbeResponse> {
  try {
    await sendToTab(tabId, { type: MESSAGE.armNet });
  } catch {
    throw new Error('Halaman tidak bisa disiapkan untuk merekam API.');
  }

  try {
    await browser.tabs.reload(tabId);

    const deadline = Date.now() + API_CAPTURE_TIMEOUT_MS;
    let firstReadyAt = 0;
    let last: TabProbeResponse | null = null;

    while (Date.now() < deadline) {
      await sleep(600);
      try {
        const probe = await sendToTab<TabProbeResponse>(tabId, { type: MESSAGE.probe });
        if (!probe?.url) continue;
        last = probe;
        if (!firstReadyAt) firstReadyAt = Date.now();
        if (probe.api) {
          const check = await verifyApiPlan(tabId, probe.api);
          const notes = check.note ? [...probe.notes, check.note] : probe.notes;
          if (check.reject) return { ...probe, api: null, notes: [...notes, check.reject] };
          return { ...probe, api: check.api, notes };
        }
        // Halaman sudah siap tapi belum ada API: beri waktu SPA memanggil fetch
        // susulan sebelum menyerah, jangan langsung gagal.
        if (Date.now() - firstReadyAt > API_SETTLE_MS) return probe;
      } catch {
        // content script belum terpasang setelah reload
      }
    }

    if (last) return last;
    throw new Error('Halaman tidak selesai dimuat ulang untuk merekam API.');
  } finally {
    // Matikan rekaman apa pun hasilnya: isi response situs tidak perlu dibaca
    // lebih lama dari yang diminta user.
    void sendToTab(tabId, { type: MESSAGE.disarmNet }).catch(() => undefined);
  }
}

/** Side panel dibuka dari menu; butuh gestur user, dan klik menu memenuhinya. */
async function openSidePanel(tabId: number | undefined): Promise<void> {
  const api = (browser as unknown as {
    sidePanel?: { open(options: { tabId?: number }): Promise<void> };
  }).sidePanel;
  if (!api) return;
  await api.open(tabId === undefined ? {} : { tabId });
}

/**
 * Menu didaftarkan ulang setiap install/update. Isinya sengaja sedikit: tiap
 * tambahan menu memakan tempat di klik kanan, dan dua ini sudah menutup semua
 * jalan masuk yang dibutuhkan tanpa perlu menghafal tombol.
 */
async function registerMenus(): Promise<void> {
  try {
    await browser.contextMenus.removeAll();
    browser.contextMenus.create({
      id: MENU_PICKER,
      title: 'Mulai picker di halaman ini',
      contexts: ['page', 'selection', 'link', 'image'],
    });
    browser.contextMenus.create({
      id: MENU_PANEL,
      title: 'Buka panel scraperGOD',
      contexts: ['page', 'action'],
    });
  } catch (error) {
    console.warn('[scrapergod] menu gagal didaftarkan:', error);
  }
}

async function syncAlarm(): Promise<void> {
  const active = await store.listRunsByStatus(['queued', 'running']);
  const existing = await browser.alarms.get(TICK_ALARM);

  if (active.length > 0 && !existing) {
    browser.alarms.create(TICK_ALARM, { periodInMinutes: TICK_PERIOD_MINUTES });
  } else if (active.length === 0 && existing) {
    await browser.alarms.clear(TICK_ALARM);
  }
}

async function pumpRun(runId: string): Promise<void> {
  if (pumping.has(runId)) return;
  pumping.add(runId);
  try {
    // Rencana yang memuat token butuh request situs terbaru sebagai sumber
    // nilai asli; nyalakan hook supaya request berikutnya tertangkap.
    const active = await store.getRun(runId);
    if (active?.api && active.tabId !== null && needsSecrets(active.api)) {
      void sendToTab(active.tabId, { type: MESSAGE.armNet }).catch(() => undefined);
    }

    await pump(runId, {
      store,
      owner: PUMP_OWNER,
      idlePageLimit: IDLE_PAGE_LIMIT,
      knownPageLimit: KNOWN_PAGE_LIMIT,
      delayMs: PAGE_DELAY_MS,
      fetchPage: async (url, run, opts) => {
        if (run.api) return fetchApiPage(run);
        if (run.tabId === null) throw new Error('Run ini tidak terikat ke tab.');
        return fetchPageInTab(
          run.tabId,
          url,
          opts?.expand === true,
          run.selector ?? null,
        );
      },
    });
  } catch (error) {
    console.warn('[scrapergod] pump gagal:', error);
  } finally {
    pumping.delete(runId);
    void syncAlarm();
  }
}

/** Dipanggil saat SW start, alarm, dan setelah install/update. */
async function resumeActiveRuns(): Promise<void> {
  await migration;
  const runs = await store.listRunsByStatus(['queued', 'running']);
  await Promise.all(runs.map((run) => pumpRun(run.id)));
  await syncAlarm();
}

async function snapshotOf(runId: string): Promise<RunSnapshot | null> {
  const run = await store.getRun(runId);
  if (!run) return null;
  return { run, recordCount: await store.countRecords(runId) };
}

async function handle(raw: unknown, senderTabId?: number): Promise<ApiResponse<unknown>> {
  await migration;
  const parsed = RequestSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: 'Pesan tidak dikenal.' };
  const request = parsed.data;

  try {
    switch (request.type) {
      case 'run:start': {
        let info = await sendToTab<TabProbeResponse>(request.tabId, {
          type: MESSAGE.probe,
        });
        if (!info?.url) throw new Error('Halaman ini tidak bisa dipakai.');

        // Rencana API bisa datang dari dua jalan: sudah ada capture sebelumnya,
        // atau user mengizinkan satu kali reload untuk merekamnya.
        if (!info.api && request.captureApi) {
          info = await captureApi(request.tabId);
          if (!info.api) {
            const detail = info.notes.slice(0, 2).join(' ');
            throw new Error(
              'API situs tidak terdeteksi. Matikan opsi "Rekam API" untuk mengambil lewat halaman biasa.' +
                (detail ? ` ${detail}` : ''),
            );
          }
        }

        const run = await createRun(
          {
            startUrl: info.url,
            tabId: request.tabId,
            maxPages: request.maxPages,
            maxItems: request.maxItems,
            incremental: request.incremental,
            api: info.api,
          },
          { store },
        );

        void pumpRun(run.id);
        return { ok: true, data: { run, recordCount: 0 } satisfies RunSnapshot };
      }

      case 'pick:save': {
        const { run, recordCount } = await savePickedRun(
          {
            url: request.page.url,
            items: request.page.items,
            source: request.page.source,
            selector: request.page.selector,
            tabId: null,
          },
          { store },
        );
        return { ok: true, data: { run, recordCount } satisfies RunSnapshot };
      }

      case 'pick:run': {
        const { run, recordCount } = await startPickRun(
          {
            url: request.page.url,
            items: request.page.items,
            source: request.page.source,
            selector: request.page.itemSelector,
            container: request.page.container,
            target: request.page.target,
            tabId: senderTabId ?? null,
          },
          { store },
        );
        // Target belum tercapai: `pump` melanjutkan dengan jalur pagination yang
        // sudah ada (API replay / link berikutnya / muat lebih).
        if (run.status === 'queued') void pumpRun(run.id);
        return { ok: true, data: { run, recordCount } satisfies RunSnapshot };
      }

      case 'run:get': {
        const snapshot = await snapshotOf(request.runId);
        if (!snapshot) return { ok: false, error: 'Run tidak ditemukan.' };
        return { ok: true, data: snapshot };
      }

      case 'run:stop': {
        const run = await stopRun(request.runId, store);
        if (!run) return { ok: false, error: 'Run tidak ditemukan.' };
        await syncAlarm();
        return { ok: true, data: { run, recordCount: await store.countRecords(run.id) } };
      }

      case 'run:resume': {
        const run = await store.getRun(request.runId);
        if (!run) return { ok: false, error: 'Run tidak ditemukan.' };
        void pumpRun(run.id);
        return { ok: true, data: { run, recordCount: await store.countRecords(run.id) } };
      }

      case 'run:export': {
        const run = await store.getRun(request.runId);
        if (!run) return { ok: false, error: 'Run tidak ditemukan.' };
        const all = await store.listRecords(request.runId);
        const records = request.onlyNew ? all.filter((record) => record.isNew) : all;
        // Ukuran run bisa ribuan baris; pesan balasan tetap satu potong blob.
        const file: ExportFile = buildExport(run, records, request.format);
        return { ok: true, data: file };
      }

      case 'records:preview': {
        const all = await store.listRecords(request.runId);
        const records = request.onlyNew ? all.filter((record) => record.isNew) : all;
        return { ok: true, data: records.slice(0, request.limit ?? 20) };
      }

      case 'records:all': {
        const all = await store.listRecords(request.runId);
        return { ok: true, data: request.onlyNew ? all.filter((r) => r.isNew) : all };
      }

      case 'run:delete': {
        const run = await store.getRun(request.runId);
        if (!run) return { ok: false, error: 'Run tidak ditemukan.' };
        if (run.status === 'running' || run.status === 'queued') {
          return { ok: false, error: 'Hentikan run dulu sebelum menghapus.' };
        }
        await store.deleteRun(request.runId);
        await syncAlarm();
        return { ok: true, data: await store.listRecentRuns(10) };
      }

      case 'run:recent': {
        return { ok: true, data: await store.listRecentRuns(10) };
      }

      case 'probe:tab': {
        const info = await sendToTab<TabProbeResponse>(request.tabId, {
          type: MESSAGE.probe,
        });
        return { ok: true, data: info };
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: message };
  }
}

export default defineBackground(() => {
  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const type = (message as { type?: unknown } | null)?.type;
    if (typeof type !== 'string' || !type.includes(':')) return undefined;

    void handle(message, sender?.tab?.id).then(sendResponse);
    return true;
  });

  browser.runtime.onStartup.addListener(() => {
    void resumeActiveRuns();
  });

  browser.runtime.onInstalled.addListener(() => {
    void registerMenus();
    void resumeActiveRuns();
  });

  browser.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId === MENU_PICKER) {
      if (typeof tab?.id !== 'number') return;
      void sendToTab(tab.id, { type: MESSAGE.togglePicker }).catch(() => undefined);
      return;
    }
    if (info.menuItemId === MENU_PANEL) {
      void openSidePanel(tab?.id).catch(() => undefined);
    }
  });

  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === TICK_ALARM) void resumeActiveRuns();
  });

  // SW bisa bangun bukan karena alarm (mis. panel dibuka) — lanjutkan juga.
  void resumeActiveRuns();
});
