/**
 * Kunci setelan yang dibagi content script, side panel, dan popup.
 * Satu tempat supaya nama key tidak pernah berbeda antar sisi.
 */

/** Tombol melayang di halaman sebagai pintu masuk picker. Default: aktif. */
export const LAUNCHER_ENABLED_KEY = 'launcher:enabled';

export function launcherEnabledFrom(stored: Record<string, unknown>): boolean {
  // Default aktif: tombol ini pengganti shortcut, jadi harus ada tanpa setup.
  return stored[LAUNCHER_ENABLED_KEY] !== false;
}
