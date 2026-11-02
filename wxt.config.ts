import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'wxt';

// Nama ekstensi selalu ikut nama folder proyek, jadi ganti nama folder =
// ganti nama di chrome://extensions tanpa menyunting config.
const projectName = basename(fileURLToPath(new URL('.', import.meta.url)));

// See https://wxt.dev/api/reference/wxt/interfaces/inlineconfig.html
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: projectName,
    short_name: projectName,
    description:
      'Tunjuk daftar di halaman, ambil itemnya, dan salin ke spreadsheet.',
    // `contextMenus`: jalur masuk picker tanpa keyboard shortcut. Shortcut
    // global sering direbut ekstensi lain dan Chrome tidak memberi tahu, jadi
    // klik kanan adalah pintu utama yang tidak bisa bentrok.
    permissions: ['storage', 'activeTab', 'alarms', 'sidePanel', 'contextMenus'],
    // WXT defaultnya mengambil tooltip dari <title> popup, jadi ditimpa di sini.
    action: { default_title: projectName },
    side_panel: { default_path: 'sidepanel.html' },
  },
});
