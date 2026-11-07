# scraperGOD

Ekstensi Chrome untuk mengambil daftar dari halaman web — lowongan, film, produk,
hasil pencarian — lalu menyimpannya sebagai tabel yang bisa diekspor ke CSV/JSON.
Semua proses berjalan di browser kamu sendiri.

Bedanya dengan "selektor CSS" biasa: kamu cukup **menunjuk** satu kartu di daftar
dan ekstensi menebak seluruh daftarnya, termasuk kolom di dalamnya (judul, harga,
lokasi, tanggal, dan seterusnya). Kalau daftarnya punya halaman berikutnya,
ekstensi melanjutkan sendiri sampai batas yang kamu tentukan.

---

## Fitur

**Pemilihan tanpa konfigurasi**

- Arahkan kursor ke satu kartu → seluruh daftar tersorot, HUD menampilkan jumlah
  item dan pratinjau 2 baris.
- Level daftar bisa dinaikkan/diturunkan (`‹` `›`) kalau tebakan awal terlalu
  sempit atau terlalu lebar.
- Pilih pakai mouse saja: **klik** = kunci daftar, **dobel klik** = ambil.
- Tombol melayang di kanan bawah sebagai pintu masuk; bisa disembunyikan lewat
  tombol **×** kecil pada ikon itu, atau dari side panel. Menu **klik kanan**
  juga membuka picker (tanpa bentrok dengan shortcut ekstensi lain).

**Sumber data yang dipakai berlapis**

1. **DOM** — teks yang terlihat, dengan pemetaan kolom otomatis.
2. **JSON tersemat** — `JSON-LD`, `__NEXT_DATA__`, dan blob JSON lain di halaman.
3. **API situs** — `fetch`/XHR yang direkam di MAIN world. Kalau halaman mengambil
   datanya dari API, yang disimpan adalah record aslinya, bukan teks hasil render.

**Pagination**

- Link/teks "berikutnya", termasuk tebakan dari parameter URL (`?page=2`, `/page/2/`).
- Tombol **"muat lebih banyak"** (disaring: tombol tersembunyi, form, teks berbahaya,
  dan tautan yang berpindah dokumen tidak diklik).
- **Infinite scroll** — menggulir untuk memancing item baru, dengan batas waktu jelas.
- **Replay API** — GET, POST, dan GraphQL, termasuk pagination berbasis **cursor**.
- Berhenti sendiri saat halaman berulang, item baru habis, target item tercapai,
  atau server menolak (403/captcha/login) — dengan alasan yang ditampilkan di panel.
- Jeda antar-halaman, backoff eksponensial untuk 429/503, satu permintaan sekaligus.

**Penyimpanan dan ekspor**

- Hasil setiap pengambilan disimpan sebagai **run** di IndexedDB lokal; bisa
  diintip di side panel, dilanjutkan, dan diekspor kapan saja.
- **Ekspor CSV**, **JSON**, dan **salin tabel ke clipboard** (TSV, langsung tempel
  ke Google Sheets/Excel).
- Dedupe berdasarkan URL, penanda item baru antar-run, dan early-stop "halaman
  isinya sudah dikenal".
- **Recipe per situs**: pilihan daftar terakhir dipakai ulang, jadi pengambilan
  berikutnya di situs yang sama tidak perlu menebak lagi.
- Kolom bisa di-rename, diurutkan ulang, dan dibuang; setelan disimpan per situs.
- **Diagnosa pagination**: satu tombol untuk melihat jalur mana yang akan dipakai
  (API / muat lebih / link berikutnya / scroll) beserta alasan yang ditolak,
  lengkap dengan "Salin laporan".

---

## Pasang

### Dari source (mode pengembang)

```bash
npm install
npm run build
```

Lalu di Chrome:

1. Buka `chrome://extensions`
2. Nyalakan **Developer mode**
3. **Load unpacked** → pilih folder `.output/chrome-mv3`

Untuk pengembangan dengan hot reload: `npm run dev`, lalu muat folder
`.output/chrome-mv3-dev`.

> Nama ekstensi mengikuti **nama folder proyek** (`wxt.config.ts`). Ganti nama
> folder sebelum build kalau ingin nama lain di `chrome://extensions`.

### Untuk orang lain

Kirim folder `.output/chrome-mv3` (hasil `npm run build`) atau zip-nya
(`npm run zip`), lalu mereka mengulang langkah **Load unpacked** di atas.
Cara ini tidak butuh akun developer Chrome Web Store.

---

## Pakai

1. Buka halaman berisi daftar, misalnya hasil pencarian lowongan.
2. Klik ikon scraperGOD → **Buka panel pengambilan**, atau klik kanan di halaman →
   **Mulai picker**.
3. Arahkan kursor ke satu kartu sampai seluruh daftar tersorot.
4. **Klik** kartu untuk mengunci pilihan, lalu tekan **Ambil** di HUD.
   Kalau daftarnya lebih dari 20 item, muncul dialog: ambil halaman ini saja, atau
   tetapkan target dan lanjut ke halaman berikutnya.
5. Buka side panel untuk melihat hasil, merapikan kolom, lalu **Ekspor CSV/JSON**
   atau **Salin tabel**.

### Tombol picker

| Aksi | Hasil |
| --- | --- |
| Gerakkan kursor | Sorot daftar + pratinjau di HUD |
| Klik kartu | Kunci daftar (sorotan berhenti mengikuti kursor) |
| Dobel klik kartu | Ambil langsung |
| `‹` `›` di HUD | Ganti level daftar |
| `Ambil N` | Simpan item halaman ini |
| `Copy` | Salin tabel sebagai TSV |
| `Lepas` | Lepas kunci, sorotan mengikuti kursor lagi |
| `Esc` | Keluar dari picker |

Selama picker aktif, klik/link/form/keyboard situs ditahan supaya tidak ada yang
terbuka tidak sengaja. Scroll tetap bisa dipakai untuk melihat item lain.

---

## Batas dan hal jujur

- Semua diproses lokal: tidak ada server, tidak ada akun, tidak ada data keluar
  dari browser. Detail di [PRIVACY.md](PRIVACY.md).
- Halaman yang butuh login tetap bisa dibaca, karena ekstensi memakai sesi
  browser kamu — tapi patuhi ketentuan layanan situsnya.
- Kalau situs berhenti karena captcha, 403, atau diminta login, run **berhenti**
  dan memberi alasan. Ekstensi tidak mencoba menembusnya.
- Daftar *virtualized* (item lama dibuang dari DOM saat scroll) bisa membuat hasil
  bolong; ekstensi memberi peringatan, bukan diam-diam menganggap selesai.
- Belum ada sinkronisasi antar-perangkat, tema terang, atau penjadwalan otomatis
  di latar belakang.
- Pagination API yang memakai token CSRF akan dijeda dengan pesan jelas: muat
  ulang halaman, lalu **Lanjutkan**. Token tidak pernah disimpan.

---

## Pengembangan

```bash
npm run dev        # jalankan WXT dengan hot reload
npm run compile    # tsc --noEmit
npm test           # vitest
npm run build      # build produksi ke .output/chrome-mv3
npm run zip        # paket zip untuk distribusi
```

Struktur singkat:

```
entrypoints/       background (SW), content script, MAIN world hook, popup, side panel
src/core/          logika murni: probe, engine run, store, ekspor (tanpa DOM global)
src/picker/        inferensi daftar, HUD, recipe, launcher
src/net/           hook fetch/XHR, jembatan halaman, pagination API
src/messaging/     protokol pesan antar-bagian
tests/             unit test + fixture HTML
```

Aturan main proyek ini (invarian §9): state run hidup di
Dexie (bukan variabel global service worker), `src/core/**` tetap murni dan bisa
dites tanpa browser, dan satu halaman selalu ditulis dalam satu transaksi.

---

## Distribusi

Rilis resmi ada di halaman **GitHub Releases**: unduh zip, ekstrak, lalu
**Load unpacked** di `chrome://extensions` (Developer mode harus menyala).

Kalau suatu hari mendaftar ke Chrome Web Store (butuh biaya pendaftaran developer
$5 sekali), teks listing dan justifikasi izin sudah siap di
[PUBLISH.md](PUBLISH.md).

---

## English

**scraperGOD** is a Chrome extension that turns a listing page into a table. You point at one card in the list and the extension infers the whole list, including the fields inside each card.

Results can be exported to CSV or JSON, and everything runs in your own browser.

---

## Lisensi

MIT — lihat [LICENSE](LICENSE).
