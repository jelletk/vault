import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { readFileSync } from 'node:fs';

// `npm run preview` / `npm run dev` send the same security headers as Vercel, so the CSP is tested locally too.
const vercel = JSON.parse(readFileSync(new URL('./vercel.json', import.meta.url), 'utf8'));
const headers: Record<string, string> = {};
for (const h of vercel.headers) if (h.source === '/(.*)') for (const x of h.headers) headers[x.key] = x.value;

export default defineConfig({
  base: '/',
  preview: { headers },
  // Never inline assets as data: URLs; the CSP (font-src 'self') would block the inlined font.
  build: { assetsInlineLimit: 0 },
  plugins: [
    react(),
    // Generates /sw.js (Workbox) that precaches the whole built app shell, JS bundle and font included,
    // so the app starts offline. Only build output is precached; Drive content lives in IndexedDB and
    // there is deliberately no runtime caching rule, so nothing from Drive ever enters the Cache API.
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'script', // external /registerSW.js, allowed by the CSP (script-src 'self')
      manifest: false, // we keep public/manifest.webmanifest
      workbox: {
        cacheId: 'vault', // cache names start with "vault-", which logout and sw cleanup rely on
        globPatterns: ['**/*.{js,css,html,woff2,svg,png,webmanifest}'],
        globIgnores: ['icons/**'],
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/privacy/],
        cleanupOutdatedCaches: true,
        clientsClaim: true,
        skipWaiting: true,
        importScripts: ['sw-cleanup.js'],
      },
    }),
  ],
});
