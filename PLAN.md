# PLAN — ScrapeKit

> Urutan eksekusi untuk versi "GOD". Angka = hari kerja fokus, 1 orang. Kalau waktu cuma
> 2 jam/hari, kalikan ~2,5.

## 1. Strategi

Ada tiga lapis nilai, dan urutannya tidak boleh dibalik:

1. **Engine yang tidak bohong** — kalau run mati di tengah jalan atau pagination diam-diam
   kehilangan halaman, semua fitur di atasnya tidak berarti. Ini fondasi.
2. **Data yang layak dipercaya** — sumber terbaik, normalisasi, provenance, dedupe. Ini yang
   membuat orang memakai hasilnya untuk keputusan.
3. **Taruhan produk** — planner, Autopilot, penggabungan lintas situs. Ini yang membuat orang
   tidak bisa pindah ke ekstensi lain.

Aturan main:

- Bangun satu jalur tipis end-to-end dulu (probe → ambil → halaman 2 → simpan → export).
- Adapter situs ditambahkan **setelah** engine generik stabil; kalau tidak, engine akan ditambal
  untuk satu situs dan rusak di situs lain.
- Fixture HTML/JSON disimpan sebelum parser ditulis. Test dulu, selector kemudian.
- Setiap fase harus punya demo yang bisa dijalankan, bukan "tinggal rapikan".

## 2. Fase

### Fase 0 — Fondasi (1 hari)

- `npx wxt@latest init` → React + TypeScript.
- Tailwind v4 via `@tailwindcss/vite`, alias `@/`.
- ESLint, Prettier, `tsc --noEmit`, Vitest, script `dev`/`build`/`zip`.
- Manifest: `sidePanel`, `activeTab`, `scripting`, `storage`, `downloads`, `alarms`,
  `optional_host_permissions: ["<all_urls>"]`.
- `CONTEXT.md`/`DRD.md`/`PLAN.md` commit pertama.

**DoD:** side panel kosong jalan, tanpa error konsol, `npm run build` menghasilkan zip.

### Fase 1 — Jalur tipis multi-sumber (7–8 hari)

Target: satu situs nyata, ambil 3 halaman via sumber terbaik, export CSV, run tahan mati.

1. **Tipe + Zod** — `RecordRow`, `Recipe`, `Run`, protokol pesan. Satu file sumber kebenaran.
2. **DB** — Dexie di SW, repo `runs/records/recipes/adapters/settings`, transaksi batch.
3. **Run engine durable** (FR-8) — job queue dengan `lease`, checkpoint per langkah, resume saat
   SW start / pesan masuk. Ini dikerjakan lebih awal daripada UI.
4. **Source probe** (FR-15) — deteksi JSON-LD, `__NEXT_DATA__`, `__NUXT__`, `__INITIAL_STATE__`,
   `<script type="application/json">`; fallback ke heuristik list DOM; laporkan sumber + alasan.
5. **Ekstraksi** — dot-path mapper untuk JSON; DOM reader + pembersihan teks untuk fallback.
6. **Pagination v1** — `next-link`, `numbered`, `load-more`; stop condition dasar (next hilang,
   fingerprint sama, maxPages/maxItems).
7. **UI v1** — side panel (preview, sumber terpilih, Start/Stop, progres) + **in-page collect bar**
   (jumlah item + satu tombol Start) supaya user tidak perlu buka panel dulu.
7b. **Picker mode** (FR-5A/5C, FR-5b) — overlay di shadow DOM, hit-test, inferensi set berulang
   (`[`/`]` pindah level), HUD dengan jumlah + preview 2 baris, aksi Ambil/Copy, TSV ke clipboard
   dengan fallback `execCommand`, dan semua state (`scanning/found/empty/error/copied`).
   Ini fitur yang paling sering dipakai, jadi dikerjakan di fase ini — bukan nanti.
8. **Export** — CSV/JSON lewat offscreen document (SW tidak punya `URL.createObjectURL`).

**DoD:** 3 halaman → CSV valid; panel menunjukkan sumber data yang dipakai; hover list → HUD →
Copy TSV benar dalam ≤ 3 detik dan ditempel rapi ke Sheets; klik saat picker tidak pernah
menavigasi; SW dimatikan paksa di tengah run → status `paused`, resume 0 duplikat.

### Fase 2 — Data yang layak dipercaya (5–6 hari)

9. **Infinite scroll + SPA route change** (FR-3).
10. **Picker lanjutan** (FR-5B) — remap per sel (klik sel → "jadikan kolom ini"), exclude item
    iklan berbasis fingerprint, rename/hide kolom, copy Markdown/JSON, plus golden test inferensi
    set di 5 fixture.
11. **Adapter framework + 2 adapter** (FR-11) — JobStreet & Glints (lihat §6).
12. **Detail crawl** (FR-4) — antrean, tab background, delay acak, merge, retry terpisah.
13. **Normalisasi** (FR-6) — `parseSalary`, `parseDate`, `parseExperience`, `detectWorkMode`.
14. **Dedupe + incremental + diff view** (FR-7) — `skip existing`, `firstSeenAt`, tampilan
    "12 baru / 5 hilang" versus run sebelumnya.
15. **Provenance + quality score** (FR-21) — termasuk filter kualitas rendah dan re-process dari `raw`.

**DoD:** 10 halaman + 30 detail selesai tanpa intervensi; run kedua `skip existing` = 0 duplikat;
100% record punya provenance; gaji terstruktur benar ≥ 90% sampel.

### Fase 3 — Tiga taruhan (9–11 hari)

16. **Network capture + API replay** (FR-16) — hook `fetch`/XHR `world: 'MAIN'`, UI pemilihan
    response, auto-map key, replay dengan satu parameter yang divariasikan.
17. **Autopilot** (FR-18) — opt-in per domain, capture halaman 1, badge delta, throttle, kill switch.
18. **Crawl Planner** (FR-17) — probe total & plafon, partisi facet rekursif, pohon plan dengan
    estimasi, eksekusi depth-first, coverage report.
19. **Penggabungan entitas lintas situs** (FR-20) — blocking + similarity + clusterId + unmerge.
20. **Status lowongan + sinyal hantu** (FR-19) — opt-in re-check, ghostScore sebagai sinyal.
21. **Insight** (FR-22) + **aksi massal** (FR-23) — tiga widget saja, buka tab massal, status lamaran.

**DoD:** replay API = hasil identik dengan DOM; Autopilot mengumpulkan item baru tanpa klik;
Planner mencapai ≥ 90% coverage di satu situs; precision cluster ≥ 95%.

### Fase 4 — Rilis & operasional (2–3 hari)

22. Permission flow + onboarding (FR-12), privacy policy, halaman justifikasi izin.
23. Fixture mining: tombol "laporkan adapter rusak" yang menyimpan capture tersanitasi + log run.
24. Store submission, screenshot, deskripsi, penanganan review.
25. Dokumentasi user singkat (satu halaman) + halaman "batas & etika" di Options.

## 3. Urutan & dependensi

```
F0 scaffold
 └─ F1.1 types ─┬─ F1.2 DB ─┬─ F1.3 run engine ─┬─ F1.7 UI ─ F1.8 export   → DEMO
                │           │                    │
                └─ F1.4 probe ─ F1.5 extract ─ F1.6 pagination ──┘
                                        │
F2.9 infinite scroll ───────────────────┤
F2.10 picker ─ F2.11 adapters ─ F2.12 detail ─ F2.13 normalize ─ F2.14 dedupe ─ F2.15 provenance
                                        │
F3.16 network/replay ───────────────────┤
F3.17 autopilot ────────────────────────┤
F3.18 planner (butuh probe + pagination + adapter facet)
F3.19 cluster (butuh data terkumpul dari >1 situs)
```

Critical path: **F1.2 → F1.3 → F1.6**. Kalau dua hari pertama F1.3 belum terbukti tahan SW
termination, hentikan semua fitur lain.

Urutan yang disarankan untuk demo cepat (kalau butuh sesuatu yang "wow" di minggu pertama):
F1 selesai → F3.17 Autopilot → F1.7 polish. Autopilot tidak butuh planner dan langsung terasa.

## 4. Spike wajib (masing-masing ≤ 3 jam, sebelum kode fitur)

| # | Pertanyaan | Cara uji | Kalau gagal |
| --- | --- | --- | --- |
| S1 | State run pulih setelah SW di-terminate? | `chrome://serviceworker-internals` → Stop, cek DB | Pindahkan orchestrator ke offscreen document |
| S2 | 10k record masuk tanpa freeze? | Benchmark Dexie `bulkPut` 500/transaksi | Perkecil batch, pindah tulis ke offscreen |
| S3 | Infinite scroll bisa dideteksi "selesai"? | 2 situs live, ukur item vs waktu | `MutationObserver` + batas waktu + stop manual |
| S4 | Hook `fetch` di `world: 'MAIN'` tembus di situs target? | Injeksi 3 situs, cek response tertangkap | Andalkan `embedded` JSON, replay ditunda |
| S5 | Autopilot bisa lolos review store? | Baca policy + submit build percobaan lebih awal | Jadikan fitur opt-in yang lebih eksplisit / tunda |
| S6 | Partisi facet benar-benar disjoint & menjumlah? | 2 situs, bandingkan `count(facet_a) + count(facet_b)` vs `count(all)` | Planner hanya pakai facet yang terverifikasi per adapter |
| S7 | Parameter pagination API bisa diprediksi? | 3 situs, ubah `page`/`offset`, bandingkan hasil | Batasi replay ke situs yang lolos saja |
| S8 | Similaritas judul cukup akurat? | 50 pasangan berlabel, hitung precision | Naikkan threshold, tambah sinyal perusahaan/deskripsi |
| S9 | Overlay picker aman di halaman nyata? | 5 situs: fixed header, iframe, shadow DOM, scroll hijack, `pointer-events` | Batasi ke dokumen utama, laporkan "tidak didukung" |
| S10 | Clipboard bisa ditulis dari content script? | Uji `navigator.clipboard` + fallback `execCommand` di 5 situs, termasuk yang `document`-nya tidak fokus | Tulis lewat offscreen document, atau tampilkan tombol "salin manual" |

S5 sebaiknya dijalankan **sebelum** Fase 3, bukan sesudah — kalau Autopilot tidak bisa lolos
review, kita tidak mau menghabiskan 6 hari membangunnya.

## 5. Struktur folder target

```
scrapekit/
├─ wxt.config.ts
├─ entrypoints/
│  ├─ background.ts              # run engine, DB, router pesan
│  ├─ sidepanel/                 # React app utama
│  ├─ popup/                     # status + kill switch Autopilot
│  ├─ options/                   # data, izin, retensi, adapter health, etika
│  ├─ offscreen/                 # DOMParser, CSV blob, export
│  └─ content/
│     ├─ index.ts                # isolated: in-page bar, extract, klik next
│     └─ main-world.ts           # MAIN: hook fetch/XHR (opt-in)
├─ src/
│  ├─ core/
│  │  ├─ probe/                  # pemilihan sumber: network|embedded|dom
│  │  ├─ source/                 # json-path mapper, dom reader, normalize text
│  │  ├─ detect/                 # skoring kandidat list, JSON-LD
│  │  ├─ paginate/               # strategi + stop conditions
│  │  ├─ plan/                   # crawl planner, facet recursion, coverage
│  │  ├─ run/                    # durable queue, lease, checkpoint, resume
│  │  ├─ store/                  # dexie schema, repos, migration, eviction
│  │  ├─ normalize/              # salary, date, experience, workMode
│  │  ├─ resolve/                # dedupe, cluster, ghost signals
│  │  ├─ export/                 # csv/json/ndjson
│  │  └─ insight/                # percentile, tren, agregasi lokal
│  ├─ picker/                   # overlay, hit-test, inferensi set, HUD, copy
│  ├─ autopilot/                 # policy, throttle, badge, kill switch
│  ├─ adapters/                  # satu file per situs + registry
│  ├─ messaging/                 # protokol + zod
│  ├─ ui/                        # komponen, hooks, styles
│  └─ shared/                    # types, constants, i18n
├─ tests/
│  ├─ fixtures/<site>/*.html|json
│  └─ unit|integration
└─ public/icon/
```

## 6. Prioritas situs target

Urutan berdasar struktur ramah + relevansi pasar ID:

1. **JobStreet** — list jelas, pagination nomor, JSON tersemat. Adapter pertama.
2. **Glints** — SPA, data bagus, cocok untuk uji `embedded`/`network`.
3. **Kalibrr** — sederhana, untuk memastikan engine tidak overfit ke dua situs pertama.
4. **Dealls** — "load more", uji strategi tombol.
5. **LinkedIn Jobs** — paling ketat (login + anti-bot). Jangan jadi target pertama, jangan
   dibangun dengan asumsi bypass; kalau terdeteksi menolak, berhenti dan bilang.
6. **Indeed** — agresif ke otomasi. Paling akhir, atau lewati.

Fase 2 cukup 2 situs. Sisanya setelah engine stabil.

## 7. Kalau waktu mepet: urutan yang dipotong

Potong dari bawah, jangan dari atas:

1. Insight (FR-22) dan aksi massal (FR-23).
2. Sinyal lowongan hantu (FR-19).
3. Penggabungan entitas (FR-20) — dataset masih berguna tanpa ini, cuma lebih kotor.
4. Crawl Planner (FR-17) — turunkan jadi "split manual per kota" yang user isi sendiri.
5. Detail crawl (FR-4).
6. Autopilot (FR-18).

Yang **tidak boleh** dipotong: picker dasar (7b), durable run engine, provenance, stop condition
pagination, export. Picker adalah alasan user mencoba ekstensi ini di tempat pertama.
Tanpa itu produknya bohong.

## 8. Definition of done per fase

- Demo jalan, test lulus, tidak ada `TODO` di jalur kritis.
- `DRD.md` diperbarui kalau perilaku berubah.
- Adapter baru wajib membawa: fixture, test 1 halaman + 1 pagination, `verifiedAt`.
- Rilis v1 hanya kalau checklist `DRD.md` §8 tercentang (termasuk bukti coverage & precision).

## 9. Metrik yang dipantau (lokal, tanpa telemetry)

- `successRate` per adapter dan per sumber (`network`/`embedded`/`dom`).
- `itemsPerPage`, `pagesPerRun`, `coverage`, `duplicatesRate`.
- `unparsed` per field — indikator normalizer kurang.
- `needs_attention` per 100 run — indikator situs berubah.
- Autopilot: item baru/hari, jumlah domain opt-in, jumlah capture dibatalkan throttle.
- Cluster: jumlah cluster multi-situs, jumlah unmerge (kalau tinggi → threshold terlalu agresif).

## 10. Pertanyaan yang harus dijawab sebelum Fase 3

1. Apakah Autopilot boleh aktif default setelah user memilih domain, atau harus toggle eksplisit
   per domain setiap kali? (Rekomendasi: opt-in eksplisit, ingat per domain.)
2. Kalau Planner menemukan 40 sub-query, jalankan semua atau batasi (mis. 15) dan laporkan
   sisanya sebagai "belum tercakup"?
3. Penggabungan entitas: tampilkan satu baris per klaster secara default, atau simpan sebagai
   catatan "juga di" dan biarkan baris per situs?
4. Nama produk final.
5. Target persona utama menentukan bobot UI: job seeker (filter, lamaran, buka tab) vs peneliti
   (export, coverage, insight).

## 11. Estimasi total

| Fase | Hari |
| --- | --- |
| F0 | 1 |
| F1 | 7–8 |
| F2 | 5–6 |
| F3 | 9–11 |
| F4 | 2–3 |
| **Total** | **24–29 hari fokus** |

Versi "scraper bagus" (F0–F2 tanpa taruhan) sekitar 14–16 hari. Taruhan menambah ~10 hari dan
itu bagian yang membuat produk ini punya alasan untuk ada.

Catatan jadwal: picker (7b) terlihat seperti "fitur UI kecil" tapi sebenarnya 40% dari persepsi
kualitas produk. Kalau harus memilih antara picker dan Autopilot di minggu yang sama, pilih
picker.
