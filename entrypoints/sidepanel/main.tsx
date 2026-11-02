import React from 'react';
import ReactDOM from 'react-dom/client';
import { browser } from 'wxt/browser';
import App from './App';
import './style.css';

document.title = `${browser.runtime.getManifest().name} — Panel`;

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
