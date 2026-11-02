# AUDIT — scraperGOD

Audit menyeluruh atas kode yang ada per 1 November 2026. Isinya: apa yang saya
periksa, apa yang salah, apa yang sudah diperbaiki, dan apa yang sengaja dibiarkan
beserta alasannya.

Metode: membaca ulang seluruh modul `src/**` dan `entrypoints/**`, menjalankan
`tsc --noEmit`, 55 test Vitest, `wxt build`, dan memeriksa isi manifest hasil build.
Referensi eksternal yang dipakai ada di §6.

---

## 1. Ringkasan

| Kategori | Jumlah |
| --- | --- |
| Bug diperbaiki di audit ini | 5 |
| Test regresi baru | 3 |
| Temuan terbuka (belum dikerjakan) | 12 |
| Modul yang dibaca penuh | 20 file |

Status verifikasi setelah perbaikan: `tsc` bersih, **55 test lulus** (6 file),
`wxt build` exit 0.

---

## 2. Bug yang diperbaiki

### 2.1 `itemCount` menggelembung karena duplikat antar-halaman

**File:** `src/core/run/engine.ts`, `src/core/store/{types,db}.ts`

Dedupe lama hanya berjalan **di dalam satu halaman**. Situs dengan lazy-load
sering mengulang item terakhir halaman sebelumnya di halaman berikutnya. Karena
id record idempoten (`${runId}:${urlKey}`), barisnya memang tidak bertambah —
tapi `checkpoint.itemCount` tetap bertambah. Akibatnya:

- progres di panel lebih besar dari jumlah baris nyata;
- `maxItems` tercapai lebih awal, jadi data terpotong tanpa alasan.

**Perbaikan:** `RunStore.listUrlKeys(runId)` baru; engine memuat semua `urlKey`
yang sudah tersimpan sekali di awal `pump`, lalu melewati item yang sudah dikenal.
`fingerprint` sekarang dibangun dari **semua** kunci halaman (bukan hanya yang
tersimpan), supaya deteksi "halaman berulang" tidak buta saat semua itemnya duplikat.

**Test:** `item yang sudah tersimpan dari halaman sebelumnya tidak dihitung dua kali`,
`maxItems tidak habis terpakai oleh duplikat antar halaman`.

### 2.2 Lease dihitung dari waktu sebelum fetch

**File:** `src/core/run/engine.ts`

`expiresAt = at + ttl` memakai `at` yang diambil **sebelum** `fetchPage`. Fetch
bisa memakan 20 detik (`PAGE_READY_TIMEOUT_MS`), jadi lease hanya menyisakan
5 detik — cukup untuk worker lain menyerobot run yang masih berjalan.

**Perbaikan:** waktu diambil ulang setelah fetch (`commitAt`) dan dipakai untuk
`updatedAt`, `finishedAt`, `capturedAt`, dan `expiresAt`.

**Test:** `lease dihitung dari waktu setelah halaman selesai diambil`.

### 2.3 Navigasi tidak terjadi saat content script belum siap

**File:** `entrypoints/background.ts`

`fetchPageInTab` hanya memanggil `tabs.update` kalau *berhasil* menghubungi
content script dan URL-nya berbeda. Kalau content script belum terpasang (SW baru
bangun, halaman sedang dimuat, tab sudah pindah), `cached` bernilai `null`, tab
tidak pernah dinavigasi, lalu run menunggu 20 detik dan berakhir `paused` padahal
masalahnya hanya satu `tabs.update`.

**Perbaikan:** saat content script tidak merespons, URL tab dibaca lewat
`browser.tabs.get(tabId)`; kalau berbeda dari target, tab dinavigasi. Tab yang
sudah ditutup menghasilkan error yang jelas, bukan timeout.

### 2.4 Listener XHR menumpuk pada objek yang dipakai ulang

**File:** `src/net/hook.ts`

`proto.send` memasang listener `load` setiap kali dipanggil. Satu instance
`XMLHttpRequest` yang dipakai untuk beberapa request akan mencatat respons yang
sama beberapa kali, dan listener lama tetap hidup.

**Perbaikan:** penanda `__scrapergodListening` per instance — listener dipasang sekali.

### 2.5 Toast "tersimpan" menipu saat baris dipotong

**File:** `entrypoints/content.ts`

Tombol "Ambil" memotong 500 baris tapi tetap berkata `${rows.length} item tersimpan`.

**Perbaikan:** pesan menyebut jumlah yang benar-benar disimpan
(`${saved} dari ${total} item tersimpan (batas sementara)`).

### 2.6 Tiga celah P0 ditutup setelah audit

Bukan bug kecil, jadi dicatat terpisah beserta alasan desainnya.

1. **Hook jaringan sekarang tersambung (probe + SW).** Jembatan memakai
   `postMessage` (`src/net/bridge.ts`) karena `CustomEvent.detail` tidak
   menyeberang antar world. Buffer capture hanya di MAIN world dan **ditarik**
   content script, supaya tidak ada race saat fetch pertama situs terjadi
   sebelum content script siap. Arm disimpan di `sessionStorage` per tab, jadi
   bertahan saat SW memuat ulang halaman sekali untuk merekam API — dan hilang
   saat tab ditutup, bukan menempel ke semua situs.
2. **Replay API dijalankan di halaman, bukan di SW.** `fetch` dari MAIN world
   memakai cookie, header, dan aturan CORS milik situs; SW tidak butuh
   `host_permissions` tambahan, dan request tidak terlihat sebagai pihak ketiga.
   Endpoint POST dan pagination cursor **ditolak dengan alasan jelas**, bukan
   ditebak: menebak body/cursor menghasilkan halaman salah yang tidak kelihatan
   salahnya.
3. **"Ambil" di picker = run sungguhan.** `savePickedRun` memakai jalur record
   yang sama dengan run biasa (`urlKey`, dedupe, provenance), jadi hasil picker
   bisa dipratinjau dan diekspor tanpa bentuk data kedua yang harus dirawat.

---

## 3. Temuan terbuka

Urut dampak. Belum dikerjakan karena butuh keputusan desain, bukan tambalan.

### P0 — memengaruhi kebenaran data

1. **Tidak ada dedupe antar-run.** `firstSeenAt` sudah disimpan, tapi run baru
   selalu mulai dari nol. "Hanya yang baru" belum mungkin.

### P1 — memengaruhi keandalan di situs nyata

4. **Pagination hanya `<a href>`.** Tombol "Muat lebih banyak" berbasis JS tidak
   diikuti; `findNextUrl` tidak melihat perubahan daftar setelah klik.
5. **Navigasi memakai tab user** (`tabs.update`), tanpa mode tab latar. Jeda
   antar-halaman (1,2 detik) sudah ada di engine; yang belum ada hanya tab
   latar, jadi run panjang masih mengganggu pekerjaan user.
6. **Tidak ada rate limit / backoff.** Satu halaman error → `paused`, tanpa retry
   dengan jeda.
7. **Tidak ada penghormatan `robots.txt`** atau batas domain. Untuk scraper yang
   jalan di browser user sendiri ini keputusan etis, bukan teknis.
8. **`bestLink` memilih anchor berteks terpanjang**, yang bisa berupa link
   deskripsi alih-alih judul lowongan.
9. **Belum ada adapter per situs.** Semua situs memakai inferensi bentuk yang sama.

### P2 — sebelum rilis

10. **Tidak ada validasi pengirim pesan** di SW (`sender.tab`/`sender.id`).
11. **Belum ada options page, alur izin opsional, dan kebijakan privasi** — tiga
    syarat submit ke Chrome Web Store.
12. **Belum ada uji integrasi SW↔content** dan **belum pernah dijalankan di Chrome
    sungguhan**. Semua uji berjalan di jsdom + IndexedDB palsu.

---

## 4. Yang saya periksa dan ternyata aman

- **XSS di picker:** HUD memakai `innerHTML` hanya untuk markup statis; semua teks
  dari halaman masuk lewat `textContent`. Aman.
- **Isolasi CSS picker:** shadow DOM + `:host { all: initial }`; highlight tidak
  terpengaruh CSS halaman dan tidak bocor keluar.
- **Klik saat picker aktif:** semua klik halaman dicegah, tapi event dari UI
  sendiri dikenali lewat `composedPath()` sehingga tombol HUD tetap bekerja.
- **Transaksi Dexie:** `commitPage` menulis record + checkpoint + lease sekaligus;
  tidak ada kondisi "checkpoint maju, data hilang".
- **Idempotensi record:** id `${runId}:${urlKey}` membuat resume dan halaman
  berulang tidak pernah menghasilkan baris ganda.
- **URL key:** `utm_*`, hash, trailing slash, dan query urutan acak dibuang
  sebelum jadi kunci.
- **CSV:** escaping RFC 4180 benar (koma, kutip ganda, CR/LF), BOM untuk Excel,
  CRLF, kolom stabil antar-export.
- **Ekspor besar:** dibatasi 32 MB dengan pesan jelas, bukan gagal senyap.
- **Nama & ikon:** `name`/`short_name` dari nama folder, ikon 16–128 px dibuat
  sendiri (bukan aset template WXT).
- **Migrasi DB:** data dari nama database lama disalin dalam satu transaksi lalu
  database lama dihapus; kalau penyalinan gagal, sumbernya tidak dihapus.

---

## 5. Rekomendasi arsitektur (berdasarkan riset)

### 5.1 MV3: engine sekarang sudah benar arahnya, tapi jangan diperpanjang sembarangan

Service worker MV3 dimatikan setelah **~30 detik idle** dan **~5 menit** untuk satu
tugas panjang. Pola yang dipakai sekarang — checkpoint per halaman + lease +
alarm 30 detik + resume saat SW bangun — adalah pola yang direkomendasikan, bukan
akal-akalan keepalive. Jadi:

- Jangan tergoda `setInterval` atau port kosong untuk "menahan" SW.
- Kalau nanti butuh kerja berat non-JS (kompresi, parsing file besar), arahnya
  **offscreen document**, bukan SW.
- Setiap `tabs.sendMessage`/`tabs.update` sudah otomatis mereset timer idle, jadi
  pola polling 400 ms saat menunggu halaman aman.

### 5.2 Pagination: hybrid, dengan API sebagai jalur utama

Literatur scraper konsisten: lapisan jaringan lebih stabil dan jauh lebih murah
daripada mengklik UI, karena tidak bergantung pada teks tombol dan tidak merusak
state halaman. Tapi replay API rapuh terhadap token/CSRF dan header dinamis.

Rekomendasi konkret, berurutan:

1. Kalau hook jaringan menemukan endpoint JSON yang memuat item → **replay request**
   dengan parameter halaman/cursor yang sudah bisa ditebak `src/net/paginate.ts`.
2. Kalau tidak ada → **kendalikan UI** seperti sekarang, tapi di **tab latar**
   (`tabs.create({ active: false })`) supaya tab user tidak terus berpindah.
3. Untuk "Muat lebih banyak": klik tombol, lalu tunggu **jumlah item bertambah**
   (bukan `status === complete`), dengan batas percobaan.
4. Selalu punya dua penghenti: `maxPages` (sudah) dan **tidak ada item baru**
   (sekarang hanya terdeteksi kalau seluruh fingerprint sama). Tambahkan penghenti
   "0 item baru selama N halaman".

### 5.3 Dedupe dan incremental

Simpan satu tabel `records` dengan primary key `${runId}:${urlKey}` (sekarang) **plus**
indeks unik global `[siteKey+urlKey]` untuk incremental. Run berikutnya cukup
mengisi `firstSeenAt` untuk baris yang belum ada dan memperbarui `lastSeenAt`
untuk yang sudah ada — tanpa menyimpan salinan kedua.

---

## 6. Sumber yang dipakai

- Chrome for Developers, *Migrate to a service worker* — komunikasi SW ↔ offscreen,
  batas umur worker.
- MetaDesigns, *Manifest V3 Service Worker Gotchas* (2026) — 30 detik idle,
  5 menit per tugas.
- Shifter (2026), *How to Scrape Pagination and Infinite Scroll Reliably at Scale* —
  utamakan lapisan jaringan, bukan HTML hasil render.
- Webscraper.io (2026), *How to scrape infinite scroll and lazy-loaded content* —
  deteksi item bertambah, bukan status halaman.

---

## 7. Batas audit ini

- **Tidak ada pengujian di Chrome sungguhan.** Chrome 156 sudah menghapus
  `--load-extension` dari command line, jadi saya tidak bisa memuat ekstensi
  otomatis; semua temuan di atas berasal dari kode, test, dan manifest hasil build.
- Bug yang hanya muncul karena perilaku situs asli (anti-bot, login, CORS,
  iframe) belum bisa ditemukan tanpa sesi manual.
- Audit ini tidak menilai kualitas data hasil scrape di situs nyata — itu butuh
  sampel dari minimal tiga situs berbeda.
