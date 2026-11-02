import { useEffect, useRef, useState } from 'react';
import { browser } from 'wxt/browser';
import type { ExportFile, ExportFormat } from '@/src/core/export';
import { hostLabel } from '@/src/core/export/json';
import { SOURCE_COLUMN, toHtmlTable, toTsv } from '@/src/core/export/tsv';
import { buildDiagnosis, type PaginationFacts } from '@/src/core/probe/diagnose';
import type { ApiResponse, RunSnapshot, TabProbeResponse } from '@/src/messaging/protocol';
import type { RecordRow, Run } from '@/src/shared/types';
import { siteKey } from '@/src/shared/url';
import { LAUNCHER_ENABLED_KEY, launcherEnabledFrom } from '@/src/shared/settings';

const POLL_MS = 800;
/** Cukup untuk satu layar penuh; sisanya lewat ekspor. */
const PREVIEW_LIMIT = 50;
const PRODUCT_NAME = browser.runtime.getManifest().name;
const ACTIVE_STATUSES = new Set(['queued', 'running']);

const STOP_LABEL: Record<string, string> = {
  'next-missing': 'halaman habis',
  'max-pages': 'batas halaman',
  'max-items': 'batas item',
  'duplicate-page': 'halaman berulang',
  'no-new-items': 'tidak ada item baru',
  'all-known': 'semua sudah dikenal',
  'expand-timeout': 'batas tunggu muat lebih',
  'expand-blocked': 'pemicu dilewati',
  picked: 'hasil picker',
  stopped: 'dihentikan',
  error: 'error',
};

/** Alasan berhenti dalam kalimat, bukan kode. Dipakai di dekat progres. */
const STOP_HINT: Record<string, string> = {
  'next-missing':
    'Hanya halaman ini yang bisa diambil: tidak ada tombol atau link halaman berikutnya. Jalankan Diagnosa pagination untuk alasannya.',
  'max-pages':
    'Berhenti karena batas halaman tercapai. Naikkan angka Halaman kalau daftarnya masih panjang.',
  'max-items': 'Berhenti karena target item tercapai.',
  'duplicate-page':
    'Halaman berikutnya isinya sama dengan halaman sebelumnya, jadi pagination dihentikan.',
  'no-new-items': 'Beberapa halaman berurutan tidak menambah item baru.',
  'all-known':
    'Halaman berisi item yang sudah pernah diambil. Matikan "Berhenti kalau halaman isinya sudah dikenal" untuk memaksa lanjut.',
  'expand-timeout':
    'Tombol "muat lebih"/scroll tidak menambah item dalam batas tunggu — belum tentu daftar habis.',
  'expand-blocked':
    'Tombol "muat lebih" dilewati karena menuju dokumen lain, jadi daftar tidak bisa dilanjutkan.',
  picked: 'Hasil picker tersimpan (satu halaman).',
  stopped: 'Dihentikan manual. Tekan Lanjutkan untuk melanjutkan.',
  error: 'Berhenti karena error; lihat pesan terakhir di bawah.',
};

async function send<T>(message: unknown): Promise<ApiResponse<T>> {
  try {
    const response = (await browser.runtime.sendMessage(message)) as
      | ApiResponse<T>
      | undefined;
    return response ?? { ok: false, error: 'Service worker tidak merespons.' };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function statusLabel(run: Run | null): string {
  if (!run) return 'belum mulai';
  if (run.status === 'done') {
    const reason = run.stopReason ? STOP_LABEL[run.stopReason] ?? run.stopReason : null;
    return reason ? `selesai · ${reason}` : 'selesai';
  }
  if (run.status === 'paused') return 'berhenti sementara';
  return run.status;
}

/**
 * File dibuat di halaman panel, bukan di service worker: SW tidak punya
 * `URL.createObjectURL`. Panel sudah punya DOM, jadi download tidak butuh
 * permission `downloads` tambahan.
 */
function saveFile(file: ExportFile): void {
  const blob = new Blob([file.content], { type: file.mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = file.filename;
  anchor.rel = 'noopener';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/**
 * Panel adalah halaman ekstensi (secure context), jadi `navigator.clipboard`
 * tersedia. `execCommand` hanya jaring pengaman kalau API itu ditolak.
 */
async function writeClipboard(text: string, html?: string): Promise<void> {
  const clipboard = navigator.clipboard;
  if (clipboard?.write && html && typeof ClipboardItem !== 'undefined') {
    await clipboard.write([
      new ClipboardItem({
        'text/plain': new Blob([text], { type: 'text/plain' }),
        'text/html': new Blob([html], { type: 'text/html' }),
      }),
    ]);
    return;
  }
  if (clipboard?.writeText) {
    await clipboard.writeText(text);
    return;
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.append(area);
  area.select();
  const copied = document.execCommand('copy');
  area.remove();
  if (!copied) throw new Error('Browser menolak menyalin ke klipboard.');
}

/** Waktu ringkas untuk daftar riwayat. */
function when(timestamp: number): string {
  return new Date(timestamp).toLocaleString('id-ID', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Kolom tabel pratinjau.
 *
 * Dulu kolomnya hardcode ke field lowongan (perusahaan/lokasi/gaji). Untuk
 * daftar film, buku, atau produk, tabelnya jadi satu kolom berisi judul dan
 * sisanya kosong — padahal datanya ada. Sekarang kolom kanonik tetap didahulukan
 * kalau ada, lalu kolom lain mengikuti apa pun yang benar-benar tersimpan.
 */
const LEADING_COLUMNS = [{ key: 'title', label: 'Judul' }];
const CANONICAL_COLUMNS = [
  { key: 'company', label: 'Perusahaan' },
  { key: 'location', label: 'Lokasi' },
  { key: 'salary', label: 'Gaji' },
  { key: 'date', label: 'Tanggal' },
];
/** Cukup untuk metadata; sisanya tetap ada di CSV/JSON. */
const MAX_DYNAMIC_COLUMNS = 6;

interface Column {
  key: string;
  label: string;
}

function columnsOf(records: RecordRow[]): Column[] {
  const present = new Set<string>();
  const frequency = new Map<string, number>();
  for (const record of records) {
    for (const key of Object.keys(record.fields)) {
      present.add(key);
      frequency.set(key, (frequency.get(key) ?? 0) + 1);
    }
  }

  const columns: Column[] = [...LEADING_COLUMNS];
  for (const column of CANONICAL_COLUMNS) {
    if (present.has(column.key)) columns.push(column);
  }

  const reserved = new Set([...LEADING_COLUMNS, ...CANONICAL_COLUMNS].map((c) => c.key));
  const extra = [...frequency.keys()]
    .filter((key) => !reserved.has(key))
    .sort(
      (a, b) => (frequency.get(b) ?? 0) - (frequency.get(a) ?? 0) || a.localeCompare(b),
    )
    .slice(0, MAX_DYNAMIC_COLUMNS)
    .map((key) => ({ key, label: key }));

  return [...columns, ...extra];
}

interface ColumnConfig {
  /** Urutan kolom yang dipilih user; key yang tidak ada di sini menyusul. */
  order: string[];
  hidden: string[];
  labels: Record<string, string>;
}

const EMPTY_COLUMN_CONFIG: ColumnConfig = { order: [], hidden: [], labels: {} };
const COLUMNS_KEY_PREFIX = 'columns:';

function normalizeColumnConfig(value: unknown): ColumnConfig {
  const record = (value ?? {}) as Partial<ColumnConfig>;
  const strings = (input: unknown): string[] =>
    Array.isArray(input) ? input.filter((entry): entry is string => typeof entry === 'string') : [];
  const labels =
    record.labels && typeof record.labels === 'object'
      ? Object.fromEntries(
          Object.entries(record.labels).filter(
            (entry): entry is [string, string] => typeof entry[1] === 'string',
          ),
        )
      : {};
  return { order: strings(record.order), hidden: strings(record.hidden), labels };
}

/**
 * Terapkan setelan kolom milik situs ini. Judul selalu pertama: tanpa judul,
 * baris tidak bisa dikenali lagi.
 */
function applyColumnConfig(columns: Column[], config: ColumnConfig): Column[] {
  const remaining = new Map(columns.map((column) => [column.key, column]));
  const ordered: Column[] = [];

  for (const key of config.order) {
    const column = remaining.get(key);
    if (!column) continue;
    ordered.push(column);
    remaining.delete(key);
  }
  for (const column of remaining.values()) ordered.push(column);

  const titleIndex = ordered.findIndex((column) => column.key === 'title');
  if (titleIndex > 0) {
    const [title] = ordered.splice(titleIndex, 1);
    if (title) ordered.unshift(title);
  }

  return ordered
    .filter((column) => column.key === 'title' || !config.hidden.includes(column.key))
    .map((column) => ({ ...column, label: config.labels[column.key] ?? column.label }));
}

function cellValue(record: RecordRow, key: string): string {
  if (key === 'title') return record.title;
  return record.fields[key] ?? '';
}

function searchable(record: RecordRow): string {
  return [record.title, record.url, ...Object.values(record.fields)]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

export default function App() {
  const [tabId, setTabId] = useState<number | null>(null);
  const [probe, setProbe] = useState<TabProbeResponse | null>(null);
  const [run, setRun] = useState<Run | null>(null);
  const [records, setRecords] = useState<RecordRow[]>([]);
  const [maxPages, setMaxPages] = useState(3);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [captureApi, setCaptureApi] = useState(false);
  const [incremental, setIncremental] = useState(true);
  const [onlyNew, setOnlyNew] = useState(false);
  const [exporting, setExporting] = useState<ExportFormat | null>(null);
  const [exportNote, setExportNote] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [pickerNote, setPickerNote] = useState<string | null>(null);
  const [launcher, setLauncher] = useState(true);
  const [columnConfig, setColumnConfig] = useState<ColumnConfig>(EMPTY_COLUMN_CONFIG);
  // `null` = urutan asli run (urutan situs), bukan urutan abjad.
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 } | null>(null);
  const [copying, setCopying] = useState<'table' | 'urls' | null>(null);
  const [copyNote, setCopyNote] = useState<string | null>(null);
  const [recent, setRecent] = useState<Run[]>([]);
  const [diagnosis, setDiagnosis] = useState<string | null>(null);
  const [diagnoseNote, setDiagnoseNote] = useState<string | null>(null);
  const [diagnosing, setDiagnosing] = useState(false);
  // Umpan balik singkat: tombol berubah jadi "✓ …" selama 2 detik.
  const [flash, setFlash] = useState<string | null>(null);
  /** Picker bisa dinyalakan dari klik kanan; label tombol ikut keadaannya. */
  const [pickerActive, setPickerActive] = useState(false);

  useEffect(() => {
    if (!flash) return;
    const timer = window.setTimeout(() => setFlash(null), 2_000);
    return () => window.clearTimeout(timer);
  }, [flash]);

  // Catatan (hasil salin/ekspor/picker/diagnosa) hilang sendiri supaya panel
  // tidak menumpuk pesan lama yang sudah tidak berlaku.
  useEffect(() => {
    if (!copyNote && !exportNote && !diagnoseNote && !pickerNote) return;
    const timer = window.setTimeout(() => {
      setCopyNote(null);
      setExportNote(null);
      setDiagnoseNote(null);
      setPickerNote(null);
    }, 6_000);
    return () => window.clearTimeout(timer);
  }, [copyNote, exportNote, diagnoseNote, pickerNote]);

  // `loadLatest` juga dipanggil dari listener window, bukan hanya saat render,
  // jadi nilai filter terbaru dibaca dari ref supaya tidak tertinggal closure.
  const onlyNewRef = useRef(onlyNew);
  useEffect(() => {
    onlyNewRef.current = onlyNew;
  }, [onlyNew]);

  /**
   * Hasil picker disimpan sebagai run, jadi panel harus bisa menampilkan run
   * terakhir walaupun run itu tidak dimulai dari panel.
   */
  async function loadLatest(): Promise<void> {
    const response = await send<Run[]>({ type: 'run:recent' });
    if (!response.ok) return;
    setRecent(response.data);
    const latest = response.data[0];
    if (!latest) return;

    setRun((current) => {
      if (current && ACTIVE_STATUSES.has(current.status)) return current;
      if (current && current.updatedAt > latest.updatedAt) return current;
      return latest;
    });

    const recordsResponse = await send<RecordRow[]>({
      type: 'records:preview',
      runId: latest.id,
      limit: PREVIEW_LIMIT,
      onlyNew: onlyNewRef.current,
    });
    if (recordsResponse.ok) setRecords(recordsResponse.data);
  }

  useEffect(() => {
    void (async () => {
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) {
        setError('Tidak ada tab aktif.');
        return;
      }
      setTabId(tab.id);
      void refreshPickerState(tab.id);
      const response = await send<TabProbeResponse>({ type: 'probe:tab', tabId: tab.id });
      if (response.ok) setProbe(response.data);
      await loadLatest();
    })();
  }, []);

  // Picker di halaman menyimpan run tanpa memberi tahu panel. Saat user kembali
  // ke panel, ambil yang terbaru supaya tombol ekspornya langsung tersedia.
  useEffect(() => {
    const onFocus = () => {
      void loadLatest();
      void refreshPickerState();
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);

  // Setelan kolom disimpan per situs (origin + path), jadi run berikutnya di
  // daftar yang sama langsung memakai nama & urutan yang sudah dirapikan.
  const startUrl = run?.startUrl ?? null;
  useEffect(() => {
    setColumnConfig(EMPTY_COLUMN_CONFIG);
    if (!startUrl) return;
    const key = COLUMNS_KEY_PREFIX + siteKey(startUrl);
    let cancelled = false;
    void browser.storage.local.get(key).then((stored) => {
      if (!cancelled) setColumnConfig(normalizeColumnConfig(stored[key]));
    });
    return () => {
      cancelled = true;
    };
  }, [startUrl]);

  useEffect(() => {
    void browser.storage.local
      .get(LAUNCHER_ENABLED_KEY)
      .then((stored) => setLauncher(launcherEnabledFrom(stored)));
  }, []);

  async function toggleLauncher(next: boolean): Promise<void> {
    setLauncher(next);
    try {
      await browser.storage.local.set({ [LAUNCHER_ENABLED_KEY]: next });
    } catch {
      setError('Setelan tombol melayang gagal disimpan.');
    }
  }

  function persistColumns(next: ColumnConfig): void {
    setColumnConfig(next);
    if (!startUrl) return;
    void browser.storage.local
      .set({ [COLUMNS_KEY_PREFIX + siteKey(startUrl)]: next })
      .catch(() => undefined);
  }

  const runId = run?.id;
  const runStatus = run?.status;

  useEffect(() => {
    if (!runId || !runStatus || !ACTIVE_STATUSES.has(runStatus)) return;

    let cancelled = false;
    const tick = async () => {
      const [runResponse, recordsResponse] = await Promise.all([
        send<RunSnapshot>({ type: 'run:get', runId }),
        send<RecordRow[]>({ type: 'records:preview', runId, limit: PREVIEW_LIMIT, onlyNew }),
      ]);
      if (cancelled) return;
      if (runResponse.ok) {
        setRun(runResponse.data.run);
        if (!recordsResponse.ok) setRecords([]);
      }
      if (recordsResponse.ok) setRecords(recordsResponse.data);
    };

    void tick();
    const timer = setInterval(() => void tick(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [runId, runStatus, onlyNew]);

  async function start() {
    if (tabId === null) return;
    setBusy(true);
    setError(null);
    setRecords([]);
    const response = await send<RunSnapshot>({
      type: 'run:start',
      tabId,
      maxPages,
      captureApi,
      incremental,
    });
    if (response.ok) {
      setRun(response.data.run);
      void refreshRecent();
    } else {
      setError(response.error);
    }
    setBusy(false);
  }

  /**
   * Jalur masuk picker tanpa keyboard shortcut: panel sudah terbuka saat user
   * sedang menelusuri daftar, jadi satu klik di sini lebih cepat daripada
   * pindah ke popup.
   */
  /**
   * Status picker dibaca dari tab, bukan disimpulkan dari klik terakhir di
   * panel: picker sering dinyalakan lewat klik kanan atau tombol melayang.
   */
  async function refreshPickerState(tab?: number | null): Promise<void> {
    let target = tab ?? null;
    if (target === null) {
      const [active] = await browser.tabs.query({ active: true, currentWindow: true });
      target = active?.id ?? null;
    }
    if (target === null) return;

    try {
      const state = (await browser.tabs.sendMessage(target, {
        type: 'scrapergod:picker-state',
      })) as { active?: boolean } | undefined;
      setPickerActive(state?.active === true);
    } catch {
      setPickerActive(false);
    }
  }

  async function startPicker() {
    if (tabId === null) return;
    setPickerNote(null);
    try {
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
      const target = tab?.id ?? tabId;
      const response = (await browser.tabs.sendMessage(target, {
        type: 'toggle-picker',
      })) as { active?: boolean } | undefined;
      setPickerActive(response?.active === true);
      setPickerNote(
        response?.active
          ? 'Picker aktif di halaman. Arahkan kursor ke daftar.'
          : 'Picker dimatikan.',
      );
    } catch {
      setError('Tab ini tidak bisa dipakai picker (chrome://, Web Store, atau PDF).');
    }
  }

  async function stop() {
    if (!run) return;
    setBusy(true);
    const response = await send<RunSnapshot>({ type: 'run:stop', runId: run.id });
    if (response.ok) setRun(response.data.run);
    else setError(response.error);
    setBusy(false);
  }

  async function resume() {
    if (!run) return;
    setBusy(true);
    setError(null);
    const response = await send<RunSnapshot>({ type: 'run:resume', runId: run.id });
    if (response.ok) setRun(response.data.run);
    else setError(response.error);
    setBusy(false);
  }

  async function exportRun(format: ExportFormat) {
    if (!run) return;
    setExporting(format);
    setExportNote(null);
    const response = await send<ExportFile>({
      type: 'run:export',
      runId: run.id,
      format,
      onlyNew,
    });
    if (response.ok) {
      saveFile(response.data);
      setExportNote(`${response.data.count} baris → ${response.data.filename} (tersimpan di folder Unduhan)`);
      setFlash(format);
    } else {
      setError(response.error);
    }
    setExporting(null);
  }

  async function refreshRecent(): Promise<void> {
    const response = await send<Run[]>({ type: 'run:recent' });
    if (response.ok) setRecent(response.data);
  }

  /**
   * Salin memakai SELURUH record run (bukan 50 baris pratinjau), tapi tetap
   * mengikuti pencarian, sortir, dan kolom yang sedang terlihat. Jadi hasil
   * tempelnya sama dengan tabel di layar — termasuk kolom yang sudah di-rename
   * dan kolom yang disembunyikan.
   */
  async function copyRows(kind: 'table' | 'urls'): Promise<void> {
    if (!run) return;
    setCopying(kind);
    setCopyNote(null);
    setError(null);

    const response = await send<RecordRow[]>({
      type: 'records:all',
      runId: run.id,
      onlyNew,
    });
    if (!response.ok) {
      setError(response.error);
      setCopying(null);
      return;
    }

    const query = search.trim().toLowerCase();
    const matched = query
      ? response.data.filter((record) => searchable(record).includes(query))
      : response.data;
    const ordered = sort
      ? [...matched].sort(
          (a, b) =>
            cellValue(a, sort.key).localeCompare(cellValue(b, sort.key), 'id') * sort.dir,
        )
      : matched;

    try {
      if (kind === 'urls') {
        const urls = ordered.map((record) => record.url).filter(Boolean);
        if (urls.length === 0) throw new Error('Tidak ada URL di hasil ini.');
        await writeClipboard(urls.join('\n'));
        setCopyNote(`${urls.length} URL tersalin. Tempel di notepad atau kolom spreadsheet.`);
        setFlash(kind);
      } else {
        if (ordered.length === 0) throw new Error('Tidak ada baris untuk disalin.');
        const copyColumns = [...columns, SOURCE_COLUMN];
        await writeClipboard(toTsv(ordered, copyColumns), toHtmlTable(ordered, copyColumns));
        setCopyNote(
          `${ordered.length} baris × ${copyColumns.length} kolom tersalin. Tempel ke Sheets, Excel, atau Docs.`,
        );
        setFlash(kind);
      }
    } catch (copyError) {
      setError(copyError instanceof Error ? copyError.message : String(copyError));
    }
    setCopying(null);
  }

  async function openRun(entry: Run): Promise<void> {
    setError(null);
    setExportNote(null);
    setCopyNote(null);
    setSearch('');
    setSort(null);
    setRun(entry);
    const response = await send<RecordRow[]>({
      type: 'records:preview',
      runId: entry.id,
      limit: PREVIEW_LIMIT,
      onlyNew: onlyNewRef.current,
    });
    setRecords(response.ok ? response.data : []);
  }

  async function removeRun(entry: Run): Promise<void> {
    const label = `${hostLabel(entry.startUrl)} · ${entry.checkpoint.itemCount} item`;
    if (!window.confirm(`Hapus run ${label}? Riwayat "sudah pernah dilihat" tetap disimpan.`)) {
      return;
    }
    const response = await send<Run[]>({ type: 'run:delete', runId: entry.id });
    if (!response.ok) {
      setError(response.error);
      return;
    }
    setRecent(response.data);
    if (run?.id === entry.id) {
      setRun(null);
      setRecords([]);
      setCopyNote(null);
      setExportNote(null);
    }
  }

  /**
   * Diagnosa pagination: satu klik, satu laporan. Isinya fakta dari tab
   * (kandidat API, tombol yang dilewati, link berikutnya, sisa scroll) dan
   * kesimpulan jalur mana yang akan dipakai.
   */
  async function diagnosePagination(): Promise<void> {
    if (tabId === null) return;
    setDiagnosing(true);
    setDiagnosis(null);
    setDiagnoseNote(null);
    setError(null);

    try {
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
      const target = tab?.id ?? tabId;
      const facts = (await browser.tabs.sendMessage(target, {
        type: 'scrapergod:diagnose',
      })) as PaginationFacts | undefined;
      if (!facts) throw new Error('halaman tidak merespons');
      setDiagnosis(buildDiagnosis(facts));
    } catch (error) {
      setError(
        `Diagnosa gagal: ${error instanceof Error ? error.message : String(error)}. Muat ulang halaman lalu coba lagi.`,
      );
    }
    setDiagnosing(false);
  }

  const isActive = run !== null && ACTIVE_STATUSES.has(run.status);
  const sourceLabel = probe?.best
    ? `${probe.best.source} · ${probe.best.itemCount} item`
    : 'tidak terdeteksi';

  const autoColumns = columnsOf(records);
  const columns = applyColumnConfig(autoColumns, columnConfig);
  // Panel pengaturan menampilkan semua kolom, termasuk yang sedang disembunyikan.
  const configRows = applyColumnConfig(autoColumns, { ...columnConfig, hidden: [] });
  const allKeys = autoColumns.map((column) => column.key);

  function editColumns(mutate: (draft: ColumnConfig) => void): void {
    const draft: ColumnConfig = {
      order: [...columnConfig.order],
      hidden: [...columnConfig.hidden],
      labels: { ...columnConfig.labels },
    };
    for (const key of allKeys) if (!draft.order.includes(key)) draft.order.push(key);
    mutate(draft);
    persistColumns(draft);
  }

  function moveColumn(key: string, delta: number): void {
    if (key === 'title') return;
    editColumns((draft) => {
      const index = draft.order.indexOf(key);
      const target = index + delta;
      // Index 0 dikunci untuk judul.
      if (index < 0 || target <= 0 || target >= draft.order.length) return;
      [draft.order[index], draft.order[target]] = [draft.order[target]!, draft.order[index]!];
    });
  }

  function toggleColumn(key: string): void {
    if (key === 'title') return;
    editColumns((draft) => {
      draft.hidden = draft.hidden.includes(key)
        ? draft.hidden.filter((entry) => entry !== key)
        : [...draft.hidden, key];
    });
  }

  function renameColumn(key: string, label: string): void {
    editColumns((draft) => {
      draft.labels[key] = label;
    });
  }

  const query = search.trim().toLowerCase();
  const filtered = query ? records.filter((r) => searchable(r).includes(query)) : records;
  const shown = sort
    ? [...filtered].sort(
        (a, b) =>
          cellValue(a, sort.key).localeCompare(cellValue(b, sort.key), 'id') * sort.dir,
      )
    : filtered;

  function toggleSort(key: string): void {
    setSort((current) =>
      current && current.key === key
        ? { key, dir: current.dir === 1 ? -1 : 1 }
        : { key, dir: 1 },
    );
  }

  return (
    <main className="panel">
      <header className="panel-head">
        <div>
          <h1>{PRODUCT_NAME}</h1>
          <p className="sub">Tunjuk daftar. Ambil. Simpan.</p>
        </div>
        <span
          className={`chip ${isActive ? 'chip-live' : run?.status === 'paused' ? 'chip-warn' : run?.status === 'failed' ? 'chip-bad' : run?.status === 'done' ? 'chip-ok' : ''}`}
        >
          {statusLabel(run)}
        </span>
      </header>

      <section className="card">
        <div className="row">
          <span className="label">Sumber</span>
          <span className="value">{sourceLabel}</span>
        </div>
        <div className="row">
          <span className="label">Halaman</span>
          <input
            type="number"
            min={1}
            max={200}
            value={maxPages}
            disabled={isActive}
            onChange={(event) => setMaxPages(Number(event.target.value) || 1)}
          />
        </div>
        <label className="row check">
          <input
            type="checkbox"
            checked={captureApi}
            disabled={isActive}
            onChange={(event) => setCaptureApi(event.target.checked)}
          />
          <span className="label">Rekam API situs (muat ulang halaman sekali)</span>
        </label>
        <label className="row check">
          <input
            type="checkbox"
            checked={incremental}
            disabled={isActive}
            onChange={(event) => setIncremental(event.target.checked)}
          />
          <span className="label">Berhenti kalau halaman isinya sudah dikenal</span>
        </label>
        <label className="row check">
          <input
            type="checkbox"
            checked={launcher}
            onChange={(event) => void toggleLauncher(event.target.checked)}
          />
          <span className="label">
            Tombol melayang di halaman (matikan lewat × pada ikonnya)
          </span>
        </label>
        {run?.api && (
          <div className="row">
            <span className="label">API</span>
            <span className="value">
              {run.api.method}
              {run.api.cursorParam
                ? ` · cursor ${run.api.cursorParam}`
                : ` · ${run.api.pageParam ?? run.api.bodyPageParam}`}
              {' · '}
              {run.api.arrayPath || '$'}
              {run.api.pageSize ? ` · ${run.api.pageSize}/halaman` : ''}
            </span>
          </div>
        )}

        <div className="actions">
          <button className="primary" onClick={start} disabled={busy || isActive || tabId === null}>
            {busy && !isActive ? 'Memulai…' : 'Mulai ambil'}
          </button>
          <button
            className={pickerActive ? 'ok' : undefined}
            onClick={() => void startPicker()}
            disabled={busy || tabId === null}
            title={
              pickerActive
                ? 'Picker sedang aktif — klik untuk mematikan'
                : 'Arahkan kursor ke daftar, Enter untuk Ambil'
            }
          >
            {pickerActive ? 'Picker aktif · matikan' : 'Picker di halaman'}
          </button>
          <button
            onClick={() => void diagnosePagination()}
            disabled={diagnosing || tabId === null}
            title="Kenapa pagination tidak lanjut?"
          >
            {diagnosing ? 'Memeriksa…' : 'Diagnosa pagination'}
          </button>
          <button onClick={stop} disabled={busy || !isActive}>
            Stop
          </button>
          {run?.status === 'paused' && (
            <button onClick={resume} disabled={busy}>
              Lanjutkan
            </button>
          )}
        </div>

        {diagnosis && (
          <div className="diagnose">
            <pre className="diagnosis">{diagnosis}</pre>
            <button
              type="button"
              className={flash === 'diagnose' ? 'ok' : undefined}
              onClick={() =>
                void writeClipboard(diagnosis).then(
                  () => {
                    setDiagnoseNote('Laporan diagnosa tersalin ke klipboard.');
                    setFlash('diagnose');
                  },
                  () => setError('Gagal menyalin laporan.'),
                )
              }
            >
              {flash === 'diagnose' ? '✓ Tersalin' : 'Salin laporan'}
            </button>
            {diagnoseNote && <p className="note">{diagnoseNote}</p>}
          </div>
        )}
        {error && (
          <div className="error-bar" role="alert">
            <p>{error}</p>
            <button type="button" onClick={() => setError(null)} aria-label="Tutup pesan">
              ✕
            </button>
          </div>
        )}
        {pickerNote && (
          <p className="note" role="status">
            {pickerNote}
          </p>
        )}
        {run?.lastError && <p className="error">{run.lastError}</p>}
      </section>

      {run && (
        <section className="card">
          <div className="progress">
            <div>
              <span className="big">{run.checkpoint.itemCount}</span>
              <span className="label"> item</span>
              {records.some((record) => record.isNew) && (
                <span className="count">
                  {' '}
                  · {records.filter((record) => record.isNew).length} baru
                </span>
              )}
            </div>
            <div>
              <span className="big">{run.checkpoint.page}</span>
              <span className="label">/{run.maxPages} halaman</span>
            </div>
          </div>
          <div className="bar">
            <div
              className="bar-fill"
              style={{
                width: `${Math.min(100, (run.checkpoint.page / run.maxPages) * 100)}%`,
              }}
            />
          </div>
          {run.stopReason && STOP_HINT[run.stopReason] && (
            <p className="note">{STOP_HINT[run.stopReason]}</p>
          )}
          {run.lastError && <p className="error">Terakhir: {run.lastError}</p>}

          <div className="actions">
            <button
              className={`primary${flash === 'table' ? ' ok' : ''}`}
              onClick={() => void copyRows('table')}
              disabled={copying !== null || run.checkpoint.itemCount === 0}
              title="Tempel ke Sheets, Excel, atau Docs"
            >
              {copying === 'table' ? 'Menyalin…' : flash === 'table' ? '✓ Tersalin' : 'Salin tabel'}
            </button>
            <button
              className={flash === 'urls' ? 'ok' : undefined}
              onClick={() => void copyRows('urls')}
              disabled={copying !== null || run.checkpoint.itemCount === 0}
              title="Daftar URL, satu per baris"
            >
              {copying === 'urls' ? 'Menyalin…' : flash === 'urls' ? '✓ Tersalin' : 'Salin URL'}
            </button>
            <button
              className={flash === 'csv' ? 'ok' : undefined}
              onClick={() => void exportRun('csv')}
              disabled={exporting !== null || run.checkpoint.itemCount === 0}
            >
              {exporting === 'csv' ? 'Menyiapkan…' : flash === 'csv' ? '✓ CSV' : 'Ekspor CSV'}
            </button>
            <button
              className={flash === 'json' ? 'ok' : undefined}
              onClick={() => void exportRun('json')}
              disabled={exporting !== null || run.checkpoint.itemCount === 0}
            >
              {exporting === 'json' ? 'Menyiapkan…' : flash === 'json' ? '✓ JSON' : 'Ekspor JSON'}
            </button>
          </div>
          {copyNote && (
            <p className="note" role="status">
              {copyNote}
            </p>
          )}
          {exportNote && (
            <p className="note" role="status">
              {exportNote}
            </p>
          )}

          {recent.length > 1 && (
            <details className="history">
              <summary>Riwayat ambil ({recent.length})</summary>
              <div className="history-list">
                {recent.map((entry) => (
                  <div
                    className={`history-row${entry.id === run.id ? ' current' : ''}`}
                    key={entry.id}
                  >
                    <button
                      type="button"
                      className="history-open"
                      onClick={() => void openRun(entry)}
                      title="Buka hasil ini"
                    >
                      <span className="history-site">{hostLabel(entry.startUrl)}</span>
                      <span className="history-meta">
                        {entry.checkpoint.itemCount} item · {when(entry.updatedAt)} ·{' '}
                        {statusLabel(entry)}
                      </span>
                    </button>
                    <button
                      type="button"
                      className="history-del"
                      onClick={() => void removeRun(entry)}
                      disabled={ACTIVE_STATUSES.has(entry.status)}
                      aria-label={`Hapus run ${hostLabel(entry.startUrl)}`}
                      title="Hapus run ini"
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            </details>
          )}
        </section>
      )}

      <section className="card grow">
        <div className="row between">
          <span className="label">
            Pratinjau
            {records.length > 0 && (
              <span className="count">
                {' '}
                {shown.length}/{records.length}
              </span>
            )}
          </span>
          <div className="row check">
            <input
              type="checkbox"
              checked={onlyNew}
              onChange={(event) => setOnlyNew(event.target.checked)}
            />
            <span className="label">hanya yang baru</span>
          </div>
        </div>

        {autoColumns.length > 1 && (
          <details className="col-config">
            <summary>Atur kolom</summary>
            <div className="col-list">
              {configRows.map((column, index) => (
                <div className="col-row" key={column.key}>
                  <input
                    className="col-name"
                    value={column.label}
                    onChange={(event) => renameColumn(column.key, event.target.value)}
                    aria-label={`Nama kolom ${column.label}`}
                  />
                  <label className="row check" title="Tampilkan kolom ini">
                    <input
                      type="checkbox"
                      checked={!columnConfig.hidden.includes(column.key)}
                      disabled={column.key === 'title'}
                      onChange={() => toggleColumn(column.key)}
                    />
                  </label>
                  <button
                    type="button"
                    onClick={() => moveColumn(column.key, -1)}
                    disabled={column.key === 'title' || index === 0}
                    aria-label={`Naikkan ${column.label}`}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    onClick={() => moveColumn(column.key, 1)}
                    disabled={column.key === 'title'}
                    aria-label={`Turunkan ${column.label}`}
                  >
                    ↓
                  </button>
                </div>
              ))}
            </div>
            <button type="button" onClick={() => persistColumns(EMPTY_COLUMN_CONFIG)}>
              Kembalikan nama &amp; urutan
            </button>
          </details>
        )}

        <input
          className="search"
          type="search"
          placeholder="Cari di semua kolom…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />

        {records.length === 0 ? (
          <p className="empty">
            {onlyNew && run ? (
              'Tidak ada item baru di run ini. Matikan "hanya yang baru" untuk melihat semuanya.'
            ) : (
              <>
                Belum ada data. Tekan <b>Mulai ambil</b> di sini, atau <b>Picker di
                halaman</b> lalu <b>Ambil</b> untuk menyimpan satu halaman. Bisa juga
                klik kanan di halaman → <b>Mulai picker</b>.
              </>
            )}
          </p>
        ) : shown.length === 0 ? (
          <p className="empty">Tidak ada baris yang cocok dengan pencarian.</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  {columns.map((column) => (
                    <th key={column.key}>
                      <button className="th" onClick={() => toggleSort(column.key)}>
                        {column.label}
                        {sort?.key === column.key ? (sort.dir === 1 ? ' ↑' : ' ↓') : ''}
                      </button>
                    </th>
                  ))}
                  <th>Sumber</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((record) => (
                  <tr key={record.id}>
                    {columns.map((column) =>
                      column.key === 'title' ? (
                        <td className="c-title" key={column.key}>
                          {record.url ? (
                            <a href={record.url} target="_blank" rel="noreferrer">
                              {record.title || '(tanpa judul)'}
                            </a>
                          ) : (
                            record.title || '(tanpa judul)'
                          )}
                          {record.isNew && <span className="badge">baru</span>}
                        </td>
                      ) : (
                        <td key={column.key}>{cellValue(record, column.key)}</td>
                      ),
                    )}
                    <td className="c-src">{record.provenance.source}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {probe && probe.notes.length > 0 && (
        <footer className="notes">
          {probe.notes.map((note) => (
            <p key={note}>{note}</p>
          ))}
        </footer>
      )}
    </main>
  );
}
