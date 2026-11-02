/**
 * Inferensi kolom dari blok teks satu kartu (jalur DOM).
 *
 * Jalur network sudah punya 7 field kanonik lewat `autoMapFields`; jalur DOM
 * dulu hanya `info_1/info_2` posisional, sehingga CSV dari kedua jalur tidak
 * pernah cocok kolomnya. Fungsi di sini menebak peran blok teks (gaji, tanggal,
 * lokasi, perusahaan) dan menyisakan sisanya sebagai info_1/info_2.
 *
 * Murni string: tidak menyentuh DOM, jadi bisa dites tanpa fixture browser.
 * Salah tebak tidak menghilangkan data — blok yang tidak dikenali tetap masuk
 * info_1/info_2, dan nilai asli tetap ada di `raw`.
 */

export interface DomHints {
  /** Teks elemen yang class-nya menandakan perusahaan (kalau ada). */
  company?: string | null;
}

const SALARY =
  /(\brp\.?\s*[\d.,]+)|(\bidr\s*[\d.,]+)|(\b\d+(?:[.,]\d+)?\s*(jt|juta|rb|ribu)\b)|(\b(gaji|salary|upah)\s*[:\-])|(\b(per|\/)\s*(bulan|month)\b)/i;

const DATE =
  /(\b\d+\s*(menit|jam|hari|minggu|bulan|tahun)\s*(yang\s+)?lalu\b)|(\bbaru\s+saja\b)|(\bhari\s+ini\b)|(\bkemarin\b)|(\b\d{1,2}\s+(jan|feb|mar|apr|mei|jun|jul|agu|ags|sep|okt|nov|des)[a-z]*\s+\d{2,4}\b)|(\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b)|(\b\d{4}-\d{2}-\d{2}\b)/i;

/** Kota/area yang sering muncul apa adanya di kartu lowongan Indonesia. */
const LOCATION =
  /(jakarta|bandung|surabaya|medan|semarang|yogyakarta|jogja|bekasi|depok|tangerang|bogor|malang|denpasar|bali|makassar|palembang|pekanbaru|batam|balikpapan|samarinda|pontianak|manado|surakarta|solo|cirebon|serang|sidoarjo|padang|banjarmasin|mataram|kupang|jayapura|remote|wfh|wfo|hybrid)/i;

/** Label status/tipe kerja yang bukan nama perusahaan. */
const BADGE =
  /(full[\s-]?time|part[\s-]?time|internship|magang|freelance|kontrak|contract|remote|wfh|wfo|hybrid|baru|new|urgent|dibutuhkan|segera|hot|premium|featured|sponsor(ed)?|promoted|iklan|verified|pengalaman|tahun|thn)/i;

const LEGAL_ENTITY = /(\bPT\b|\bCV\b|\bInc\b|\bLtd\b|\bTbk\b|\bCorp\b|\bGroup\b|\bGmbH\b)/;

const MAX_LOCATION_LENGTH = 60;
const MAX_COMPANY_LENGTH = 80;
/** Batas kolom `info_N`: cukup untuk metadata, tidak menyalin seluruh kartu. */
const MAX_INFO_BLOCKS = 6;

function isSalary(block: string): boolean {
  return SALARY.test(block);
}

function isDate(block: string): boolean {
  return DATE.test(block);
}

function isLocation(block: string): boolean {
  if (block.length > MAX_LOCATION_LENGTH) return false;
  return LOCATION.test(block) && !isSalary(block);
}

function isBadge(block: string): boolean {
  // "Remote" boleh jadi lokasi, tapi "Remote-friendly" atau "Full-time" cuma
  // label. Label biasanya pendek dan seluruhnya cocok pola.
  return BADGE.test(block) && block.length <= 24;
}

function isCompanyLike(block: string): boolean {
  if (block.length < 2 || block.length > MAX_COMPANY_LENGTH) return false;
  if (isBadge(block) || isDate(block) || isSalary(block) || isLocation(block)) return false;
  return /[A-Za-z]/.test(block);
}

function pickCompany(rest: string[], hints: DomHints): string | null {
  if (hints.company && hints.company.length <= MAX_COMPANY_LENGTH) return hints.company;

  const candidates = rest.filter(isCompanyLike);
  // Nama berbadan hukum lebih pasti daripada teks bebas.
  const legal = candidates.find((block) => LEGAL_ENTITY.test(block));
  return legal ?? candidates[0] ?? null;
}

/**
 * `blocks` = blok teks kartu TANPA judul dan URL, urut DOM. Blok yang dikenali
 * dipetakan ke field kanonik; sisanya jadi info_1/info_2 supaya tidak ada teks
 * yang hilang diam-diam.
 */
export function inferDomFields(blocks: string[], hints: DomHints = {}): Record<string, string> {
  const fields: Record<string, string> = {};
  const rest: string[] = [];

  for (const block of blocks) {
    if (!fields.salary && isSalary(block)) {
      fields.salary = block;
      continue;
    }
    if (!fields.date && isDate(block)) {
      fields.date = block;
      continue;
    }
    if (!fields.location && isLocation(block)) {
      fields.location = block;
      continue;
    }
    rest.push(block);
  }

  const company = pickCompany(rest, hints);
  let remaining = rest;
  if (company) {
    fields.company = company;
    // Buang satu kemunculan saja: teks yang sama bisa muncul dua kali.
    const index = rest.indexOf(company);
    if (index >= 0) remaining = [...rest.slice(0, index), ...rest.slice(index + 1)];
  }

  // Semua sisa blok ikut, bukan cuma dua: daftar film/buku/produk punya lebih
  // dari dua potong metadata (tahun, genre, rating, durasi, ...). Kolom bernama
  // generik memang kurang enak dibaca, tapi datanya tidak hilang diam-diam.
  remaining.slice(0, MAX_INFO_BLOCKS).forEach((block, index) => {
    fields[`info_${index + 1}`] = block;
  });

  return fields;
}
