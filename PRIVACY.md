# Kebijakan Privasi — scraperGOD

Terakhir diperbarui: 2 November 2026

scraperGOD adalah ekstensi Chrome yang mengambil daftar dari halaman web yang
sedang kamu buka dan menyimpannya **di browser kamu sendiri**. Tidak ada server
milik pengembang, tidak ada akun, dan tidak ada data yang dikirim keluar.

## Data yang diproses

Saat kamu menekan picker atau menjalankan pengambilan, ekstensi membaca:

- isi halaman yang sedang terbuka (teks, struktur HTML, dan JSON yang dimuat
  halaman itu sendiri),
- respons API yang dimuat halaman tersebut **selama kamu menyalakan
  "Rekam API situs"**.

Data itu diolah di perangkatmu dan disimpan di penyimpanan lokal ekstensi
(IndexedDB dan `chrome.storage.local`).

## Data yang disimpan

- **Run dan record hasil pengambilan** — judul, URL, kolom yang terdeteksi, dan
  cuplikan HTML/JSON mentah untuk keperluan audit.
- **Recipe per situs** — bentuk daftar yang kamu pilih, supaya pengambilan
  berikutnya memakai daftar yang sama.
- **Setelan** — nama/urutan kolom per situs, status tombol melayang, dan status
  perekaman API.

Token, cookie, header `Authorization`, dan sejenisnya **tidak disimpan**. Kalau
sebuah permintaan membutuhkan token semacam itu, run akan dijeda dengan pesan
agar kamu memuat ulang halaman.

## Yang tidak dilakukan

- Tidak ada pengiriman data ke server mana pun (tidak ada analytics, telemetry,
  iklan, atau akun).
- Tidak ada penjualan atau pembagian data ke pihak ketiga.
- Tidak ada pelacakan aktivitas di luar tab yang kamu jalankan sendiri.

## Izin dan alasannya

| Izin | Dipakai untuk |
| --- | --- |
| `storage` | Menyimpan setelan, recipe, dan status perekaman API |
| `activeTab` + host akses halaman | Membaca halaman yang kamu tunjuk saat picker dijalankan |
| `sidePanel` | Menampilkan panel hasil, progres, dan ekspor |
| `contextMenus` | Menu klik kanan "Mulai picker" sebagai pintu masuk tanpa shortcut |
| `alarms` | Menjaga proses pengambilan tetap hidup saat service worker MV3 tidur |

Semua izin hanya aktif untuk pekerjaan yang kamu picu sendiri.

## Menghapus data

- Hapus satu run: dari side panel.
- Hapus semuanya: hapus ekstensi dari `chrome://extensions`, atau hapus data
  situs/ekstensi lewat setelan Chrome. Menghapus ekstensi menghapus seluruh
  IndexedDB dan `storage.local` miliknya.

## Perubahan

Perubahan kebijakan ini akan tercatat di riwayat repositori proyek. Versi yang
berlaku adalah yang ada di halaman ini.

## Kontak

Pertanyaan soal privasi: buka issue di repositori proyek.

---

## English summary

scraperGOD runs entirely in your browser. It reads the page you explicitly point
at, stores extracted runs, site recipes, and settings locally (IndexedDB and
`chrome.storage.local`), and sends nothing to any server. Authentication tokens,
cookies, and `Authorization` headers are never stored. Removing the extension
deletes all of its data.
