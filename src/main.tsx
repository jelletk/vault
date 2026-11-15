import { createRoot } from 'react-dom/client';
import './style.css';
import { App } from './App';

// When an update of the app arrives, the new service worker takes over this page (skipWaiting + clientsClaim).
// Reload once at that moment, so the new code runs now instead of only at the next start.
// Only when a worker already controlled the page: the very first install needs no reload.
if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (!reloading) { reloading = true; location.reload(); } });
}

createRoot(document.getElementById('root')!).render(<App />);
