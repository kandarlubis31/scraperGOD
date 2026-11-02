# HANDOFF — scraperGOD

Dokumen ini untuk dibagikan ke AI/dev lain yang diminta memberi saran. Isinya
kondisi nyata repo per commit terakhir, bukan rencana. Kalau ada yang bertentangan
dengan `PLAN.md`/`DRD.md`, dokumen ini yang benar.

Terakhir diperbarui: 1 November 2026.

> Untuk agen/AI yang belum tahu apa pun soal proyek ini, baca **`CONTEXT.md`**
> dulu — di situ ada konteks lengkap, arsitektur lima konteks, alur data, invariant,
> tabel konstanta, dan daftar dokumen mana yang sudah basi. Dokumen ini adalah
> ringkasan yang lebih pendek dari itu.

---

## 1. Produk ini apa

Ekstensi Chrome (MV3) untuk menarik daftar item dari halaman web — fokus awal
situs lowongan kerja — termasuk menembus pagination, lalu mengekspor hasilnya.

Dua alur pemakaian:

1. **Picker manual** — user menekan `Alt+Shift+P`, mengarahkan kursor ke daftar,
   ekstensi menyorot semua item yang serupa, HUD menampilkan jumlah, lalu
   `Enter` untuk ambil atau `Shift+Enter` untuk copy TSV.
2. **Run otomatis** — panel samping menekan "Mulai ambil": ekstensi mendeteksi
   sumber data (JSON tersemat vs DOM), mengambil halaman 1, mengikuti tombol
   "berikutnya", menyimpan tiap item ke IndexedDB, dan mengekspor CSV/JSON.

## 2. Stack & perintah

- WXT 0.21 (Vite) + React 19 + TypeScript 5.9, MV3
- Dexie 4 (IndexedDB), Zod 4 (validasi), Vitest 3 (jsdom)
- Tidak memakai Tailwind; CSS ditulis manual per entrypoint
- Tidak ada backend. Semua data lokal di browser.

```bash
npm run dev            # wxt dev (HMR)
npm test               # vitest run  → 91 test
npm run compile        # tsc --noEmit
npm run build          # wxt build → .output/chrome-mv3
```

Muara build: `.output/chrome-mv3`. Load unpacked lewat `chrome://extensions`
(Developer mode). Catatan: Chrome 156 stable sudah menghapus `--load-extension`
dari command line, jadi memuat ekstensi otomatis lewat CDP **tidak bisa lagi**;
pengujian end-to-end harus manual.

## 3. Peta arsitektur

```
entrypoints/
  background.ts          service worker: router pesan, pump run, alarm, migrasi DB
  content.ts             content script: picker, probe DOM, snapshot halaman
  main-world.content.ts  world MAIN: hook fetch/XHR + replay API (arm per tab)
  popup/                 popup kecil: tombol picker + buka side panel
  sidepanel/             panel utama: status run, progres, pratinjau, ekspor

src/
  shared/types.ts        skema Zod: Run, RecordRow, PageItem, PageSnapshot, Lease
  shared/url.ts          absoluteUrl + urlKey (buang utm_*, hash, trailing slash)
  core/run/engine.ts     state machine run yang tahan SW mati
  core/store/db.ts       Dexie: runs, records + migrasi dari nama DB lama
  core/probe/            embedded.ts (JSON-LD, __NEXT_DATA__, __NUXT_DATA__,
                         application/json), dom.ts (fallback daftar berulang),
                         next.ts (URL halaman berikutnya), index.ts (skoring)
  core/source/json.ts    dot-path, auto-map key → 7 peran, item → PageItem
  core/source/network.ts rencana API dari capture, URL per halaman, snapshot JSON
  core/export/           csv.ts (RFC 4180 + BOM), json.ts, index.ts (batas 32 MB)
  picker/                infer.ts (tebak set item), extract.ts (kolom + TSV),
                         ui.ts (overlay shadow DOM + HUD)
  net/hook.ts            pembungkus fetch/XHR untuk menangkap JSON
  net/bridge.ts          protokol postMessage MAIN↔content (tarik capture, replay)
  net/page-bridge.ts     sisi content: arm, tarik capture, replay fetch
  net/paginate.ts        tebak parameter pagination dari URL + body JSON
  messaging/protocol.ts  kontrak pesan + validasi Zod
```

## 4. Alur data

```
panel "Mulai ambil"
  → SW: run:start { tabId, maxPages }
  → content: probe → ProbeResult (best = embedded JSON atau DOM)
  → engine.createRun (status queued, tabId disimpan)
  → engine.pump loop:
       fetchPage(url, run)  → SW: tabs.sendMessage(fetch-page)
                              → content: snapshot { url, items, nextUrl, source }
       kalau URL tab ≠ target: tabs.update lalu TUNGGU content melapor URL yang benar
       commitPage(run, records)  ← run + records + lease, SATU transaksi Dexie
  → run done/stopped/paused
panel: polling 800 ms → run:get + records:preview
panel: tombol ekspor → run:export → SW bangun CSV/JSON → panel bikin Blob + <a download>
```

## 5. Invarian yang harus dijaga

1. **Id record = `${runId}:${urlKey}`** — resume tidak boleh menghasilkan baris ganda.
2. **Record + checkpoint + lease ditulis dalam satu transaksi.** Tidak boleh ada
   kondisi "checkpoint maju, data hilang".
3. **Lease per halaman (25 detik)** mencegah dua worker menggarap run yang sama.
4. **Tidak ada data keluar dari browser.** Tidak ada telemetry, tidak ada server.
5. **Kegagalan harus terlihat**: probe mengembalikan `notes`, run menyimpan
   `lastError` dan `stopReason`.

## 6. Status per modul

| Modul | Status | Bukti |
| --- | --- | --- |
| Scaffold WXT + React + TS, MV3 | ✅ | `wxt build` exit 0, manifest valid |
| Skema + Zod | ✅ | `src/shared/types.ts` |
| DB Dexie + migrasi nama lama | ✅ | `tests/store.test.ts` (4 test) |
| Run engine durable | ✅ | `tests/engine.test.ts` (17 test) |
| Engine tersambung ke SW (router, resume, alarm) | ✅ | `entrypoints/background.ts` |
| Probe JSON tersemat + DOM | ✅ | `tests/probe.test.ts` (9 test) |
| Ekstraksi JSON-path + auto-map | ✅ | `src/core/source/json.ts` |
| Pagination DOM (`rel=next`, teks "berikutnya") | ✅ | `tests/probe.test.ts` |
| Sumber `network` (SPA lewat API) | ✅ | `tests/network.test.ts` (13 test) |
| Hook fetch/XHR tersambung ke probe + SW | ✅ | `src/net/bridge.ts`, `src/net/page-bridge.ts` |
| Pagination lewat replay API | ✅ | `src/core/source/network.ts` (`apiPageUrl`, `hasMorePages`) |
| Penghenti "0 item baru N halaman" + jeda antar-halaman | ✅ | `tests/engine.test.ts` |
| Side panel (mulai/stop/lanjut/progres/pratinjau) | ✅ | `entrypoints/sidepanel/` |
| Ekspor CSV + JSON | ✅ | `tests/export.test.ts` (7 test) |
| Picker (hover, level, HUD, TSV) | ✅ | `tests/picker.test.ts` (12 test) |
| Picker → run ("Ambil" jadi run) | ✅ | `savePickedRun` + `pick:save`, bisa diekspor |
| Adapter per situs | ❌ | — |
| Normalisasi gaji/tanggal/work-mode | ❌ | — |
| Dedupe lintas-run + berhenti cepat `all-known` | ✅ | tabel `seen`, `tests/engine.test.ts`, `tests/store.test.ts` |
| Muat lebih banyak & infinite scroll | ✅ | `src/core/probe/more.ts` + `expandOnce`, `expand` di engine |
| Options page, privasi, izin opsional | ❌ | belum bisa publish |
| Ikon + nama | ✅ | `public/icon/*.png`, nama = nama folder |
| Uji di Chrome sungguhan | ❌ | belum pernah dijalankan manual |

## 7. Hasil verifikasi terakhir

```
npx tsc --noEmit     → bersih
npx vitest run       → 7 file, 91 test lulus
npx wxt build        → exit 0, total ~583.5 kB, manifest:
  name: "scraperGOD" (ikut nama folder), short_name sama,
  permissions: storage, activeTab, alarms, sidePanel,
  side_panel.default_path: sidepanel.html,
  content_scripts: document_idle + main-world (world: MAIN, document_start)
```

## 8. Masalah terbuka (belum sempat diperbaiki)

Audit lengkap dan status perbaikan ada di `AUDIT.md`. Ringkasannya, urut dampak:

1. **Navigasi memakai tab user.** Pagination DOM dilakukan dengan `tabs.update`
   pada tab yang sedang dipakai; belum ada mode tab latar. (Jalur API sudah tidak
   menavigasi sama sekali, dan 1,2 detik jeda antar halaman sudah ada.)
2. **Replay API terbatas pada GET.** Endpoint POST (umum di situs lowongan besar)
   ditolak dengan alasan jelas, bukan ditebak bodi request-nya. Pagination cursor
   juga belum didukung.
3. **Belum ada retry/backoff.** Satu halaman error → `paused`, tanpa percobaan
   ulang berjeda.
4. **Tidak ada penghormatan `robots.txt` atau batas domain.**
5. **Ekspansi terbatas pada dokumen utama.** Tombol "muat lebih" dan scroll
   halaman sudah ditangani (ambil ulang halaman yang sama dengan `expand`),
   lengkap dengan pengaman klik: form/`form=`, teks berbahaya, elemen tak
   terlihat, dan link yang berpindah halaman — semuanya ada test-nya. Belum:
   daftar yang scroll-nya di dalam container `overflow:auto`, dan daftar
   virtualized (item lama dibuang dari DOM, sehingga snapshot penuh bisa bolong
   tanpa terdeteksi).
6. **`bestLink` memilih anchor dengan teks terpanjang**, yang bisa berupa link
   deskripsi, bukan judul.
7. **Tidak ada pengecekan pengirim pesan.** SW menerima `run:start` dari siapa
   pun yang bisa `runtime.sendMessage` (panel/popup) tanpa memeriksa `sender`.
8. **Belum ada uji integrasi SW↔content.** Semua uji di jsdom/Dexie palsu.

Sudah diperbaiki lebih awal: `itemCount` menggelembung karena duplikat
antar-halaman, lease yang dihitung sebelum fetch, navigasi tab yang tidak jalan
saat content script belum siap, listener XHR menumpuk, dan toast "tersimpan" yang
menipu saat baris dipotong.

Sudah ditutup pada putaran terakhir: hook jaringan tersambung ke probe dan SW
(sumber `network` untuk SPA, replay GET lewat halaman), "Ambil" di picker menjadi
run di DB yang bisa diekspor, serta penghenti "0 item baru N halaman" + jeda
antar-halaman di engine. Detail dan alasan desainnya di `AUDIT.md` §2.6.

Belum dikerjakan (dan ini penyimpangan dari brief fitur A, bukan lupa): **jalur
hook untuk perluasan**. Klik/scroll memang memancing request yang sudah
ditangkap hook fetch/XHR di MAIN world, tapi belum ada kode yang mengubah request
itu menjadi `ApiPlan` di tengah run. Jalur perluasan sekarang murni DOM, jadi
lebih lambat dan lebih rapuh di situs nyata; hook adalah langkah berikutnya.

Dua batas lain yang sudah diketahui: batas tunggu ekspansi 4 detik belum
dibedakan dari "daftar memang habis" (koneksi lambat bisa berakhir
`no-new-items` padahal belum sempat memuat), dan klik yang ternyata menavigasi
membuat `fetchPageInTab` gagal → run `paused` tanpa pemulihan otomatis.

Sudah ditutup berikutnya: **dedupe lintas-run**. Tabel `seen` (id = `urlKey`,
satu baris kecil per item, tanpa menyalin record) menandai `isNew` per record dan
memungkinkan run ulang berhenti setelah dua halaman di daftar terbaru-dulu
(`stopReason='all-known'`). Panel punya centang "Berhenti kalau halaman isinya
sudah dikenal" (default aktif) dan "hanya yang baru" yang juga berlaku untuk
ekspor. Riwayat `seen` belum bisa dihapus dari UI.

Putaran berikutnya menutup celah yang tidak ada di daftar awal: **muat lebih banyak
dan infinite scroll**. Kalau tidak ada link "berikutnya" tapi halaman masih bisa
bertambah, engine mengambil ulang halaman yang sama dengan `expand: true`; content
script mengklik tombol pemicu atau scroll sekali, menunggu daftar berubah, lalu
mengembalikan snapshot penuh. Dedupe, `emptyPages`, `all-known`, dan `maxPages`
yang sudah ada langsung dipakai tanpa mesin pagination kedua.

## 9. Pertanyaan yang saya ingin dijawab AI lain

Batasi jawaban ke hal yang benar-benar menaikkan kualitas produk ini:

1. **Pagination:** replay API (GET) sekarang jalur utama, DOM+`tabs.update` jadi
   cadangan. Untuk endpoint POST dan pagination cursor — dua hal yang ditolak
   sekarang — apakah layak merekam body request/cursor, atau lebih baik
   mengendalikan UI di tab latar? Apa risiko masing-masing terhadap perubahan
   situs dan terhadap akun user?
2. **Dedupe & incremental:** skema apa yang paling murah untuk "run kedua hanya
   menambah item baru" tanpa menyimpan salinan penuh dua kali?
3. **Resiliensi selector:** apakah inference berbasis bentuk (jumlah anak,
   kemiripan tag, tinggi) cukup, atau perlu fingerprint struktural per situs
   (adapter) sejak awal?
4. **Etika & risiko:** batas aman jumlah halaman/jeda untuk scraper yang
   dijalankan dari browser user sendiri, dan apa yang sebaiknya diblokir
   (mis. halaman yang butuh login) supaya produk ini tidak jadi alat abuse?
5. **MV3:** pola mana yang paling andal untuk pekerjaan panjang — alarm +
   checkpoint (sekarang), offscreen document, atau `chrome.scripting` dari SW?
6. **Data lokal:** Dexie (sekarang) vs OPFS untuk run besar (100 ribu baris)?
7. **Prioritas:** dari daftar §6 dan §8, tiga hal mana yang paling menaikkan
   nilai produk kalau dikerjakan berikutnya?

## 10. Konvensi kerja di repo ini

- Semua teks yang dilihat user: Bahasa Indonesia, tanpa istilah pemasaran.
- Komentar menjelaskan **kenapa**, bukan mengulang **apa**.
- Modul di `src/core/**` harus murni (tanpa `chrome.*`) supaya bisa dites.

## 11. Checklist uji manual: perluasan (fitur A)

Belum satu pun langkah di bawah pernah dijalankan di Chrome. Unit test membuktikan
logika, **bukan** bahwa layout, event, dan hook situs nyata bekerja. Isi hasilnya
di kolom catatan; kalau ada yang gagal, itulah yang menentukan apakah desain
`expand` cukup atau jalur hook harus didahulukan.

Persiapan: `npx wxt build` → `chrome://extensions` → Developer mode → Load
unpacked → `.output/chrome-mv3`. Buka DevTools service worker (link "service
worker" di kartu ekstensi) untuk melihat log `[scrapergod]`.

### A1. Tombol "muat lebih banyak" (wajib)

- [ ] Buka situs lowongan yang memakai tombol "Muat lebih banyak" / "Load more".
- [ ] Panel samping → **Mulai ambil** (matikan "Rekam API" dulu).
- [ ] Halaman 1 tersimpan; run **tidak** berhenti di `next-missing`.
- [ ] Jumlah item bertambah setelah tombol diklik (bukan tetap).
- [ ] Run berhenti sendiri saat tombol habis/hilang, dengan `stopReason`
      `next-missing` atau `no-new-items`.
- [ ] Tombol yang diklik adalah tombol daftar, **bukan** "Lamar"/"Simpan" di
      dalam kartu. Kalau salah klik: catat teks tombolnya — itu bug pengaman.

### A2. Infinite scroll (wajib)

- [ ] Buka daftar tanpa link "berikutnya" dan tanpa tombol (scroll murni).
- [ ] Mulai ambil. Halaman 1 tersimpan, tab tergulir ke bawah sendiri.
- [ ] Item baru bertambah; tidak ada halaman yang isinya kosong berulang.
- [ ] Setelah mentok, run berhenti (`next-missing`), bukan menggulir 50 kali.
- [ ] Catat: apakah setelah satu kali gulir tab berhenti di dasar halaman
      (normal) atau daftar butuh beberapa kali gulir untuk menambah isi (masih
      bisa, tapi lambat).

### A3. Pengaman klik (wajib, amati manual)

- [ ] Di halaman yang sama, cari tombol "Lamar", "Simpan", "Hapus", atau
      "Kirim" di dalam kartu. Pastikan **tidak ada** yang terklik selama run.
- [ ] Kalau situs punya tombol "muat lebih" di dalam `<form>` (mis. dengan input
      pencarian): pastikan tidak diklik.
- [ ] Kalau ada tombol tersembunyi (menu mobile, modal tertutup) berteks
      "muat lebih": pastikan tidak diklik.

### A4. Kasus gagal yang harus dicatat

- [ ] **Klik menavigasi:** kalau tab pindah halaman setelah klik, run harus
      `paused` dengan pesan "Halaman tidak bisa diperluas", checkpoint utuh, dan
      tombol **Lanjutkan** bekerja. Catat URL yang dituju.
- [ ] **Lambat:** di koneksi lambat (DevTools → Network → Slow 3G), apakah run
      berakhir `no-new-items` padahal daftar masih ada isinya? Kalau ya, ini
      celah yang sudah tercatat di §8.
- [ ] **Container sendiri:** daftar yang scroll-nya di dalam panel
      (`overflow:auto`) — pastikan perilakunya seperti yang diharapkan (kemungkinan
      besar: tidak bertambah, berhenti `no-new-items`). Catat supaya prioritas
      perbaikannya jelas.
- [ ] **Virtualized:** daftar yang membuang item lama saat digulir. Bandingkan
      jumlah record di panel dengan jumlah yang terlihat di situs.

### A5. Bukti yang perlu disimpan

- [ ] `stopReason` akhir run dan `checkpoint.page` untuk tiap situs.
- [ ] Jumlah record vs jumlah lowongan yang situs klaim.
- [ ] Screenshot panel + log SW kalau ada yang gagal.

Hasil A1–A3 menentukan apakah `expand` boleh dianggap selesai. Hasil A4 (terutama
navigasi dan container) menentukan urutan kerja berikutnya.
- Setiap perbaikan bug disertai test regresi di `tests/`.
- Jangan menambah dependency tanpa alasan kuat; saat ini hanya 4 dependency
  runtime (dexie, react, react-dom, zod).
