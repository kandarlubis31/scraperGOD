# DRD — ScrapeKit

> Detail requirement. Setiap requirement punya ID, prioritas, dan acceptance criteria (AC)
> yang bisa dicek. Kalau tidak bisa dicek, requirement-nya belum matang.

Prioritas: **P0** = wajib untuk rilis pertama · **P1** = wajib untuk "produk jadi" · **P2** = nanti.

## 1. Tujuan & metrik

| Metrik | Target v1 |
| --- | --- |
| Time-to-first-data (buka halaman → tabel terisi) | ≤ 3 detik, tanpa konfigurasi |
| Situs job board populer yang jalan tanpa setup | ≥ 4 dari 6 target |
| Akurasi field inti (judul, perusahaan, lokasi, URL) di adapter | ≥ 98% |
| Run 10 halaman tanpa intervensi | ≥ 95% kasus |
| Item terlewat karena pagination | 0 (dibuktikan dengan fixture + e2e) |
| Data keluar dari browser tanpa aksi user | 0 byte |
| Record dari JSON (bukan DOM) di situs yang menyediakannya | ≥ 70% run |
| Coverage pada query yang melebihi plafon situs | ≥ 90% dari total yang dilaporkan situs |
| Presisi penggabungan entitas lintas situs | ≥ 95% (sampel 100 pasangan berlabel manual) |
| Item baru Autopilot per minggu (user aktif) | ≥ 3× dari sekali scrape manual |
| Waktu dari hover list → data di clipboard | ≤ 3 detik, dua klik |

## 2. Functional requirements

### FR-1 — Deteksi daftar item (P0)

Saat panel dibuka, ekstensi mencari container berulang di DOM dan menebak mana yang "list".

- Kandidat dinilai dari: jumlah anak mirip (≥ 3), kedalaman, ukuran teks, keberadaan link
  dan heading di tiap anak, serta seberapa mirip struktur antar-sibling.
- Skor dikembalikan bersama kandidat lain, supaya user bisa ganti pilihan kalau salah.
- Prioritas bukti: JSON-LD (`ItemList`, `JobPosting`) dan data hidrasi (`__NEXT_DATA__`,
  `__NUXT__`, `__INITIAL_STATE__`) **lebih dipercaya** daripada heuristik DOM.
- Halaman tanpa list (artikel, detail lowongan tunggal) → tampilkan mode "ambil halaman ini".

**AC**
- Di 5 fixture halaman list berbeda (grid, list, card, table, `<ul>`), kandidat benar masuk 1 teratas.
- Halaman dengan list di dalam shadow DOM terdeteksi (atau dilaporkan "tidak didukung", bukan crash).
- Waktu deteksi < 300 ms untuk DOM 5.000 node.

### FR-2 — Ekstraksi nilai (P0)

Urutan sumber nilai per field: adapter → JSON-LD/microdata → atribut semantik (`itemprop`,
`data-testid`, `<time datetime>`) → teks/link di dalam item.

- Field minimum yang selalu dicoba: `title`, `url`, `company`, `location`.
- URL di-resolve jadi absolut; link pelacak (`utm_*`, `ref`, `trk`) dibuang dari `canonicalUrl`.
- Teks dibersihkan: whitespace, nbsp, zero-width, ikon dekoratif, badge duplikat.

**AC**
- Record tanpa `title` atau `url` dianggap gagal dan dihitung di `run.stats.failedItems`.
- `url` selalu absolut dan bukan `javascript:`.
- Emoji/aksara non-latin tidak rusak di CSV (UTF-8 BOM).

### FR-3 — Pagination engine (P0)

Strategi yang didukung, dicoba berurutan:

| Strategi | Sinyal deteksi | Aksi |
| --- | --- | --- |
| `next-link` | `a[rel=next]`, teks "Next/Berikutnya/Selanjutnya/›/→" di dalam nav | klik |
| `numbered` | container pagination berisi `a[href*="page"]` / angka | klik halaman berikutnya |
| `url-param` | `?page=`, `?p=`, `?start=`, `?offset=` | navigasi URL (lebih stabil untuk SPA) |
| `load-more` | tombol "Muat lebih/Load more/Show more" | klik sampai tombol hilang |
| `infinite-scroll` | item bertambah setelah scroll | scroll bertahap sampai tidak ada item baru |
| `api-replay` | response JSON berpaginasi tertangkap | ulangi request halaman berikutnya |
| `manual` | tidak ada sinyal jelas | user klik next sendiri; ekstensi merekam |

**Kondisi berhenti (semua wajib ada):**

1. Batas `maxPages` / `maxItems` (default 50 halaman / 5.000 item, bisa diubah).
2. Selector next tidak ada atau `disabled`/`aria-disabled`.
3. Fingerprint daftar identik dua kali berturut-turut (loop / klik tidak berpengaruh).
4. Tidak ada `dedupeKey` baru selama 2 halaman.
5. Redirect ke login, halaman error, atau CAPTCHA terdeteksi → status `needs_attention`.
6. Batas waktu per run (default 15 menit).
7. User menekan Stop.

**AC**
- Setiap strategi punya fixture sendiri dan lulus test tanpa duplikat.
- Infinite scroll berhenti setelah 2 kali "tidak ada item baru" tanpa scroll tak berujung.
- Menutup tab di tengah run tidak membuat data yang sudah masuk hilang.
- Run yang dihentikan tetap menghasilkan partial result yang bisa diekspor.

### FR-4 — Detail crawl (P1)

Untuk field yang hanya ada di halaman detail (deskripsi, requirement, gaji, tipe kerja).

- Detail URL diambil dari `url` record, lalu dikunjungi **berurutan** (default concurrency 1,
  maksimal 2) dengan delay acak 1,5–3 detik.
- Tab dikunjungi di tab yang sama (hidden/background tab) supaya tidak mengganggu user.
- Hasil digabung ke record yang sama (`mergeState: list_only | enriched | failed`).
- Bisa diaktifkan per-run, dengan batas `maxDetails` supaya tidak tak terkendali.

**AC**
- 20 detail page berturut-turut: tidak ada tab nyangkut, tidak ada memory leak > 50 MB.
- Kegagalan satu detail tidak menghentikan run; dicatat dan bisa di-retry terpisah.

### FR-5 — Picker mode: tunjuk list → ambil → copy (P0)

Dua tingkat pengambilan, keduanya tanpa membuka panel dan tanpa reload:

**5A. Ambil satu list**

1. Masuk mode picker: tombol `Pick` di panel/toolbar, shortcut `Alt+Shift+P`, atau long-press ikon.
2. Kursor digerakkan di atas halaman. Elemen di bawah kursor disorot. Setelah kursor berhenti
   120 ms, ekstensi menebak **set item berulang** dari elemen itu (lihat 5C).
3. Semua item dalam set disorot serentak. HUD menampilkan `24 item · 5 field · JSON tersemat`
   plus preview 2 baris.
4. Aksi di HUD: **Ambil 24**, **Copy**, **Pilih manual** (turunkan ke satu item saja).
5. `Enter` = ambil · `Esc` = batal · `[` / `]` = naik/turun satu tingkat set (dari 24 kartu ke
   3 kolom, atau ke 1 kartu) · `Tab` = kandidat set berikutnya · `Shift+Enter` = copy.
6. Setelah diambil, data masuk DB sebagai run kecil **sekaligus** bisa langsung dikopi ke
   clipboard tanpa menunggu panel terbuka.

**5B. Rapikan field**

- Klik satu sel di preview → "jadikan ini kolom X" → mapping diperbarui untuk semua item.
- Kolom bisa diganti nama, disembunyikan, atau dijadikan kunci dedupe.
- Item yang bukan bagian list (iklan, `promoted`, banner) dikecualikan lewat `✕` pada item.
  Pengecualian disimpan sebagai aturan (selector + fingerprint), **bukan index**, supaya tetap
  benar saat list berubah panjang.

**5C. Inferensi set (bagian tersulit, harus benar)**

- Dari elemen hover, naik ke atas dan evaluasi tiap level: jumlah sibling, similaritas skeleton
  DOM (tag + kedalaman + kemiripan token class; teks dan class hasil build diabaikan), panjang
  teks minimal, serta keberadaan link/heading di tiap anak.
- Ambil level dengan skor tertinggi; simpan 3 kandidat teratas untuk `Tab`.
- Kalau halaman punya JSON tersemat/tertangkap yang cocok, **JSON menang**: HUD menampilkan
  `JSON · 11 field` dan copy memakai nilai JSON, bukan teks yang terpotong "Lihat selengkapnya".
- Set yang dipilih harus tahan terhadap item yang tingginya beda (judul 2 baris vs 1 baris).

**AC**
- Hover di 5 fixture (grid, list, table, `<ul>`, card dengan iklan) → set yang disorot benar
  dalam ≤ 200 ms setelah kursor berhenti.
- `[` / `]` mengubah set ke level yang diharapkan di semua fixture; jumlah item di HUD ikut berubah.
- Copy menghasilkan TSV yang ditempel rapi ke Google Sheets: kolom terpisah, tanpa spasi liar,
  tanpa baris kosong.
- Menekan Copy dua kali tidak menggandakan baris.
- Klik di mode picker **tidak pernah** menavigasi halaman atau men-submit form.
- `Esc` mengembalikan halaman persis seperti sebelum picker (semua overlay hilang, event normal).
- Picker di iframe atau shadow DOM tertutup: katakan "tidak didukung", jangan diam.

### FR-5b — Copy cepat & format clipboard (P0)

- Sumber copy: HUD (set terpilih) atau panel (baris yang dicentang / hasil filter).
- Format: **TSV** (default, untuk Sheets/Excel), **Markdown table**, **JSON**, dan **satu kolom**
  (mis. semua URL).
- Copy satu item: hover satu kartu → chip `Copy item` muncul; hasilnya satu baris lengkap.
- Setelah copy: toast `24 baris · TSV` (2 detik), tombol berubah `✓`.
- Clipboard hanya ditulis dari gesture user. Kalau `navigator.clipboard` ditolak, fallback ke
  textarea sementara + `execCommand('copy')`.

**AC**
- Copy 24 baris muncul < 150 ms setelah klik; tidak ada lag di halaman.
- Tempel ke Sheets = 5 kolom rapi, tidak ada baris bergeser.
- Karakter `|` dan newline di judul tetap valid di Markdown (di-escape) dan di TSV (di-quote).

### FR-6 — Normalisasi & transformasi (P1)

Transformasi deklaratif per field, dirangkai dan disimpan di recipe:

| Transform | Contoh |
| --- | --- |
| `trim`, `collapseWhitespace`, `stripTracking` | — |
| `parseSalary` | "Rp 8–12 jt/bln" → `{min: 8000000, max: 12000000, currency: "IDR", period: "month"}` |
| `parseDate` | "3 hari lalu" / "Posted 2d ago" → ISO date + `dateConfidence` |
| `parseExperience` | "3–5 tahun" → `{minYears: 3, maxYears: 5}` |
| `detectWorkMode` | "WFH/Hybrid/On-site/Remote" → enum |
| `splitList` | "React, Vue, Go" → `["React","Vue","Go"]` dengan pemisah yang bisa diatur |
| `regexExtract` | pola user + group |
| `template` | gabung beberapa field |

Semua hasil mentah tetap disimpan di `record.raw` supaya transformasi bisa diulang tanpa scrape ulang.

**AC**
- `parseSalary` lulus ≥ 20 varian format Indonesia + Inggris (jt, juta, mio, K, IDR, SGD, /bln, /bulan, per month, negotiable).
- Nilai yang tidak bisa diparse → `null` + masuk `run.stats.unparsed[field]`, bukan string sampah.
- Mengubah transform lalu "re-process" tidak memicu request jaringan.

### FR-7 — Dedupe & incremental (P1)

- `dedupeKey` = `site + externalId` bila ada; jika tidak, `site + canonicalUrl`; jika tidak,
  hash dari `title|company|location` yang dinormalisasi.
- Database menyimpan key unik per situs, sehingga run berikutnya bisa mode:
  - **append** (simpan semua, tandai duplikat),
  - **skip existing** (hanya item baru),
  - **update** (isi field yang masih kosong).
- Setiap run menyimpan `firstSeenAt` dan `lastSeenAt` per record → bisa menjawab "lowongan baru
  sejak run terakhir".

**AC**
- Scrape halaman yang sama dua kali dengan mode `skip existing` menghasilkan 0 record baru.
- Satu lowongan yang muncul di 2 kota tetap dihitung terpisah hanya jika `location` berbeda.

### FR-8 — Penyimpanan & riwayat (P0)

- Dexie dengan tabel: `runs`, `records`, `recipes`, `adapters`, `captures`, `settings`.
- Setiap run menyimpan: id, recipeId, startUrl, status (`queued|running|paused|done|failed|needs_attention`),
  progres (`page`, `items`, `failedItems`), waktu, error terakhir.
- Retensi default: 90 hari / 200 run, bisa diatur. Ada tombol "hapus semua data".
- Penulisan batch (500 record per transaksi) supaya tidak membekukan UI.

**AC**
- 10.000 record masuk < 5 detik tanpa frame drop di UI.
- SW di-terminate paksa di tengah run → setelah dibuka lagi run berstatus `paused` dan bisa dilanjutkan dari halaman terakhir.

### FR-9 — Export (P0)

- Format file: **CSV** (UTF-8 BOM, delimiter `,`), **JSON** (array of objects), **NDJSON**.
- Format clipboard: TSV, Markdown table, JSON, satu kolom (FR-5b).
- Pilihan kolom, urutan kolom, dan "sertakan kolom mentah".
- Nama file: `{site}-{query}-{yyyyMMdd-HHmm}.csv`.
- Export per run atau seluruh dataset hasil filter.

**AC**
- CSV dengan 5.000 baris < 2 detik; nilai berisi koma/kutip/baris baru tetap valid (dibuka benar di Excel & Google Sheets).
- Export tidak memblokir UI (progress + cancel).
- Baris yang diekspor = baris yang terlihat/terpilih, bukan seluruh isi DB secara diam-diam.

### FR-10 — UI (P0)

Side panel (bukan popup) karena user perlu melihat halaman sambil memantau progres.

- **State kosong:** "Halaman ini belum terdeteksi sebagai daftar" + tombol pilih manual.
- **State siap:** jumlah item, jumlah halaman, preview tabel, tombol Start.
- **State jalan:** progress bar, `hal 4/25`, `118 item`, tombol Pause/Stop, log ringkas.
- Badge ikon: jumlah item pada run aktif.
- Semua state harus bisa dicapai tanpa membaca dokumentasi.

**AC**
- Panel bisa dibuka/tutup tanpa kehilangan run yang sedang jalan.
- Tidak ada layout shift saat data bertambah (tabel pakai virtualisasi kalau > 200 baris).

### FR-11 — Adapter registry & health (P1)

- Adapter bawaan untuk 6 situs target, masing-masing punya `version`, `match` (URL pattern),
  `selectors`, `pagination`, `detail`.
- Adapter di-bundle (bukan diunduh); update lewat rilis ekstensi.
- Health check: kalau adapter menghasilkan 0 item padahal halaman punya list → tampilkan
  "Adapter mungkin sudah usang", tawarkan fallback T1/T2, dan catat ke `adapter_health`.
- Adapter yang sering gagal ditandai di halaman Options.

**AC**
- Adapter yang selectornya sengaja dirusak di fixture memicu peringatan, bukan tabel kosong.

### FR-12 — Izin & onboarding (P0)

- Izin host diminta **saat user menekan Start** di situs tersebut (`optional_host_permissions`),
  dengan penjelasan satu kalimat.
- Onboarding 3 langkah: apa yang dilakukan, data disimpan lokal, cara mencabut izin.
- Menolak izin → ekstensi tetap bisa dipakai di situs yang izinnya sudah ada.

### FR-13 — Cari & filter dataset lokal (P2)

Query tersimpan di atas IndexedDB: teks bebas, filter (lokasi, perusahaan, rentang gaji, work mode,
tanggal), urut, dan "buat recipe dari filter ini". Tanpa server, tanpa index eksternal.

### FR-14 — LLM assist untuk mapping (P2)

Hanya kalau user memasukkan API key sendiri. Kirim **potongan DOM yang sudah disanitasi**
(≤ 20 KB, tanpa cookie/token), minta `FieldMapping` JSON, validasi Zod, tampilkan sebagai saran
yang harus disetujui user. Default mati. Tidak ada data yang dikirim tanpa aksi eksplisit.

---

### FR-15 — Sumber data berlapis: network → embedded → DOM (P0)

Ekstensi tidak boleh berasumsi datanya ada di DOM. Sebelum run, jalankan **probe** dan pilih sumber
terbaik, urut dari yang paling kaya:

| Prioritas | Sumber | Cara ambil | Kekuatan |
| --- | --- | --- | --- |
| 1 | `network` | response `fetch`/XHR JSON yang ditangkap (FR-16) | Paling lengkap: id, gaji, koordinat, field yang tidak dirender |
| 2 | `embedded` | JSON-LD, `__NEXT_DATA__`, `__NUXT__`, `__INITIAL_STATE__`, `<script type="application/json">` | Terstruktur, stabil, tanpa request tambahan |
| 3 | `dom` | selector adapter / inferensi peran (FR-5) | Selalu ada sebagai cadangan |

- Probe melaporkan: sumber terpilih, path array record, jumlah record, field yang tersedia, alasan.
- Panel menampilkan "Sumber: JSON tersemat (24 item, 11 field)" + tombol ganti sumber.
- Pemetaan dari JSON memakai dot-path (`job.company.name`), bukan selector.
- Nilai `null` tidak boleh dikarang jadi string kosong; simpan apa adanya.

**AC**
- Di 5 fixture yang punya `__NEXT_DATA__`, record hasil sumber `embedded` punya ≥ 8 field terisi
  sementara `dom` ≤ 5.
- Probe tidak pernah memilih array yang bukan list (mis. `nav`, `config`) — diuji di 5 fixture negatif.
- User bisa memaksa sumber `dom` dan pilihan itu tersimpan di recipe.
- Kalau JSON ada tapi bentuknya tidak bisa dipetakan, tampilkan alasannya, jangan crash.

### FR-16 — Tangkap & ulang request API (P1)

- Hook `fetch`/XHR di `world: 'MAIN'`, `runAt: 'document_start'`, hanya setelah user menyalakan
  mode ini untuk domain tersebut.
- Kandidat response disaring: `content-type: application/json`, body > 1 KB, mengandung array ≥ 3 objek.
  Yang disimpan hanya **metadata + sample 3 record terpotong**, bukan seluruh body.
- UI "Sumber API": daftar response (URL, method, status, ukuran, jumlah record) → user pilih satu
  → field dipetakan otomatis dari key objek → preview.
- **Replay** untuk pagination: variasi satu parameter (`page`, `offset`, `start`, `cursor`, atau
  `after` di body untuk POST/GraphQL), concurrency 1, delay 1,5–3 detik, backoff saat 429/503.
- Header dan cookie memakai sesi tab itu sendiri; tidak ada header auth yang disalin, disimpan,
  atau dikirim ke tempat lain.

**AC**
- 3 halaman lewat replay menghasilkan set `dedupeKey` yang sama dengan 3 halaman lewat klik DOM.
- Response yang mengandung `access_token`, `password`, atau `authorization` tidak pernah ditawarkan
  sebagai sumber (filter nama key + content-type).
- Mode ini default mati; menyalakannya per domain, dan bisa dimatikan kapan saja.
- Sesi kedaluwarsa (401/403) → run `needs_attention` dengan pesan "muat ulang halaman lalu lanjutkan",
  bukan retry membabi buta.

### FR-17 — Crawl Planner: partisi facet untuk menembus plafon hasil (P1)

Masalah: situs sering membatasi hasil (contoh: 1.000 lowongan) padahal query punya ribuan.
Klik "next" tidak akan pernah sampai ke sana.

1. Probe membaca **total hasil** yang dilaporkan situs (`N`) dan **plafon** yang bisa dijangkau (`C`).
2. Kalau `N ≤ C` → pagination biasa. Selesai.
3. Kalau `N > C` → partisi dengan facet pertama (kota/wilayah), hitung estimasi tiap potongan,
   rekursif ke facet berikutnya (kategori, rentang tanggal, tipe kerja) sampai tiap daun `≤ C`.
4. Kalau tidak ada facet yang memecah (satu bucket tetap > C) → coba jendela tanggal makin sempit
   (30 hari → 7 hari → 24 jam), lalu saran keyword yang lebih spesifik.
5. Plan ditampilkan sebagai pohon dengan estimasi jumlah per cabang **sebelum** dijalankan.
   User bisa mematikan cabang yang tidak relevan.
6. Eksekusi depth-first, dedupe di level record, lalu hitung `coverage = unik ditemukan / N`.

**AC**
- Query dengan `N = 3.400` dan `C = 1.000` menghasilkan ≥ 90% record unik dari total yang
  dilaporkan situs (diuji di 1 situs adapter, dibandingkan dengan hitungan situs).
- Planner tidak pernah memecah ke facet yang menghasilkan 0 hasil berulang (deteksi dead-end).
- Estimasi cakupan diberi label "perkiraan" — tidak pernah ditampilkan sebagai fakta.
- Kalau plafon tidak bisa dideteksi, jatuh ke pagination biasa dan katakan itu.

### FR-18 — Autopilot: dataset tumbuh saat browsing (P1)

- Opt-in **per domain** (bukan global), hanya jalan di halaman yang cocok dengan adapter atau
  terdeteksi sebagai list oleh probe.
- Saat user membuka halaman list: ambil **halaman 1 saja**, dedupe, simpan item baru, badge `+N`.
  Tidak pernah mengklik pagination, tidak pernah membuka tab, tidak pernah jalan di halaman detail.
- Throttle: maksimal 1 capture per domain per 10 menit; total ≤ 200 item/hari/domain.
- Indikator: ikon berubah + status di panel + baris "Autopilot aktif untuk jobstreet.co.id".
- Kill switch global di toolbar dan di `chrome://extensions` (matikan ekstensi = mati total).
- Yang **tidak pernah** disentuh: isian form, cookie, localStorage, teks di luar item list,
  halaman yang butuh login yang belum pernah dibuka user.

**AC**
- Dengan Autopilot mati: 0 penulisan DB dan 0 observer aktif (diverifikasi lewat log run).
- Buka 5 halaman list berurutan → hanya item baru yang masuk, badge menghitung delta dengan benar.
- Halaman selain list (detail, beranda, 404) tidak menghasilkan capture.
- Ada tombol "hapus data domain ini" yang benar-benar menghapus.

### FR-19 — Status lowongan & sinyal lowongan hantu (P2)

- `status`: `active | closed | unknown`. Cek ulang URL secara opt-in (maks 50/hari) atau saat user
  membuka halamannya: 404/410, atau teks "no longer accepting/lowongan ditutup/dipenuhi" → `closed`.
- `signals.ghostScore` (0–100) dari: jumlah repost 30 hari, tanpa gaji, deskripsi < 400 karakter,
  perusahaan agensi yang sama berulang, klaster lintas situs besar.
- Selalu ditampilkan sebagai **sinyal**, bukan tuduhan; ada tooltip penjelasan komponen skor.

### FR-20 — Penggabungan entitas lintas situs (P2)

- Blocking key: `companyNormalized + cityNormalized`; lalu similaritas judul (token Jaccard ≥ 0,8)
  dan overlap deskripsi bila tersedia.
- Hasil: `clusterId`. UI menampilkan "juga di: JobStreet, Glints" dan opsi export satu baris per klaster.
- Wajib ada **unmerge** manual; klaster yang di-unmerge tidak digabung lagi oleh run berikutnya.

**AC**
- Precision ≥ 95% pada 100 pasangan berlabel.
- Dua lowongan berbeda di perusahaan sama dan kota sama tidak tergabung kalau judulnya beda peran.

### FR-21 — Provenance & quality score (P1)

- Tiap record menyimpan `source: { kind, url, capturedAt, adapterId?, confidence }`.
- `qualityScore` 0–100 = field wajib terisi (60%) + field opsional (25%) + keyakinan ekstraksi (15%).
- Panel bisa memfilter "kualitas rendah" dan menampilkan alasan per record (field mana yang kosong).
- "Re-process" menjalankan ulang normalisasi dari `raw` tanpa request jaringan.

**AC**
- 100% record punya provenance dan qualityScore.
- Filter kualitas rendah ≤ 1 detik untuk 10.000 record.

### FR-22 — Insight dari dataset sendiri (P2)

Tiga widget, tidak lebih: distribusi gaji per role+kota (min/median/max dari data sendiri),
perusahaan paling banyak hiring, dan tren item baru per minggu. Setiap angka menampilkan `n`
(jumlah sampel) dan peringatan bias sampling. Tidak ada kesimpulan otomatis.

### FR-23 — Aksi massal (P2)

Pilih baris → buka di tab (maks 10, dengan konfirmasi), tandai sebagai dilamar, sembunyikan,
copy sebagai tabel Markdown. Status lamaran disimpan lokal, tidak pernah dikirim ke mana pun.

## 3. Non-functional requirements

| Area | Requirement |
| --- | --- |
| Kinerja | Deteksi < 300 ms; ekstraksi 500 item < 1,5 s; bundle awal < 400 KB gzip |
| Ketahanan | Run selamat dari SW termination, reload halaman, dan tab ditutup; state di `storage.session` + checkpoint per halaman |
| Idempoten | Menjalankan ulang langkah yang sama tidak menggandakan record |
| Privasi | Tanpa telemetry; tanpa request ke domain pihak ketiga; semua data di IndexedDB/`storage.local` |
| Keamanan | Tidak ada `eval`/`new Function`; HTML dari situs di-render sebagai teks (tidak `innerHTML`); pesan divalidasi Zod |
| Aksesibilitas | Navigasi keyboard di panel, focus ring jelas, kontras ≥ 4.5:1 |
| i18n | String UI di satu file, default `id`, siap `en` |
| Observability | Log run tersimpan (maks 500 baris per run) dan bisa diekspor untuk bug report |

## 4. Data model (ringkas)

```ts
type ID = string;

interface Adapter {
  id: string;                 // "jobstreet"
  version: number;
  match: string[];            // pola URL
  list: { container: string; item: string };
  fields: Record<string, FieldSelector>;   // title, company, location, salary, ...
  pagination: PaginationPlan;
  detail?: DetailPlan;
  verifiedAt: string;         // ISO date, kapan terakhir dites
}

type PaginationPlan =
  | { kind: "next-link"; selector: string }
  | { kind: "numbered"; container: string; item: string }
  | { kind: "url-param"; param: string; start: number; step: number }
  | { kind: "load-more"; selector: string }
  | { kind: "infinite-scroll"; itemSelector: string; settleMs: number }
  | { kind: "api-replay"; urlTemplate: string }
  | { kind: "manual" };

interface FieldSelector {
  selector: string;
  attr?: "text" | "href" | "src" | string;
  transform?: Transform[];
  fallback?: FieldSelector[];
}

interface Recipe {
  id: ID; name: string;
  startUrl: string;
  adapterId?: string;
  mapping: Record<string, FieldSelector>;
  pagination: PaginationPlan;
  options: { maxPages: number; maxItems: number; delayMs: [number, number];
             detailCrawl: boolean; maxDetails: number; dedupeMode: "append" | "skip" | "update" };
  createdAt: string; lastRunAt?: string;
}

interface Run {
  id: ID; recipeId: ID; startUrl: string;
  status: "queued" | "running" | "paused" | "done" | "failed" | "needs_attention";
  page: number;
  stats: { items: number; newItems: number; duplicateItems: number; failedItems: number;
           unparsed: Record<string, number> };
  checkpoint?: { lastUrl: string; lastFingerprint: string; nextCursor?: string };
  error?: { code: string; message: string; at: string };
  startedAt: string; endedAt?: string;
}

interface RecordRow {
  id: ID; runId: ID; site: string;
  dedupeKey: string;              // unique index [site+dedupeKey]
  title: string; url: string; canonicalUrl: string;
  company?: string; location?: string;
  salary?: { min?: number; max?: number; currency?: string; period?: "month" | "year" | "day" };
  workMode?: "remote" | "hybrid" | "onsite" | "unknown";
  postedAt?: string; dateConfidence?: "exact" | "relative" | "unknown";
  experience?: { minYears?: number; maxYears?: number };
  description?: string; tags?: string[];
  raw: Record<string, string>;
  mergeState: "list_only" | "enriched" | "failed";
  source: Provenance;                 // wajib, lihat FR-21
  qualityScore: number;               // 0..100
  status?: "active" | "closed" | "unknown";
  clusterId?: string;
  signals?: { repostCount30d?: number; ghostScore?: number };
  firstSeenAt: string; lastSeenAt: string;
}

type SourceKind = "network" | "embedded" | "dom";

interface Provenance {
  kind: SourceKind;
  url: string;                        // halaman asal
  capturedAt: string;
  adapterId?: string;
  mappingPath?: string;               // dot-path JSON, mis. "props.jobs"
  confidence: number;                 // 0..1
  note?: string;                      // "fallback: adapter selectors yield 0"
}

interface CrawlPlanNode {
  id: ID;
  query: { url: string; facets: Record<string, string> };
  estimatedCount?: number;            // angka dari situs, kasar
  found: number;
  status: "pending" | "running" | "done" | "skipped" | "dead_end";
  children: CrawlPlanNode[];
}

interface AutopilotPolicy {
  domain: string;
  enabled: boolean;
  maxItemsPerDay: number;
  lastCaptureAt?: string;
  createdAt: string;
}
```

## Spesifikasi komponen: Picker HUD

Picker ini adalah **wajah produk**, jadi spesifikasinya selevel komponen, bukan "buat overlay".

**Prinsip:** overlay, bukan halaman. Tidak ada modal, tidak ada reload, tidak ada navigasi.
Dari kursor berhenti → data siap ≤ 1 detik; dari klik → clipboard ≤ 3 detik.

**Lapisan (dari bawah):**

1. Outline item terdeteksi: 2px, warna aksen, radius mengikuti elemen, shadow tipis.
2. Item aktif di bawah kursor: outline 2px lebih tebal + tint 6%.
3. Non-item: turunkan opacity sibling ke 0.55 lewat **satu class di container**, bukan per node.
   Jangan gelapkan seluruh halaman — berat dan bikin pusing.
4. HUD card: `position: fixed`, lebar 300–340px, radius 12px, shadow besar, 8px dari kursor.
5. Toast: kanan bawah, 2 detik, tidak menutupi tombol yang baru diklik.

**State HUD:**

| State | Isi |
| --- | --- |
| `scanning` | "Membaca halaman…" + spinner 12px (maks 400 ms, lalu fallback ke heuristik) |
| `found` | jumlah item besar, chip sumber (`JSON tersemat`/`DOM`), `N field`, preview 2 baris, `Ambil` + `Copy` |
| `empty` | "Tidak ada list berulang di sini" + `Pilih manual` |
| `error` | satu kalimat penyebab + `Coba lagi`, tanpa stack trace |
| `copied` | tombol jadi `✓ 24 baris`, toast format |

**Perilaku yang tidak boleh dilanggar:**

- HUD tidak menutupi item yang sedang di-hover; flip otomatis ke sisi lain.
- HUD tetap di viewport saat scroll; posisi dihitung per frame, bukan per `mousemove`.
- Tidak ada auto-scroll, auto-klik, atau auto-pagination selama picker aktif.
- `Esc` selalu membatalkan, termasuk saat fokus ada di input HUD.
- Semua aksi bisa dijangkau keyboard; tidak ada aksi yang hanya bisa lewat hover.

**Kinerja:** `pointermove` di-throttle ke `requestAnimationFrame`; deteksi di-debounce 120 ms;
hasil skeleton hash di-cache per container; maksimal satu `elementFromPoint` per frame; total JS
per deteksi < 8 ms untuk 2.000 node.

**Aksesibilitas:** `aria-live="polite"` untuk jumlah item; fokus keyboard pindah ke HUD saat aktif;
kontras teks ≥ 4.5:1; `prefers-reduced-motion` mematikan animasi pulse.

**Dilarang eksplisit:** modal full-screen, dimming seluruh halaman, tooltip yang mengejar kursor
dan menutupi target, tombol yang langsung scrape tanpa konfirmasi, dan copy yang mengubah isi
halaman.

## 5. Alur UX

**A. Situs yang sudah didukung**

`buka halaman` → ikon badge menampilkan jumlah item → buka panel → preview + "12 halaman
terdeteksi" → Start → progres live → Done → Export.

**B. Situs baru**

`buka halaman` → panel bilang "belum didukung, tapi ada 24 item mirip" → Start (T1 auto-detect)
→ hasil kasar → "Rapikan field" → visual picker → simpan sebagai recipe.

**C. Adapter rusak**

`Start` → 0 item setelah 1 halaman → banner "selector tidak cocok lagi" → tawarkan T1, tautan
"laporkan" yang melampirkan capture tersanitasi.

## 6. Kegagalan & penanganan

| Kondisi | Perilaku |
| --- | --- |
| Login wall / redirect ke halaman login | `needs_attention`, data parsial disimpan, user diberi tahu |
| CAPTCHA muncul | Berhenti, tidak mencoba melewati |
| Halaman next error 5xx | Retry 2× dengan backoff, lalu `needs_attention` |
| SW mati di tengah run | Checkpoint per halaman; status `paused`; resume manual/otomatis |
| Tab ditutup user | Run `paused`, checkpoint dipakai saat halaman dibuka lagi |
| Selector tidak menemukan apa pun | Fallback T1, catat `adapter_health` |
| Data membengkak (> 5.000 item) | Tetap jalan, UI pakai virtualisasi, tulis batch |
| Kuota storage penuh | Berhenti dengan pesan jelas + tautan hapus data lama |
| Response API berubah bentuk | Probe gagal → fallback ke `embedded`/`dom`, catat `sourceMismatch` |
| Sesi API kedaluwarsa (401/403) | `needs_attention`, minta user reload, checkpoint disimpan |
| Situs membatasi laju (429) | Backoff eksponensial 2×, 3 percobaan, lalu berhenti dengan pesan |
| Planner menghasilkan bucket kosong berulang | Tandai `dead_end`, jangan rekursi lagi |
| Autopilot menangkap halaman yang sama berulang | Throttle per domain + fingerprint halaman |
| Capture HTML memenuhi kuota | Evict capture tertua dulu, jangan hapus record |

## 7. Risiko & kepatuhan

1. **Kebijakan Chrome Web Store.** Scraper + host permission luas = risiko review. Mitigasi:
   `activeTab` + optional host permission per situs, justifikasi izin di deskripsi listing,
   privacy policy, tidak ada remote code, tidak ada fitur "unduh data orang lain".
2. **ToS situs.** Beberapa situs melarang pengambilan data otomatis. Posisi produk: alat bantu
   user atas data yang dia lihat sendiri; tidak ada login otomatis, tidak ada bypass, rate limit
   sopan, dan tidak ada redistribusi data. Cantumkan peringatan di onboarding + dokumentasi.
3. **Selector cepat usang.** Mitigasi: adapter ber-versi, health check, fallback berlapis,
   fixture test per situs.
4. **Data pribadi.** Scraping lowongan bisa memuat nama/email rekruter. Mitigasi: field PII
   tidak diekstrak secara default, ada tombol "hapus data", retensi terbatas.
5. **Performa di halaman berat.** Mitigasi: batasi observer, `requestIdleCallback` untuk kerja
   non-kritis, matikan observer setelah run selesai.
6. **Kualitas data.** Mitigasi: `raw` selalu disimpan, metrik `unparsed` per field, preview
   sebelum export.

## 8. Acceptance criteria rilis v1 (checklist)

- [ ] Auto-detect list akurat di 5 fixture + 3 situs live.
- [ ] Pagination `next-link`, `numbered`, `load-more`, `infinite-scroll` lulus test.
- [ ] Stop condition lengkap; tidak ada infinite loop pada fixture "next yang tidak berpindah".
- [ ] Run 10 halaman di satu situs target selesai tanpa intervensi, 0 duplikat.
- [ ] Resume setelah SW termination terbukti (dites dengan mematikan SW manual).
- [ ] Export CSV/JSON/NDJSON valid dan bisa dibuka di Excel, Sheets, dan `jq`.
- [ ] Permission flow: instalasi bersih → hanya `activeTab` + storage → izin situs diminta saat Start.
- [ ] Visual picker bisa memperbaiki satu field yang salah di situs baru.
- [ ] Tidak ada request jaringan keluar selain ke situs target (dicek di DevTools).
- [ ] `unlimitedStorage` dipakai hanya kalau dataset > 100 MB (atau dijelaskan di listing).
- [ ] Pada 3 situs target, sumber `embedded`/`network` terpilih otomatis dan menghasilkan field
      lebih banyak daripada `dom` (dibuktikan dengan tabel perbandingan di PR).
- [ ] Crawl Planner menembus plafon di 1 situs: coverage ≥ 90% dari total yang dilaporkan.
- [ ] Autopilot: opt-in per domain, badge delta benar, 0 capture saat dimatikan, kill switch bekerja.
- [ ] Setiap record punya `provenance` + `qualityScore`; filter kualitas rendah bekerja.
- [ ] Penggabungan entitas: precision ≥ 95% pada sampel berlabel; unmerge tidak dibatalkan run berikutnya.
- [ ] Tidak ada request ke domain pihak ketiga, termasuk saat probe dan replay (dicek via DevTools
      + `chrome.debugger` atau log network).

## 9. Di luar cakupan v1 (dan siapa yang memutuskan kalau mau ditambah)

Scheduling penuh via `chrome.alarms` (risiko review), integrasi Google Sheets/Notion/Airtable
(membutuhkan OAuth per provider), LLM assist di jalur utama, build Firefox, marketplace adapter,
kolaborasi/tim, API publik, dan sinkronisasi cloud. Semua ini menambah permukaan izin dan
permukaan review; jangan dimasukkan tanpa alasan yang lebih kuat daripada "terlihat keren".
