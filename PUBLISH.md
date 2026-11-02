# Publikasi ke Chrome Web Store

Dokumen ini berisi apa yang perlu disiapkan **sebelum** menekan Publish, plus
teks siap tempel. Tidak ada langkah otomatis di sini.

## 1. Yang harus ada di repo

- [x] `README.md` — cara pasang dan pakai
- [x] `PRIVACY.md` — wajib untuk listing (harus bisa diakses lewat URL publik)
- [x] `LICENSE` — MIT, ada di root repo (ganti kalau mau lisensi lain)
- [ ] Screenshot 1280×800 (minimal 1, ideal 3–5)
- [ ] Gambar promo kecil 440×280 (opsional, memperbaiki tampilan listing)
- [ ] Ikon 128×128 sudah ada di `public/icon/128.png`

## 2. Versi dan build

```bash
# naikkan versi di package.json (semver: 0.1.0 → 0.1.1 untuk perbaikan)
npm run compile
npm test
npm run build
npm run zip
```

Zip hasil build ada di folder `.output/`. **Yang diunggah adalah zip itu**, bukan
folder `.output/chrome-mv3`.

Nama ekstensi diambil dari nama folder proyek (`wxt.config.ts`). Sebelum build
rilis, pastikan folder proyek sudah bernama seperti yang diinginkan, atau ganti
`manifest.name` di `wxt.config.ts` menjadi nama tetap.

## 3. Daftar di Chrome Web Store Developer Dashboard

1. Bayar biaya pendaftaran satu kali (akun developer).
2. **New item** → unggah zip.
3. Isi listing dengan teks di bawah.
4. Isi **Privacy practices** (jawaban di bagian 4).
5. Isi **Permission justification** (bagian 5).
6. Tambahkan URL kebijakan privasi — hasil hosting `PRIVACY.md` (GitHub Pages,
   repo publik, atau halaman statis apa pun).
7. Simpan sebagai draft, lalu **Submit for review**.

## 4. Teks listing

**Nama:** scraperGOD

**Ringkasan (maks 132 karakter):**

```
Tunjuk satu kartu, ambil seluruh daftar beserta halaman berikutnya, lalu ekspor ke CSV atau JSON.
```

**Deskripsi:**

```
scraperGOD mengubah daftar di halaman web menjadi tabel yang bisa diekspor.

Tunjuk satu kartu — lowongan, film, produk, hasil pencarian — dan ekstensi
menebak seluruh daftarnya beserta kolom di dalamnya. Tidak perlu menulis
selektor CSS.

Yang bisa dilakukan:
• Memilih daftar dengan mouse: hover untuk menyorot, klik untuk mengunci,
  dobel klik untuk mengambil.
• Mengambil data dari DOM, JSON tersemat (JSON-LD, __NEXT_DATA__), atau API
  situs yang sedang dipakai halaman.
• Melanjutkan ke halaman berikutnya: link "next", tombol "muat lebih banyak",
  infinite scroll, dan replay API (GET, POST, GraphQL, cursor).
• Berhenti sendiri saat halaman berulang, item baru habis, target tercapai,
  atau situs menolak (403/captcha/login).
• Menyimpan hasil sebagai run, menggabungkan URL ganda, dan menandai item baru
  antar-pengambilan.
• Ekspor CSV/JSON atau salin tabel langsung ke spreadsheet.
• Recipe per situs: pilihan daftar terakhir dipakai ulang, kolom bisa diganti
  nama dan diurutkan.
• Diagnosa pagination: lihat jalur mana yang dipakai dan mengapa yang lain
  ditolak.

Semua data tetap di browser kamu. Tidak ada server, tidak ada akun, tidak ada
pelacakan.
```

**Kategori:** Productivity / Developer Tools

**Bahasa:** Indonesia

## 5. Jawaban Privacy practices

- **Single purpose:** mengambil daftar item dari halaman yang dipilih user dan
  menyimpannya sebagai tabel yang bisa diekspor.
- **Data yang dikumpulkan:** tidak ada data user yang dikirim ke pengembang.
  Hasil pengambilan disimpan lokal di perangkat.
- **Penjualan data ke pihak ketiga:** tidak.
- **Penggunaan untuk tujuan yang tidak terkait:** tidak.
- **Kode remote:** tidak ada. Seluruh kode ikut dalam paket ekstensi.

## 6. Justifikasi izin (siap tempel)

| Izin | Alasan |
| --- | --- |
| `storage` | Menyimpan setelan kolom per situs, recipe daftar, dan status perekaman API. |
| `activeTab` | Membaca halaman aktif hanya ketika user menjalankan picker atau pengambilan. |
| `scripting`/host akses halaman | Menyuntik content script ke halaman yang dipilih user (lewat `matches` content script, bukan injeksi otomatis ke semua tab). |
| `sidePanel` | Menampilkan pratinjau hasil, progres run, dan tombol ekspor. |
| `contextMenus` | Menyediakan menu klik kanan "Mulai picker" sebagai pintu masuk tanpa shortcut keyboard. |
| `alarms` | Menjaga run tetap berjalan saat service worker MV3 diistirahatkan Chrome. |

Catatan untuk reviewer: tidak ada permintaan jaringan ke domain pengembang.
Permintaan HTTP hanya dilakukan ke origin situs yang sedang dibuka user, memakai
sesi browser user sendiri, untuk melanjutkan pagination yang sudah ada di halaman.

## 7. Setelah terbit

- Perbaikan kecil: naikkan versi patch, `npm run zip`, unggah, submit ulang.
- Jangan menghapus item untuk mengganti versi — selalu unggah ke item yang sama.
- Simpan catatan perubahan per versi di `CHANGELOG.md` bila mulai sering rilis.
- Uji ulang checklist manual berikut pada 2–3 situs berbeda sebelum tiap rilis:
  picker muncul dan menyorot, Ambil menyimpan, dialog target berjalan, run
  melanjutkan halaman, ekspor CSV/JSON terbuka benar.
