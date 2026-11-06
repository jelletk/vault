// Imported by the generated service worker. Removes the cache of the old hand-written worker (package 0-2).
// Only touches caches that start with "vault-shell-"; never caches of other apps.
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((ks) => Promise.all(ks.filter((k) => k.startsWith('vault-shell-')).map((k) => caches.delete(k))))
  );
});
