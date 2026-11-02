# CONTEXT — scraperGOD

> **Baca ini dulu, sekali, dari atas ke bawah.** Dokumen ini ditulis untuk agen/AI
> yang **belum tahu apa pun** soal proyek ini. Isinya keadaan nyata repo per
> 1 November 2026: apa yang sudah jadi, apa yang masih rencana, dan **kenapa**
> setiap keputusan diambil begitu.
>
> Aturan: kalau ada yang bertentangan dengan dokumen lain, **dokumen ini yang
> benar** (lihat §2 soal dokumen lama).

---

## 1. Satu paragraf: ini apa

Ekstensi Chrome (Manifest V3) bernama **scraperGOD**. Fungsinya menarik daftar
item dari halaman web — fokus awal situs lowongan kerja — **termasuk menembus
pagination**, lalu menyimpannya ke database lokal dan mengekspornya ke CSV/JSON.

Ada dua cara pakai:

1. **Picker manual.** User menekan `Alt+Shift+P` (atau tombol di popup), lalu
   mengarahkan kursor ke sebuah daftar. Ekstensi menyorot **semua** item yang
   dianggap satu daftar, HUD menampilkan jumlah + preview, dan satu tekan
   `Enter` menyimpan daftar itu sebagai run di database.
2. **Run otomatis.** User membuka side panel dan menekan "Mulai ambil". Ekstensi
   memilih sumber data terbaik (JSON jaringan → JSON tersemat → DOM), mengambil
   halaman 1, mengikuti halaman berikutnya, menyimpan tiap item, dan menyediakan
   ekspor.

Yang membuatnya bukan sekadar "scraper biasa" ada tiga, dan hanya yang pertama
sudah benar-benar ada di kode:

| Taruhan | Status |
| --- | --- |
| Ambil dari **sumber terbaik** (JSON jaringan situs > JSON tersemat > DOM), dengan alasan yang ditampilkan | ✅ sudah jalan |
| Tembus **plafon hasil** lewat Crawl Planner (pecah query jadi sub-query) | ❌ belum ada |
| **Autopilot**: data menumpuk saat user browsing | ❌ belum ada |

Prinsip yang tidak boleh dilanggar: **local-first**. Tidak ada backend, tidak ada
telemetry, tidak ada satu byte pun yang keluar dari browser kecuali user menekan
ekspor.

---

## 2. Dokumen lain: mana yang masih boleh dipercaya

| File | Isi | Status |
| --- | --- | --- |
| `CONTEXT.md` | **ini** — konteks + arsitektur + kondisi nyata | ✅ terkini |
| `HANDOFF.md` | ringkasan repo untuk dibagikan ke AI lain (lebih ringkas dari ini) | ✅ terkini, sebagian terpotong/duplikat dari dokumen ini |
| `AUDIT.md` | audit bug, perbaikan, batasan, referensi riset | ✅ terkini |
| `DRD.md` | requirement produk detail (visi penuh) | ⚠️ **visi**, banyak yang belum dibangun |
| `PLAN.md` | fase kerja & estimasi | ⚠️ **rencana**, urutannya sudah banyak berubah |
| `README.md` | template WXT | ❌ belum dipakai, abaikan |

**Yang sudah basi di `DRD.md`/`PLAN.md`** — jangan diikuti:

- Nama produk lama **"ScrapeKit"** (nama internal sekarang `scrapergod`).
- **Tailwind v4** dan **Papaparse** disebut di stack. Kenyataannya **tidak
  dipakai**: CSS ditulis manual per entrypoint, CSV ditulis sendiri
  (`src/core/export/csv.ts`). Runtime dependency cuma 4: dexie, react,
  react-dom, zod.
- "Export lewat offscreen document" — tidak dipakai. Panel membuat Blob sendiri.
- `optional_host_permissions: ["<all_urls>"]` dan permission `scripting`/
  `downloads` — tidak ada di manifest sekarang.
- Adapter per situs, Crawl Planner, Autopilot, LLM assist, normalisasi gaji —
  belum ada sama sekali di kode.

---

## 3. Menjalankan & memverifikasi

Windows + bash (Git Bash). Perintah pendek, jangan diganti.

```bash
npm run dev       # wxt dev, HMR untuk popup & sidepanel
npm test          # vitest run           → 7 file, 95 test
npm run compile   # tsc --noEmit
npm run build     # wxt build            → .output/chrome-mv3
npm run zip       # wxt zip (belum dipakai, belum siap publish)
```

Memuat di Chrome: `chrome://extensions` → Developer mode → **Load unpacked** →
pilih `.output/chrome-mv3`.

> **Penting:** Chrome 156 stable sudah menghapus `--load-extension` dari command
> line. Jadi memuat ekstensi secara otomatis lewat CDP/Playwright **tidak bisa**.
> Semua pengujian end-to-end harus manual, dan **belum pernah ada yang
> melakukannya** (lihat §13).

Hasil verifikasi terakhir (1 Nov 2026):

```
npx tsc --noEmit   → bersih
npx vitest run     → 7 file, 95 test lulus
npx wxt build      → exit 0, ~592 kB
manifest: name/short_name "scraperGOD" (ikut nama folder), ikon 16–128,
          permissions: storage, activeTab, alarms, sidePanel,
          side_panel.default_path: sidepanel.html,
          content_scripts: content.js (document_idle) + main-world.js (MAIN, document_start)
```

Catatan lingkungan: `npx vitest run` kadang gagal dengan
`ERR_IPC_CHANNEL_CLOSED` di mesin ini (crash worker tinypool, bukan test).
Kalau itu muncul, ulangi dengan
`npx vitest run --pool=threads --poolOptions.threads.singleThread` — itulah yang
dipakai untuk angka 85 di atas.

---

## 4. Pengalaman pemakaian (detail yang sudah ada di kode)

### 4.1 Picker (`Alt+Shift+P`)

- Kursor jadi `crosshair`, semua klik halaman diblokir (kecuali klik di UI
  sendiri, dikenali lewat `composedPath()` + atribut `data-scrapergod-ui`).
- Hover → deteksi set item, debounce 120 ms. Semua item disorot, item di bawah
  kursor diberi highlight berbeda.
- HUD: jumlah item, level `2/5`, preview 2 baris pertama, dua tombol (Ambil /
  Copy).
- `[` dan `]` pindah **level** inference (container lebih luar / lebih dalam).
- `Enter` = Ambil (simpan sebagai run), `Shift+Enter` = copy TSV ke clipboard,
  `Esc` = keluar.
- Clipboard: `navigator.clipboard.writeText` dulu, fallback
  `document.execCommand('copy')` untuk halaman non-fokus/insecure.
- "Ambil" memanggil `pick:save`; toast jujur menyebut jumlah yang **benar-benar**
  tersimpan (`X dari Y item tersimpan (URL ganda digabung)`), lalu picker mati
  sendiri setelah 700 ms.

### 4.2 Side panel

- Saat dibuka: query tab aktif → `probe:tab` → tampilkan `sumber · N item`,
  lalu `run:recent` untuk memuat run terakhir (supaya hasil picker langsung bisa
  diekspor).
- Kontrol: jumlah halaman (1–200), centang **"Rekam API situs (muat ulang
  halaman sekali)"**, centang **"Berhenti kalau halaman isinya sudah dikenal"**
  (default aktif), tombol Mulai ambil / Stop / Lanjutkan (hanya saat `paused`).
- Progres: `item` dan `page/maxPages` + bar; polling 800 ms selama status
  `queued`/`running`.
- Pratinjau 20 record terakhir (judul, badge `baru`, sumber provenance, field,
  URL), dengan centang **"hanya yang baru"** yang ikut berlaku saat ekspor.
- Ekspor CSV/JSON: SW membangun isi, **panel** yang membuat Blob + `<a download>`
  (SW tidak punya `URL.createObjectURL`; tidak perlu permission `downloads`).
- `window.focus` memicu `run:recent` lagi, menangkap run yang dibuat picker.

### 4.3 Popup

Tombol "Mulai picker di tab ini" (kirim `toggle-picker` ke tab aktif) dan
"Buka panel pengambilan" (`sidePanel.open`). Pesan error spesifik untuk halaman
`chrome://`, Web Store, dan PDF.

---

## 5. Arsitektur runtime: lima konteks, dan apa yang boleh ada di masing-masing

```
┌── service worker (entrypoints/background.ts) ──────────────┐
│ pemilik IndexedDB, run engine, navigasi tab, alarm, ekspor  │
└───────┬───────────────────────────────┬────────────────────┘
        │ tabs.sendMessage              │ runtime.sendMessage
        ▼                               ▼
┌── content (ISOLATED) ────────┐   ┌── sidepanel / popup ──┐
│ picker, probe DOM, snapshot, │   │ UI React              │
│ jembatan ke MAIN world       │   └───────────────────────┘
└───────┬──────────────────────┘
        │ window.postMessage
        ▼
┌── content (MAIN) ──────────────────────────────────────────┐
│ hook fetch/XHR, buffer capture, replay fetch di konteks    │
│ halaman (cookie & CORS milik situs)                        │
└────────────────────────────────────────────────────────────┘
```

Aturan keras:

- **Semua baca-tulis DB lewat SW.** IndexedDB dari content script masuk ke origin
  *situs*, bukan origin ekstensi.
- **`src/core/**` harus murni**: tanpa `chrome.*`, tanpa `window`, supaya bisa
  dites di jsdom/Node.
- Parser HTML/JSON jalan di content script (punya DOM). SW hanya orkestrasi.
- Hook jaringan **default mati** dan hanya menyala per tab setelah diminta.

---

## 6. Alur data

### 6.1 Probe: memilih sumber

`probeDocument(doc, baseUrl, networkSources)` (`src/core/probe/index.ts`)
menghasilkan kandidat berskor:

| Sumber | Skor | Catatan |
| --- | --- | --- |
| `network` | `120 + min(items,40) + field×2` | dari capture JSON situs |
| `embedded` | `100 + min(items,40) + field×2` | JSON-LD, `__NEXT_DATA__`, `__NUXT_DATA__`, `<script type="application/json">` |
| `dom` | `40 + min(items,20)` | heuristik daftar berulang di DOM |

Kandidat teratas = `best`. `notes` selalu menjelaskan **kenapa** sumber itu
dipakai (dan kenapa kandidat lain tidak). Tidak pernah diam-diam memilih.

### 6.2 Rekam API (opsional, satu kali reload)

```
panel (captureApi=true) → SW run:start
  → content: probe (belum ada capture)
  → SW: armNet → tabs.reload(tab)   ← reload WAJIB: SPA sudah fetch sebelum user klik
  → MAIN: hook menyala (arm disimpan di sessionStorage), capture masuk buffer
  → SW polling 600 ms: probe → api != null? → lanjut ; sesudah halaman siap + 4 s → menyerah
  → SW: disarmNet (selalu, di finally)
```

Kalau tetap tidak ada API, SW melempar error yang menyuruh mematikan centang
"Rekam API" — **tidak** diam-diam jatuh ke DOM.

### 6.3 Run engine

```
createRun(status='queued') → pump(runId, deps) loop:
  1. kalau status terminal → keluar
  2. kalau lease dipegang worker lain & belum kedaluwarsa → keluar
  3. itemCount >= maxItems → done/max-items
  4. fetchPage(url, run, { expand })   ← deps: API replay ATAU snapshot tab
       expand=true → halaman yang SAMA diminta bertambah (muat lebih/scroll)
       gagal → status='paused', stopReason='error', lastError=pesan
  5. baca ulang run dari DB (user bisa Stop saat fetch jalan)
  6. lihat `seen` (lintas-run, satu bulkGet per halaman) → item mana yang baru
  7. buildRecords: urlKey → buang yang sudah tersimpan (knownKeys), hormati
     maxItems, `isNew` = belum ada di `seen`
     fingerprint = SEMUA kunci halaman (walau tidak disimpan)
  8. fingerprint == lastFingerprint (page>0, bukan ekspansi) → done/duplicate-page
  9. hitung nextUrl (absolut), nextExpand, emptyPages, seenPages, stopReason
 10. commitPage(run', records, seen')  ← SATU transaksi Dexie
 11. kalau stopReason → keluar ; kalau delayMs>0 → sleep(delayMs) LALU ulang
```

Stop reason yang mungkin: `next-missing`, `max-pages`, `max-items`,
`duplicate-page`, `no-new-items`, `all-known`, `expand-timeout`,
`expand-blocked`, `picked`, `stopped`, `error`.

### 6.4 Pagination lewat API (jalur utama untuk SPA)

- `analyzeCapture()` (`src/core/source/network.ts`) memeriksa capture: URL
  absolut (penting: `/api/jobs?page=1` harus jadi absolut), tidak terpotong,
  status < 400, **method GET**, body JSON utuh, ada array of objects (≥3 item,
  ≥60% objek), ada judul/URL yang dikenali, dan pagination terbaca.
- **POST/GraphQL didukung** kalau body request terekam: `bodyTemplate` disimpan
  apa adanya, `bodyPageParam` menunjuk field halaman (`page`, `offset`, atau
  `variables.page`). Header tidak pernah disimpan—hanya `contentType`.
- **Cursor didukung**: `cursorParam`/`cursorKind` menyimpan di mana cursor
  dikirim, dan nilai terakhirnya ada di `checkpoint.cursor` (bertahan saat SW
  mati). Cursor yang hilang → `paused` dengan pesan jelas, bukan menebak.
- Yang masih **ditolak dengan alasan jelas**: PUT/PATCH, body terpotong, body
  non-JSON, tanpa parameter halaman/cursor, dan rencana yang halaman 2-nya
  identik dengan halaman 1 (dicek sebelum run dimulai, alasannya masuk notes).
- 429/503 diulang dengan backoff 1,5 s lalu 4 s; 403/401/captcha/login → run
  berhenti (`paused`) dengan `lastError`, tidak dipaksa.
- `ApiPlan` disimpan di `run.api`, jadi setelah SW mati tidak perlu menebak ulang.
- `apiRequest(api, pageIndex, cursor)` membangun URL + body + content-type;
  parameter lain (filter user!) dibiarkan apa adanya.
- `hasMorePages()` berhenti kalau `received === 0`, atau `received < pageSize`,
  atau `(pageIndex+1)*pageSize >= total`.
- Replay dijalankan **di MAIN world** (`fetch` GET, `credentials: 'include'`),
  bukan di SW: cookie, header, dan CORS sama dengan milik situs, tanpa
  `host_permissions` tambahan.

### 6.5 Picker → run

`pick:save` → `savePickedRun()` → run `done` dengan `stopReason='picked'`,
`checkpoint.page=1`, record lewat jalur `buildRecords` yang sama. Tidak ada
bentuk data kedua yang harus dirawat.

### 6.6 Ekspor

`run:export {format}` → SW ambil run + semua record → `buildExport()`:

- CSV: RFC 4180, BOM UTF-8 (Excel tidak merusak karakter), CRLF, kolom tetap
  `url,title,sumber` + gabungan field urut kemunculan pertama.
- JSON: record lengkap (`raw` + `provenance`) + `run` (termasuk `stopReason`).
- Batas 32 MB (`MAX_EXPORT_BYTES`), gagal dengan pesan jelas, bukan senyap.
- Nama file dari host + timestamp.
- `onlyNew: true` menyaring record yang `isNew` — dipakai tombol "hanya yang baru".

### 6.7 Dedupe lintas-run & berhenti cepat

`seen` adalah tabel identitas: `id` = `urlKey`, ditambah `siteKey` (origin + path
tanpa query), `firstSeenAt`, `lastSeenAt`, `lastRunId`. Tidak menyalin record,
jadi ukurannya satu baris kecil per item selamanya.

```
run pertama  → semua item isNew=true, `seen` terisi (firstSeenAt = waktu ambil)
run kedua    → item lama tampil tanpa badge (isNew=false), firstSeenAt TIDAK bergeser
halaman penuh yang semuanya sudah dikenal, mulai halaman ke-2 → stopReason='all-known'
```

Halaman **pertama** sengaja tidak dihitung untuk berhenti cepat: satu halaman belum
membuktikan situs mengurutkan dari yang terbaru, dan hasil picker ("Ambil") juga
menandai item sebagai dikenal — berhenti di halaman 1 akan melewatkan sisa daftar
hanya karena user pernah menekan Ambil di halaman itu. Konsekuensinya run ulang
di daftar 50 halaman tetap memakan 2 fetch, bukan 50.

`seen` ditulis di transaksi yang sama dengan record dan checkpoint (`commitPage`),
jadi SW yang mati tepat setelah commit tidak membuat item dilaporkan "baru" dua kali.

### 6.8 Muat lebih banyak & infinite scroll

Banyak daftar modern tidak punya link "berikutnya" dan tidak punya nomor halaman.
Kalau `findNextUrl` kosong tapi halaman masih bisa bertambah, engine **mengambil
ulang halaman yang sama** dengan `expand: true` — bukan mesin pagination kedua:

```
fetchPage(url, run, { expand })          ← SW → tabs.sendMessage(fetch-page, expand)
  content: expandOnce()
    ada tombol "muat lebih banyak" → klik
    tidak ada tombol               → scroll ke bawah (memancing infinite scroll)
    tunggu sampai daftar berubah (poll 250 ms, batas 4 dtk)
  → snapshot penuh lagi (items, canExpand)
engine: knownKeys + `seen` menyaring item baru, persis seperti halaman biasa
```

Pemicu dideteksi oleh `findMoreButton()` + `canScrollFurther()` di
`src/core/probe/more.ts` (murni, bisa dites). Frasa "lihat selengkapnya" **tidak**
dianggap pemicu karena biasanya ada di dalam kartu dan akan membuka halaman detail.

Penghentinya memakai yang sudah ada: tidak ada pemicu lagi → `next-missing`;
tiga ekspansi tanpa item baru → `no-new-items`; isinya sudah dikenal → `all-known`;
dan `maxPages` tetap berlaku (ekspansi dihitung satu halaman).

Pemicu **tidak** diklik membabi buta. `findMoreButton` menolak (semua ada
test-nya): tombol `disabled`/`aria-disabled`/berkelas loading, tombol di dalam
`<form>` atau yang menunjuk form lain (`form="..."`), teks berbahaya (lamar,
apply, kirim, hapus, bayar, masuk, daftar, …), elemen tanpa ukuran
(`display:none`, `visibility:hidden`, `opacity:0`, `pointer-events:none`,
`aria-hidden`, rect 0×0), dan link yang akan berpindah dokumen. Tombol yang lolos
digulir ke tengah layar dulu (`scrollIntoView`) baru diklik, karena sebagian situs
mengaktifkannya lewat `IntersectionObserver`.

**Jalur hook belum dikerjakan.** Request yang terpicu klik/scroll memang sudah
ditangkap hook di MAIN world, tapi belum ada kode yang mengubahnya menjadi
`ApiPlan` di tengah run. Jalur perluasan sekarang murni DOM (snapshot ulang),
jadi lebih lambat dan lebih rapuh daripada replay API — hook adalah langkah
berikutnya, bukan yang sekarang berjalan.

Batas yang diketahui: daftar yang scroll-nya di dalam container `overflow:auto`
belum ditangani (scroll hanya lewat `window`); daftar virtualized bisa membuat
item yang sudah dibuang dari DOM hilang tanpa jejak; dan klik yang ternyata
menavigasi membuat `fetchPageInTab` gagal → run `paused` (checkpoint aman, bisa
dilanjutkan dengan tombol Lanjutkan).

---

## 7. Protokol pesan (`src/messaging/protocol.ts`)

Semua request divalidasi Zod (`RequestSchema`, discriminated union). Semua balasan
berbentuk `{ ok: true, data } | { ok: false, error }`.

| Pesan | Arah | Isi | Balasan |
| --- | --- | --- | --- |
| `run:start` | panel → SW | `tabId`, `maxPages?`, `maxItems?`, `captureApi?`, `incremental?` | `RunSnapshot` |
| `pick:save` | content → SW | `page{url,title,source,selector,items[]}` | `RunSnapshot` |
| `run:get` | panel → SW | `runId` | `RunSnapshot` |
| `run:stop` | panel → SW | `runId` | `RunSnapshot` |
| `run:resume` | panel → SW | `runId` | `RunSnapshot` |
| `records:preview` | panel → SW | `runId`, `limit?`, `onlyNew?` | `RecordRow[]` |
| `run:recent` | panel → SW | — | `Run[]` (10 terbaru) |
| `run:export` | panel → SW | `runId`, `format`, `onlyNew?` | `ExportFile` |
| `probe:tab` | panel → SW | `tabId` | `TabProbeResponse` |

Pesan SW ↔ tab (`MESSAGE`):

| Pesan | Arah | Fungsi |
| --- | --- | --- |
| `toggle-picker` | popup → content | nyalakan/matikan picker, balas `{active}` |
| `scrapergod:probe` | SW → content | `TabProbeResponse` (kandidat, best, `api`, jumlah capture) |
| `scrapergod:fetch-page` | SW → content | snapshot halaman (items, nextUrl, source, selector, `canExpand`); `expand: true` = perluas halaman yang sama |
| `scrapergod:net-arm` / `net-disarm` | SW → content | nyalakan/matikan hook di MAIN |
| `scrapergod:net-replay` | SW → content | replay GET di halaman → `{ok,status,url,body,truncated,error?}` |

Jembatan MAIN ↔ content memakai `window.postMessage` dengan
`{source:'scrapergod', dir:'page->main'|'main->page', type}` — **bukan**
`CustomEvent`, karena `detail` tidak menyeberang antar world di Chrome.

---

## 8. Skema data (`src/shared/types.ts`, Dexie `scrapergod`)

```
Run
  id, status(queued|running|paused|stopped|done|failed)
  startUrl, tabId(nullable), maxPages, maxItems
  createdAt, updatedAt, finishedAt, lastError, stopReason
  checkpoint { nextUrl, page, itemCount, lastFingerprint, emptyPages, seenPages, expand }
  lease { owner, expiresAt } | null
  api ApiPlan | null
  incremental boolean (default true — izin berhenti cepat di `all-known`)

RecordRow                              (id = `${runId}:${urlKey}`)
  id, runId, urlKey, url, title
  fields {canonical|info_1|info_2 → string}
  raw, provenance{source,pageUrl,selector,adapter,capturedAt}
  isNew (belum pernah terlihat di run mana pun sebelum run ini)
  firstSeenAt, lastSeenAt

SeenEntry                              (id = urlKey, satu baris per item selamanya)
  id, siteKey(origin+path tanpa query), urlKey
  firstSeenAt (tidak pernah ditimpa), lastSeenAt, lastRunId

ApiPlan
  url, method(GET|POST), contentType|null
  bodyTemplate|null, bodyPageParam|null (mis. `variables.page`)
  cursorParam|null, cursorKind(query|body)|null
  arrayPath, mapping{title,url,company,location,salary,date,description}
  pageParam|null, pageKind(page|offset), pageValue, pageSize|null, total|null
  (checkpoint juga menyimpan `cursor` terakhir)
```

Index Dexie (versi 2): `runs: id, status, updatedAt` ·
`records: id, runId, [runId+urlKey], firstSeenAt` · `seen: id, siteKey, lastSeenAt`.
Naik ke v2 hanya menambah tabel `seen`; data lama tidak disentuh.

Field kanonik (`CANONICAL_FIELDS`): `title, url, company, location, salary,
date, description`. Auto-map memakai alias regex lebar (`src/core/source/json.ts`).
Untuk DOM, `rowOf()` menghasilkan `[judul, url, info_1, info_2]`.

Migrasi: DB lama bernama `scrapekit` dibaca lewat IndexedDB mentah (`getAll` per
object store), disalin ke `scrapergod` dalam satu transaksi, baru sumbernya
dihapus. Kalau penyalinan gagal, sumber **tidak** dihapus. Dijalankan sekali per
umur SW dan ditunggu sebelum query pertama.

---

## 9. Invarian — jangan dilanggar

1. **Id record = `${runId}:${urlKey}`.** Resume dan halaman berulang tidak boleh
   menambah baris ganda.
2. **Record + checkpoint + lease + `seen` ditulis dalam SATU transaksi**
   (`commitPage`). Tidak boleh ada kondisi "checkpoint maju, data hilang", atau
   "record tersimpan tapi ditandai belum pernah dilihat".
3. **Lease (25 detik) dihitung dari waktu SETELAH fetch**, bukan sebelum. Kalau
   tidak, halaman lambat memakan umur lease dan worker lain menyerobot run aktif.
4. **State run tidak boleh hidup di variabel global SW.** Semua di Dexie;
   engine harus idempoten saat dipanggil ulang.
5. **Tidak ada data keluar dari browser.** Tanpa telemetry, tanpa server.
6. **Kegagalan harus terlihat**: probe memberi `notes`, run menyimpan
   `lastError` + `stopReason`, UI menerjemahkannya ke bahasa manusia.
7. **`src/core/**` murni.** Tidak ada `chrome.*`/`window` di sana.

---

## 10. Keputusan desain, alasan, dan yang sengaja ditolak

| Keputusan | Alasan | Alternatif yang ditolak |
| --- | --- | --- |
| WXT + Vite | HMR, auto-manifest, multi-entrypoint, maintenance aktif | Plasmo (stagnan), MV3 vanilla |
| Dexie/IndexedDB | Ratusan ribu baris tidak muat `storage.local`, butuh index & transaksi | `chrome.storage.local` |
| Engine = checkpoint + lease + alarm 30 dtk | MV3 mematikan SW (~30 dtk idle, ~5 menit per tugas); ini pola resmi, bukan akal-akalan keepalive | `setInterval`/port kosong untuk menahan SW |
| Replay API **di halaman**, bukan SW | Cookie/CORS/header sama seperti situs, tanpa host permission baru | `fetch` dari SW (beda pihak, butuh izin) |
| Rekam API butuh **satu reload** | SPA sudah fetch sebelum user bisa klik apa pun | Hook yang dinyalakan belakangan (tidak pernah melihat request pertama) |
| Arm disimpan di **sessionStorage** | Bertahan saat reload untuk rekam, hilang saat tab ditutup | `storage.local` (menempel permanen ke semua situs) |
| Buffer capture hanya di MAIN, **ditarik** content | Tidak ada race: content script tidak perlu siap sebelum fetch pertama situs | Push dari MAIN (capture pertama hilang) |
| `postMessage`, bukan `CustomEvent` | `detail` tidak menyeberang antar world di Chrome | CustomEvent |
| **Tolak POST & cursor** | Menebak body/cursor menghasilkan halaman salah yang tidak kelihatan salahnya | Tebak body/cursor |
| `emptyPages` disimpan di checkpoint | "3 halaman tanpa item baru" tetap benar setelah SW mati | Counter di memori |
| `seen` per item, bukan salinan record | Menandai "baru" dan berhenti cepat tanpa menggandakan data | Menyalin record ke tabel riwayat |
| Halaman pertama tidak dihitung untuk `all-known` | Satu halaman belum membuktikan urutan situs, dan hasil picker juga menandai item dikenal | Berhenti di halaman 1 (melewatkan sisa daftar setelah Ambil) |
| Load-more/scroll = ambil ulang halaman yang sama (`expand`) | Dedupe, `emptyPages`, dan batas halaman yang sudah ada langsung berlaku | Mesin pagination kedua khusus infinite scroll |
| Pemicu diklik/di-scroll di content script, bukan ditebak dari DOM | Situs memicu request lewat event; hook yang sudah ada menangkapnya | Menebak URL API dari struktur tombol |
| Jeda antar-halaman **setelah commit** | Kalau SW mati saat menunggu, run lanjut dari halaman yang benar | Jeda sebelum commit |
| Dedupe pakai **semua** kunci halaman untuk fingerprint | Lazy-load yang mengulang item membuat dedupe "buta" kalau hanya kunci tersimpan | Fingerprint dari record tersimpan |
| Ekspor dibangun SW, Blob dibuat panel | SW tidak punya `createObjectURL`; panel sudah DOM | Offscreen document, permission `downloads` |
| CSS manual per entrypoint | Tidak ada dependency styling; bundle kecil | Tailwind (disebut PLAN, tidak dipakai) |
| Ikon digambar sendiri | Ikon template WXT bikin ekstensi terlihat generik | Aset template |

---

## 11. Peta file (LOC nyata, 1 Nov 2026)

```
entrypoints/
  background.ts          426  SW: router, pumpRun, resume, alarm, captureApi, fetchApiPage, expand
  content.ts             488  picker, probeSummary, pageSnapshot, expandOnce, jembatan pesan
  main-world.content.ts  147  hook fetch/XHR, arm sessionStorage, replay fetch
  popup/App.tsx          105  toggle picker + buka panel
  sidepanel/App.tsx      392  status, progres, pratinjau, ekspor, filter "hanya baru"
src/
  shared/types.ts        201  skema Zod: Run, RecordRow, SeenEntry, ApiPlan, PageSnapshot
  shared/url.ts           65  absoluteUrl + urlKey + siteKey (buang utm_*, hash, trailing slash)
  core/run/engine.ts     462  createRun, pump, savePickedRun, stopRun, buildRecords, expand
  core/store/db.ts       189  ScraperGodDB (v2: +seen), DexieRunStore, migrateLegacyDatabase
  core/store/types.ts     33  interface RunStore (untuk test & implementasi lain)
  core/probe/index.ts    130  skoring kandidat + notes
  core/probe/embedded.ts  89  JSON-LD, __NEXT_DATA__, __NUXT_DATA__, application/json
  core/probe/dom.ts       44  daftar berulang di DOM
  core/probe/next.ts      55  findNextUrl (rel=next, teks "berikutnya")
  core/probe/more.ts     140  findMoreButton (+ pengaman klik) + isClickable + canScrollFurther
  core/source/json.ts    214  getAtPath, asText, findItemArrays, autoMapFields, toPageItems
  core/source/network.ts 241  analyzeCapture, scanCaptures, apiPageUrl, hasMorePages, snapshotFromApiPage
  core/export/csv.ts      56  RFC 4180 + BOM + CRLF
  core/export/json.ts     86  record + provenance + run
  core/export/index.ts    45  buildExport + batas 32 MB
  net/hook.ts            272  pembungkus fetch/XHR, capture JSON terbatas
  net/bridge.ts           57  tipe & guard postMessage
  net/page-bridge.ts     149  sisi content: arm, list, replay (timeout 1 s / 15 s)
  net/paginate.ts        149  inferPagination dari URL + body
  picker/infer.ts        205  inferensi set item berlevel
  picker/extract.ts      108  rowOf, rowsOf, escapeCell, toTSV
  picker/ui.ts           272  overlay shadow DOM + HUD + toast
  messaging/protocol.ts  139  kontrak pesan + MESSAGE const
tests/ (7 file, 91 test)
  engine.test.ts         606  26 test  state machine, dedupe, lease, idle stop, jeda, lintas-run, ekspansi
  network.test.ts        191  13 test  analyzeCapture, apiPageUrl, hasMorePages, snapshot
  picker.test.ts         172  12 test  inferensi set (fixture HTML)
  net.test.ts            159   9 test  hook fetch/XHR + inferPagination
  store.test.ts          167   5 test  Dexie + migrasi DB lama + riwayat seen
  export.test.ts         126   7 test  CSV escaping, JSON, batas ukuran
  probe.test.ts          149  13 test  probe embedded/DOM/next, tombol muat-lebih, sisa scroll
  fixtures/*.html        9 file       kartu, iklan, tinggi berbeda, tabel, grid, JSON-LD, NEXT_DATA
```

Konstanta yang sering ditanya:

| Nilai | Di mana | Arti |
| --- | --- | --- |
| 25 dtk | `engine.ts` | TTL lease per halaman |
| 50 / 5000 | `engine.ts` | default `maxPages` / `maxItems` |
| 3 | `engine.ts` + `background.ts` | `idlePageLimit` (halaman tanpa item baru) |
| 1 | `engine.ts` + `background.ts` | `knownPageLimit` (halaman semua-dikenal → `all-known`) |
| 1200 ms | `background.ts` | jeda antar-halaman |
| 20 dtk | `background.ts` | `PAGE_READY_TIMEOUT_MS` (tunggu content melapor URL) |
| 25 / 4 dtk | `background.ts` | timeout rekam API / waktu tunggu setelah halaman siap |
| 30 dtk | `background.ts` | periode alarm `scrapergod:run-tick` |
| 500 | `types.ts` | `PAGE_SNAPSHOT_LIMITS.maxItemsPerPage` |
| 12 / 512 KB | `network.ts` | `maxCaptures` / `maxBodyBytes` |
| 4 MB | `main-world.content.ts` | batas body replay |
| 32 MB | `export/index.ts` | batas ekspor sekali jalan |

---

## 12. Riwayat keputusan penting (kenapa kode terlihat begini)

Ini yang tidak akan kamu temukan dari membaca diff, dan semuanya hasil temuan nyata:

1. **`itemCount` dulu menggelembung** karena dedupe hanya per halaman; lazy-load
   mengulang item → progres bohong dan `maxItems` terpotong dini. Sekarang engine
   memuat semua `urlKey` tersimpan sekali di awal `pump`.
2. **Lease dulu dihitung sebelum fetch** → sisa 5 detik setelah fetch 20 detik.
3. **Tab dulu tidak dinavigasi** kalau content script belum siap → run menunggu 20
   detik lalu `paused`. Sekarang URL tab dicek lewat `tabs.get`.
4. **Listener XHR dulu menumpuk** pada instance yang dipakai ulang.
5. **Toast "tersimpan" dulu menipu** saat baris dipotong 500.
6. **`capture.url` sering relatif** (`/api/jobs?page=1`) → rencana API menembak
   path di origin mana pun. Sekarang dinormalisasi absolut di sumbernya.
7. **Rename internal** `scrapekit` → `scrapergod` (class `ScraperGodDB`, DB,
   `data-scrapergod-ui`, key pesan, alarm, global `__scrapergod*`) **plus migrasi
   data** yang tidak menghapus sumber kalau penyalinan gagal.
8. **Berhenti cepat dulu direncanakan di halaman 1**, ternyata berbahaya: hasil
   picker sudah menandai item sebagai dikenal, jadi run setelah "Ambil" akan
   berhenti sebelum menyentuh halaman 2. Sekarang `all-known` baru berlaku mulai
   halaman kedua.
9. **Ekspansi mengubah stop reason yang muncul lebih dulu.** Dengan `incremental`
   aktif, ekspansi yang isinya sudah dikenal berhenti sebagai `all-known` di
   percobaan kedua, bukan `no-new-items` setelah tiga. Keduanya benar; test
   menguji kedua jalur (matikan `incremental` untuk melihat `emptyPages` bekerja).

---

## 13. Batasan yang belum terbukti (baca sebelum mengklaim sesuatu berfungsi)

Semua di bawah **hanya terverifikasi lewat unit test, tsc, dan build**:

- ❌ **Belum pernah dijalankan di Chrome sungguhan.** Tidak ada satu pun bukti
  runtime untuk: `tabs.sendMessage`, navigasi tab, side panel, clipboard,
  unduhan, rekam API, replay API, atau resume setelah SW mati.
- ❌ Tidak ada test integrasi SW ↔ content; semua test di jsdom + IndexedDB palsu
  (`fake-indexeddb`).
- ❌ Tidak ada sampel dari situs nyata; pemilihan sumber & mapping hanya diuji
  dengan fixture yang saya tulis sendiri.

Artinya: kalau kamu mengubah apa pun di jalur network/tab/clipboard, **jangan**
bilang "sudah bekerja" — cukup "lulus unit test dan build".

---

## 14. Masalah terbuka (urut dampak)

1. **Navigasi memakai tab user.** Pagination DOM masih `tabs.update` pada tab yang
   sedang dipakai; belum ada tab latar (`tabs.create({active:false})`). Jalur API
   sudah tidak menavigasi sama sekali.
2. **POST/GraphQL hanya bisa direplay kalau body-nya JSON yang terekam.** Body
   non-JSON (multipart) ditolak; token yang ikut di dalam body tetap tersimpan
   apa adanya karena itu bagian dari body situs.
3. **Retry hanya untuk 429/503.** Error jaringan (status 0) dan 5xx lain masih
   langsung `paused` tanpa percobaan ulang.
4. **Tidak ada penghormatan `robots.txt` / batas domain.**
5. **Ekspansi hanya untuk scroll halaman dan tombol di dokumen utama.** Daftar
   yang scroll-nya di dalam container sendiri (`overflow: auto`) atau tombol yang
   baru muncul setelah beberapa kali scroll belum tertangani; `findMoreButton`
   juga hanya mengenali satu tombol per percobaan.
6. **`bestLink` memilih anchor berteks terpanjang**, bisa link deskripsi, bukan
   judul.
7. **Tidak ada validasi pengirim pesan** (`sender.tab`/`sender.id`) di SW.
8. **Riwayat `seen` belum bisa dibersihkan dari UI.** Tabelnya tumbuh terus satu
   baris per item; belum ada tombol "lupakan situs ini" (sekarang hanya bisa
   dengan menghapus database ekstensi).
9. **Belum ada options page, alur izin opsional, kebijakan privasi** — tiga syarat
   submit Chrome Web Store.
10. **`pick:save` selalu mengirim `source: 'dom'` dan `selector: null`** dari
    picker, walau sebenarnya halaman bisa punya JSON. Provenance hasil picker
    karena itu kurang akurat.

---

## 15. Konvensi kerja di repo ini

- Semua teks yang dilihat user: **Bahasa Indonesia**, tanpa istilah pemasaran.
- Komentar menjelaskan **kenapa**, bukan mengulang **apa**.
- `src/core/**` murni (tanpa `chrome.*`) supaya bisa dites.
- Setiap perbaikan bug disertai test regresi di `tests/`.
- Jangan tambah dependency tanpa alasan kuat (sekarang 4 runtime).
- Verifikasi minimum sebelum selesai: `npx tsc --noEmit` + `npx vitest run`;
  tambahkan `npx wxt build` kalau menyentuh entrypoint/manifest.
- Jangan memakai `--load-extension` (sudah dihapus di Chrome 156).

---

## 16. Kalau kamu diminta menilai/melanjutkan, jawab ini dulu

1. **Pagination:** untuk endpoint POST dan cursor — rekam body request/cursor, atau
   kendalikan UI di tab latar? Risikonya masing-masing terhadap perubahan situs
   dan terhadap akun user?
2. **Incremental:** skema paling murah untuk "run berikutnya hanya menambah item
   baru" tanpa menyimpan salinan penuh dua kali?
3. **Ketahanan selector:** cukup inferensi bentuk (jumlah anak, kemiripan tag,
   tinggi), atau perlu adapter/fingerprint struktural per situs sejak awal?
4. **Etika:** batas aman halaman/jeda untuk scraper yang jalan di browser user
   sendiri; apa yang sebaiknya diblokir (mis. halaman butuh login)?
5. **MV3:** alarm + checkpoint (sekarang) vs offscreen document vs `scripting` —
   mana yang paling andal untuk kerja panjang?
6. **Data lokal:** Dexie vs OPFS untuk run 100 ribu baris?
7. **Prioritas:** tiga hal mana dari §14 yang paling menaikkan nilai produk?
