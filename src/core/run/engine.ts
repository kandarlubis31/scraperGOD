import { RecordRowSchema, RunSchema } from '@/src/shared/types';
import type {
  ApiPlan,
  PageItem,
  PageSnapshot,
  RecordRow,
  Run,
  SeenEntry,
  SourceKind,
  StopReason,
} from '@/src/shared/types';
import { absoluteUrl, siteKey, urlKey } from '@/src/shared/url';
import type { RunStore } from '../store/types';

/**
 * Run engine yang tahan service worker dimatikan.
 *
 * Aturan yang membuat ini bekerja:
 * - Checkpoint dan record halaman ditulis dalam satu transaksi.
 * - Id record = `${runId}:${urlKey}`, jadi resume setelah crash tidak pernah
 *   menambah baris ganda, walaupun halaman yang sama diambil dua kali.
 * - Lease diperbarui setiap halaman. Kalau SW mati, lease kedaluwarsa dan
 *   worker berikutnya boleh melanjutkan.
 */

const DEFAULT_MAX_PAGES = 50;
const DEFAULT_MAX_ITEMS = 5_000;
const DEFAULT_LEASE_TTL_MS = 25_000;
/** Pagination yang terus memberi halaman kosong harus berhenti sendiri. */
const DEFAULT_IDLE_PAGE_LIMIT = 3;
/**
 * Halaman berurutan yang isinya sudah dikenal sebelum run ini, sebelum run
 * dihentikan. Satu halaman cukup untuk daftar terbaru-dulu, tapi lihat catatan
 * di `pump`: halaman pertama tidak dihitung.
 */
const DEFAULT_KNOWN_PAGE_LIMIT = 1;

export interface EngineDeps {
  store: RunStore;
  /**
   * Mengambil satu halaman. `opts.expand` berarti halaman yang SAMA diminta
   * bertambah isinya (klik "muat lebih banyak" / scroll), bukan navigasi.
   */
  fetchPage: (url: string, run: Run, opts?: { expand: boolean }) => Promise<PageSnapshot>;
  now?: () => number;
  owner?: string;
  leaseTtlMs?: number;
  /** Berapa halaman berurutan tanpa item baru sebelum run dianggap selesai. */
  idlePageLimit?: number;
  /** Halaman berurutan yang isinya sudah dikenal sebelum run berhenti cepat. */
  knownPageLimit?: number;
  /** Jeda antar-halaman, supaya situs tidak dihantam beruntun. */
  delayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

function newId(): string {
  const cryptoObj = globalThis.crypto;
  if (cryptoObj && typeof cryptoObj.randomUUID === 'function') {
    return cryptoObj.randomUUID();
  }
  return `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export interface CreateRunInput {
  startUrl: string;
  tabId?: number | null;
  maxPages?: number;
  maxItems?: number;
  /** Berhenti saat halaman isinya sudah dikenal (untuk daftar terbaru-dulu). */
  incremental?: boolean;
  /** Ada = halaman diambil lewat API situs (replay), bukan navigasi tab. */
  api?: ApiPlan | null;
  /** Selector item hasil picker, dipakai halaman berikutnya. */
  selector?: string | null;
  container?: string | null;
}

export async function createRun(
  input: CreateRunInput,
  deps: Pick<EngineDeps, 'store' | 'now'>,
): Promise<Run> {
  const now = deps.now?.() ?? Date.now();
  const run = RunSchema.parse({
    id: newId(),
    status: 'queued',
    startUrl: input.startUrl,
    tabId: input.tabId ?? null,
    maxPages: input.maxPages ?? DEFAULT_MAX_PAGES,
    maxItems: input.maxItems ?? DEFAULT_MAX_ITEMS,
    createdAt: now,
    updatedAt: now,
    finishedAt: null,
    checkpoint: {
      nextUrl: null,
      page: 0,
      itemCount: 0,
      lastFingerprint: null,
      emptyPages: 0,
      seenPages: 0,
      expand: false,
      cursor: null,
    },
    lease: null,
    lastError: null,
    stopReason: null,
    incremental: input.incremental ?? true,
    api: input.api ?? null,
    selector: input.selector ?? null,
    container: input.container ?? null,
  });
  await deps.store.putRun(run);
  return run;
}

/** Apakah worker lain masih memegang run ini? Lease kedaluwarsa = boleh diambil. */
export function isBusy(run: Run, owner: string, at: number): boolean {
  return Boolean(run.lease && run.lease.owner !== owner && run.lease.expiresAt > at);
}

function isTerminal(run: Run): boolean {
  return run.status === 'done' || run.status === 'stopped' || run.status === 'failed';
}

/**
 * Identitas untuk item yang tidak punya URL. Tanpa ini, daftar film/tabel teks
 * tanpa tautan akan tersimpan kosong: `urlKey('')` = '', dan dulu record-nya
 * langsung `continue` — user melihat "0 item" padahal halaman penuh data.
 *
 * Kunci dibentuk dari judul + nilai field, jadi stabil antar halaman (dedupe
 * tetap jalan) dan tidak menggabungkan dua item berbeda yang judulnya sama.
 */
export function localItemKey(item: PageItem): string {
  const title = item.title.replace(/\s+/g, ' ').trim().toLowerCase();
  if (!title) return '';
  const rest = Object.values(item.fields)
    .filter(Boolean)
    .join(' · ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  return `no-url:${`${title}|${rest}`.slice(0, 240)}`;
}

function buildRecords(
  run: Run,
  snapshot: PageSnapshot,
  pageUrl: string,
  at: number,
  knownKeys: Set<string>,
  seenBefore: Set<string>,
): { records: RecordRow[]; fingerprint: string; newCount: number } {
  /** Kunci SEMUA item di halaman ini, walau tidak disimpan. */
  const pageKeys = new Set<string>();
  /** Kunci yang belum pernah terlihat di run mana pun sebelumnya. */
  const notSeenBefore = new Set<string>();
  const records: RecordRow[] = [];
  const remaining = Math.max(0, run.maxItems - run.checkpoint.itemCount);

  for (const item of snapshot.items) {
    const key = urlKey(item.url, pageUrl) || localItemKey(item);
    if (!key) continue;
    pageKeys.add(key);
    if (!seenBefore.has(key)) notSeenBefore.add(key);

    // Sudah tersimpan dari halaman sebelumnya (lazy-load sering mengulang
    // item terakhir). Jangan simpan ulang dan jangan hitung sebagai item baru.
    if (knownKeys.has(key)) continue;
    // Jatah maxItems habis: item ini tetap masuk fingerprint, tapi tidak disimpan.
    if (records.length >= remaining) continue;

    knownKeys.add(key);
    records.push(
      RecordRowSchema.parse({
        id: `${run.id}:${key}`,
        runId: run.id,
        urlKey: key,
        url: absoluteUrl(item.url, pageUrl) || item.url,
        title: item.title,
        fields: item.fields,
        raw: item.raw,
        provenance: {
          source: snapshot.source,
          pageUrl,
          selector: snapshot.selector,
          adapter: null,
          capturedAt: at,
        },
        firstSeenAt: at,
        lastSeenAt: at,
        isNew: !seenBefore.has(key),
      }),
    );
  }

  return {
    records,
    fingerprint: [...pageKeys].sort().join('|'),
    newCount: notSeenBefore.size,
  };
}

/**
 * Menjalankan run sampai selesai, berhenti, atau kena limit. Fungsi ini aman
 * dipanggil ulang: kalau run `paused` atau SW baru bangun, panggilan berikutnya
 * melanjutkan dari checkpoint.
 */
export async function pump(runId: string, deps: EngineDeps): Promise<Run> {
  const store = deps.store;
  const now = deps.now ?? Date.now;
  const owner = deps.owner ?? 'sw';
  const ttl = deps.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
  const idlePageLimit = Math.max(1, deps.idlePageLimit ?? DEFAULT_IDLE_PAGE_LIMIT);
  const knownPageLimit = Math.max(1, deps.knownPageLimit ?? DEFAULT_KNOWN_PAGE_LIMIT);
  const delayMs = Math.max(0, deps.delayMs ?? 0);
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  const stored = await store.getRun(runId);
  if (!stored) throw new Error(`run ${runId} tidak ditemukan`);
  let run = stored;

  // Diambil sekali di awal: cukup untuk seluruh run, dan tidak perlu query
  // per halaman. Isi DB untuk run ini hanya bertambah dari loop di bawah.
  const knownKeys = new Set(await store.listUrlKeys(run.id));

  while (true) {
    if (isTerminal(run)) return run;

    const at = now();
    if (isBusy(run, owner, at)) return run;

    const itemCount = run.checkpoint.itemCount;
    if (itemCount >= run.maxItems) {
      run = {
        ...run,
        status: 'done',
        stopReason: 'max-items',
        updatedAt: at,
        finishedAt: at,
      };
      await store.putRun(run);
      return run;
    }

    const pageUrl = run.checkpoint.nextUrl ?? run.startUrl;

    /** Fetch ini adalah percobaan memperluas halaman sebelumnya (muat lebih/scroll). */
    const expanding = run.checkpoint.expand === true;

    let snapshot: PageSnapshot;
    try {
      snapshot = await deps.fetchPage(pageUrl, run, { expand: expanding });
    } catch (error) {
      const paused: Run = {
        ...run,
        status: 'paused',
        stopReason: 'error',
        lastError: messageOf(error),
        updatedAt: at,
      };
      await store.putRun(paused);
      return paused;
    }

    // User bisa menekan Stop saat fetch masih jalan. Cek ulang sebelum menulis,
    // supaya halaman yang sudah terlanjur diambil tidak menimpa status stopped.
    const latest = await store.getRun(run.id);
    if (!latest) return run;
    if (isTerminal(latest)) return latest;
    if (isBusy(latest, owner, now())) return latest;
    run = latest;

    // Waktu setelah fetch, bukan sebelum: halaman lambat tidak boleh memakan
    // umur lease (dulu lease bisa tinggal 5 detik setelah fetch 20 detik).
    const commitAt = now();
    // Riwayat lintas-run diambil per halaman (satu bulkGet), bukan dimuat
    // seluruhnya di awal: tabel `seen` bisa jauh lebih besar dari satu run.
    const seenBefore = await store.seenUrlKeys(
      snapshot.items.map((item) => urlKey(item.url, pageUrl)),
    );
    const { records, fingerprint, newCount } = buildRecords(
      run,
      snapshot,
      pageUrl,
      commitAt,
      knownKeys,
      seenBefore,
    );
    // Percobaan memperluas halaman memang boleh menghasilkan isi yang sama;
    // yang menghentikannya `emptyPages`, bukan `duplicate-page`.
    const repeated =
      !expanding &&
      run.checkpoint.page > 0 &&
      fingerprint.length > 0 &&
      fingerprint === run.checkpoint.lastFingerprint;

    if (repeated) {
      const stopped: Run = {
        ...run,
        status: 'done',
        stopReason: 'duplicate-page',
        updatedAt: commitAt,
        finishedAt: commitAt,
      };
      await store.putRun(stopped);
      return stopped;
    }

    /**
     * Tanpa link "berikutnya", daftar masih bisa tumbuh: tombol "muat lebih
     * banyak" atau infinite scroll. Halaman yang sama diambil ulang dengan
     * `expand: true`, jadi dedupe, `emptyPages`, dan batas halaman yang sudah
     * ada tetap berlaku — tidak perlu mesin pagination kedua.
     */
    let nextUrl: string | null = null;
    let nextExpand = false;
    if (snapshot.nextUrl) {
      nextUrl = absoluteUrl(snapshot.nextUrl, pageUrl) || null;
    } else if (snapshot.canExpand === true) {
      nextUrl = pageUrl;
      nextExpand = true;
    }
    const nextItemCount = run.checkpoint.itemCount + records.length;
    const nextPage = run.checkpoint.page + 1;
    // Halaman tanpa item baru = pagination sudah tidak memberi apa-apa lagi.
    // Ini menyelamatkan run dari situs yang mengulang halaman kosong tanpa
    // pernah benar-benar habis (lazy-load, filter kosong, API yang berhenti).
    const emptyPages = records.length === 0 ? (run.checkpoint.emptyPages ?? 0) + 1 : 0;
    /**
     * Halaman yang seluruh isinya sudah dikenal dari run sebelumnya.
     *
     * Halaman pertama sengaja tidak dihitung: satu halaman belum membuktikan
     * urutan situs (terbaru-dulu atau tidak), dan hasil picker juga menandai
     * item sebagai dikenal — berhenti di halaman 1 akan melewatkan sisa daftar
     * hanya karena user pernah menekan "Ambil" di halaman itu.
     */
    const seenPages =
      snapshot.items.length > 0 && newCount === 0 && run.checkpoint.page > 0
        ? (run.checkpoint.seenPages ?? 0) + 1
        : 0;

    /**
     * Pemicu yang sengaja dilewati (mis. tombol yang menuju dokumen lain) TIDAK
     * boleh terbaca sebagai "daftar habis": bedanya penting bagi user. Catatan
     * dari content script menentukan stop reason-nya.
     */
    const skippedTrigger =
      snapshot.notes?.find((note) => note.includes('menuju dokumen lain')) ?? null;

    let stopReason: StopReason | null = null;
    /** Waktu tunggu habis: daftar BELUM tentu habis, jadi jangan bilang begitu. */
    if (expanding && snapshot.expandStatus === 'timeout') stopReason = 'expand-timeout';
    else if (!nextUrl && skippedTrigger) stopReason = 'expand-blocked';
    else if (!nextUrl) stopReason = 'next-missing';
    else if (nextPage >= run.maxPages) stopReason = 'max-pages';
    else if (nextItemCount >= run.maxItems) stopReason = 'max-items';
    else if (emptyPages >= idlePageLimit) stopReason = 'no-new-items';
    else if (run.incremental !== false && seenPages >= knownPageLimit) {
      stopReason = 'all-known';
    }

    const nextRun: Run = {
      ...run,
      status: stopReason ? 'done' : 'running',
      updatedAt: commitAt,
      finishedAt: stopReason ? commitAt : null,
      stopReason,
      // Catatan non-fatal (pemicu dilewati, daftar mungkin virtualized) tetap
      // disimpan supaya user tahu kenapa hasilnya begitu.
      lastError: snapshot.notes?.[0] ?? null,
      lease: { owner, expiresAt: commitAt + ttl },
      checkpoint: {
        nextUrl,
        page: nextPage,
        itemCount: nextItemCount,
        lastFingerprint: fingerprint,
        emptyPages,
        seenPages,
        expand: nextExpand,
        // Disimpan di checkpoint: run yang dilanjutkan setelah SW mati memakai
        // cursor yang sama, bukan menebak dari halaman pertama.
        cursor: snapshot.nextCursor ?? null,
      },
    };

    // Ditulis di transaksi yang sama dengan record: kalau SW mati setelah
    // commit, item ini tidak dilaporkan sebagai "baru" untuk kedua kalinya.
    const listing = siteKey(run.startUrl) || pageUrl;
    const seenEntries: SeenEntry[] = records.map((record) => ({
      id: record.urlKey,
      siteKey: listing,
      urlKey: record.urlKey,
      firstSeenAt: commitAt,
      lastSeenAt: commitAt,
      lastRunId: run.id,
    }));

    await store.commitPage(nextRun, records, seenEntries);
    run = nextRun;
    if (stopReason) return run;

    // Jeda dihitung setelah commit: checkpoint sudah aman, jadi kalau SW mati
    // saat menunggu, run berikutnya lanjut dari halaman yang benar.
    if (delayMs > 0) await sleep(delayMs);
  }
}

export interface PickPageInput {
  url: string;
  items: PageItem[];
  source?: SourceKind;
  selector?: string | null;
  container?: string | null;
  tabId?: number | null;
}

/**
 * Hasil "Ambil" dari picker disimpan sebagai run yang sudah selesai, dengan
 * jalur record yang sama seperti run biasa — jadi bisa dipratinjau, diekspor,
 * dan tidak punya bentuk data tersendiri yang harus dirawat terpisah.
 */
export async function savePickedRun(
  input: PickPageInput,
  deps: Pick<EngineDeps, 'store' | 'now'>,
): Promise<{ run: Run; recordCount: number }> {
  const at = deps.now?.() ?? Date.now();
  const run = await createRun(
    {
      startUrl: input.url,
      tabId: input.tabId ?? null,
      maxPages: 1,
      maxItems: Math.max(1, input.items.length),
    },
    deps,
  );

  const snapshot: PageSnapshot = {
    items: input.items,
    nextUrl: null,
    source: input.source ?? 'dom',
    selector: input.selector ?? null,
  };
  const seenBefore = await deps.store.seenUrlKeys(
    input.items.map((item) => urlKey(item.url, input.url)),
  );
  const { records } = buildRecords(run, snapshot, input.url, at, new Set(), seenBefore);

  const done: Run = {
    ...run,
    status: 'done',
    stopReason: 'picked',
    updatedAt: at,
    finishedAt: at,
    lease: null,
    checkpoint: {
      nextUrl: null,
      page: 1,
      itemCount: records.length,
      lastFingerprint: null,
      emptyPages: 0,
      seenPages: 0,
      expand: false,
      cursor: null,
    },
  };

  const listing = siteKey(input.url) || input.url;
  const seenEntries: SeenEntry[] = records.map((record) => ({
    id: record.urlKey,
    siteKey: listing,
    urlKey: record.urlKey,
    firstSeenAt: at,
    lastSeenAt: at,
    lastRunId: done.id,
  }));

  await deps.store.commitPage(done, records, seenEntries);
  return { run: done, recordCount: records.length };
}

export interface StartPickInput extends PickPageInput {
  /** Jumlah item yang ingin disimpan. */
  target: number;
  /** Plafon halaman; default dihitung dari target dan ukuran halaman. */
  maxPages?: number;
}

/**
 * "Ambil + lanjut halaman".
 *
 * Halaman yang dipilih disimpan lebih dulu, lalu run dibiarkan `queued` supaya
 * `pump` melanjutkan ke halaman berikutnya sampai target tercapai. Selector
 * hasil picker disimpan di run, jadi halaman berikutnya memakai daftar item
 * yang sama — bukan tebakan ulang level daftar.
 *
 * `incremental: false` penting: user sudah minta M item, jadi berhenti cepat
 * karena "isinya sudah dikenal" justru membatalkan permintaannya.
 */
export async function startPickRun(
  input: StartPickInput,
  deps: Pick<EngineDeps, 'store' | 'now'>,
): Promise<{ run: Run; recordCount: number }> {
  const at = deps.now?.() ?? Date.now();
  const target = Math.max(1, Math.min(Math.round(input.target), 5_000));
  const items = input.items.slice(0, target);
  const pageSize = Math.max(1, items.length);

  const run = await createRun(
    {
      startUrl: input.url,
      tabId: input.tabId ?? null,
      maxPages: input.maxPages ?? Math.min(200, Math.ceil(target / pageSize) + 2),
      maxItems: target,
      incremental: false,
      selector: input.selector ?? null,
      container: input.container ?? null,
    },
    deps,
  );

  const snapshot: PageSnapshot = {
    items,
    nextUrl: null,
    source: input.source ?? 'dom',
    selector: input.selector ?? null,
  };
  const seenBefore = await deps.store.seenUrlKeys(
    items.map((item) => urlKey(item.url, input.url)),
  );
  const { records } = buildRecords(run, snapshot, input.url, at, new Set(), seenBefore);

  // Target sudah terpenuhi dari halaman ini: tidak perlu pagination sama sekali.
  const finished = records.length >= target;
  const next: Run = {
    ...run,
    status: finished ? 'done' : 'queued',
    stopReason: finished ? 'max-items' : null,
    updatedAt: at,
    finishedAt: finished ? at : null,
    lease: null,
    checkpoint: {
      nextUrl: null,
      page: 1,
      itemCount: records.length,
      // Sengaja null: pembacaan ulang halaman ini oleh `pump` memang identik
      // dengan hasil picker, dan itu bukan pagination yang berputar.
      lastFingerprint: null,
      emptyPages: 0,
      seenPages: 0,
      expand: false,
      cursor: null,
    },
  };

  const listing = siteKey(input.url) || input.url;
  const seenEntries: SeenEntry[] = records.map((record) => ({
    id: record.urlKey,
    siteKey: listing,
    urlKey: record.urlKey,
    firstSeenAt: at,
    lastSeenAt: at,
    lastRunId: run.id,
  }));

  await deps.store.commitPage(next, records, seenEntries);
  return { run: next, recordCount: records.length };
}

/** Berhenti karena user menekan Stop. Checkpoint tetap, jadi bisa dilanjutkan. */
export async function stopRun(
  runId: string,
  store: RunStore,
  now: () => number = Date.now,
): Promise<Run | null> {
  const run = await store.getRun(runId);
  if (!run) return null;
  if (isTerminal(run)) return run;
  const at = now();
  const stopped: Run = {
    ...run,
    status: 'stopped',
    stopReason: 'stopped',
    updatedAt: at,
    finishedAt: at,
    lease: null,
  };
  await store.putRun(stopped);
  return stopped;
}
