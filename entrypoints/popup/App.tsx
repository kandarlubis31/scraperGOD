import { useEffect, useState } from 'react';
import { browser } from 'wxt/browser';
import './App.css';

type Status = { tone: 'idle' | 'ok' | 'error'; text: string } | null;

const PRODUCT_NAME = browser.runtime.getManifest().name;

type SidePanelApi = {
  open(options: { tabId?: number; windowId?: number }): Promise<void>;
};

type PickerState = { active?: boolean };

function sidePanelApi(): SidePanelApi | null {
  const api = (browser as unknown as { sidePanel?: SidePanelApi }).sidePanel;
  return api ?? null;
}

async function activeTabId(): Promise<number | null> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  return tab?.id ?? null;
}

export default function App() {
  const [status, setStatus] = useState<Status>(null);
  const [busy, setBusy] = useState(false);
  /** Picker bisa dinyalakan dari klik kanan atau tombol di halaman, jadi
   *  statusnya dibaca dari tab — bukan disimpulkan dari tombol ini saja. */
  const [active, setActive] = useState(false);
  const [ready, setReady] = useState(false);

  async function refreshState(): Promise<void> {
    const tabId = await activeTabId();
    if (tabId === null) {
      setReady(true);
      return;
    }
    try {
      const state = (await browser.tabs.sendMessage(tabId, {
        type: 'scrapergod:picker-state',
      })) as PickerState | undefined;
      setActive(state?.active === true);
    } catch {
      // chrome://, Web Store, PDF: tidak ada content script.
      setActive(false);
    }
    setReady(true);
  }

  useEffect(() => {
    void refreshState();
    const onFocus = () => void refreshState();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);

  async function togglePicker() {
    setBusy(true);
    setStatus(null);

    try {
      const tabId = await activeTabId();
      if (tabId === null) {
        setStatus({ tone: 'error', text: 'Tidak ada tab aktif.' });
        return;
      }

      const response = (await browser.tabs.sendMessage(tabId, {
        type: 'toggle-picker',
      })) as PickerState | undefined;
      const next = response?.active === true;
      setActive(next);
      setStatus({
        tone: 'ok',
        text: next
          ? 'Picker aktif. Arahkan kursor ke daftar, Enter untuk Ambil.'
          : 'Picker dimatikan.',
      });
    } catch {
      setStatus({
        tone: 'error',
        text: 'Halaman ini tidak bisa dipakai (chrome://, Web Store, atau PDF).',
      });
    } finally {
      setBusy(false);
    }
  }

  async function openPanel() {
    setBusy(true);
    setStatus(null);
    try {
      const tabId = await activeTabId();
      const api = sidePanelApi();
      if (!api) {
        setStatus({ tone: 'error', text: 'Browser ini tidak mendukung side panel.' });
        return;
      }
      if (tabId === null) {
        setStatus({ tone: 'error', text: 'Tidak ada tab aktif.' });
        return;
      }
      await api.open({ tabId });
      window.close();
    } catch {
      setStatus({ tone: 'error', text: 'Gagal membuka panel.' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="app">
      <header>
        <h1>{PRODUCT_NAME}</h1>
        <p className="tagline">Tunjuk daftar. Ambil. Salin.</p>
      </header>

      <button
        className={active ? 'primary active' : 'primary'}
        onClick={togglePicker}
        disabled={busy || !ready}
      >
        {busy ? 'Memeriksa…' : active ? 'Matikan picker' : 'Mulai picker di tab ini'}
      </button>

      {active && (
        <p className="state on">
          Picker sedang aktif di tab ini. Klik daftar yang disorot, atau tekan
          Enter untuk mengambil, Esc untuk batal.
        </p>
      )}

      <button className="secondary" onClick={openPanel} disabled={busy}>
        Buka panel pengambilan
      </button>

      <p className="shortcut">
        Bisa juga <b>klik kanan</b> di halaman → <b>Mulai picker</b>, atau pakai
        tombol melayang di kanan bawah.
      </p>

      {status && <p className={`status ${status.tone}`}>{status.text}</p>}

      <footer>
        Semua data tetap di browser ini. Tidak ada yang dikirim ke server.
      </footer>
    </main>
  );
}
