// Vault, package 2: sync test page. Logs in with Google (token client), syncs the Drive folder "Life OS"
// into IndexedDB and shows what is stored. Read-only (drive.readonly). Real screens come in package 3.
import './style.css';
import type { IDBPDatabase } from 'idb';
import { createDrive } from './sync/drive';
import { openVault, requestPersistence, wipeAll } from './sync/db';
import { summarize } from './sync/paths';
import { runSync } from './sync/sync';
import type { SyncStats, TreeNode } from './sync/types';

const CLIENT_ID = '998109822582-0d8r91l6vnasl8uo56bk3gicj29f19gu.apps.googleusercontent.com';
const SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
const KEY = 'vault.token';

interface Token { access_token: string; expires_at: number }

declare const google: any;

const app = document.getElementById('app')!;
const logLines: string[] = [];
function log(msg: string) {
  logLines.push(new Date().toLocaleTimeString('nl-NL') + '  ' + msg);
  render();
}

let token: Token | null = null;
let result = '';
let busy = false;

try { token = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { token = null; }

function saveToken(t: Token) {
  token = t;
  localStorage.setItem(KEY, JSON.stringify(t));
}

function valid() { return !!token && token.expires_at > Date.now(); }

function signInPopup(prompt: '' | 'consent' | 'select_account'): Promise<void> {
  return new Promise((resolve, reject) => {
    if (typeof google === 'undefined') return reject(new Error('Google-script niet geladen'));
    const client = google.accounts.oauth2.initTokenClient({
      client_id: CLIENT_ID,
      scope: SCOPE,
      prompt,
      callback: (r: any) => {
        if (r.error) return reject(new Error(r.error + (r.error_description ? ': ' + r.error_description : '')));
        saveToken({ access_token: r.access_token, expires_at: Date.now() + Number(r.expires_in) * 1000 - 60_000 });
        resolve();
      },
      error_callback: (e: any) => reject(new Error(e.type || 'popup-fout')),
    });
    client.requestAccessToken();
  });
}

// Always called from a tap: a popup without a user gesture is blocked by Safari.
async function login() {
  busy = true; render();
  try {
    log("popup-login (prompt='consent')");
    await signInPopup('consent');
    log('popup-login ok');
  } catch (e: any) {
    log('FOUT: ' + e.message);
    busy = false; render();
    return;
  }
  busy = false;
  await update();
}

// --- Sync (package 2): the test page now syncs Life OS into IndexedDB instead of only counting. ---
let db: IDBPDatabase | null = null;
let local: { md: number; folders: number; otherFiles: number; lastSyncAt: number; stats?: SyncStats } | null = null;

async function openLocal() {
  db = await openVault();
  await refreshLocal();
}

async function refreshLocal() {
  if (!db) return;
  const nodes = (await db.getAll('tree')) as TreeNode[];
  const lastSyncAt = (await db.get('meta', 'lastSyncAt')) as number | undefined;
  if (!nodes.length || !lastSyncAt) { local = null; result = ''; return; }
  const rootId = (await db.get('meta', 'rootId')) as string;
  const sum = summarize(new Map(nodes.map((n) => [n.id, n])), rootId);
  local = { ...sum, lastSyncAt, stats: (await db.get('meta', 'lastSyncStats')) as SyncStats | undefined };
  result = String(sum.md);
}

let lastProgressRender = 0;
function progress(msg: string) {
  logLines.push(new Date().toLocaleTimeString('nl-NL') + '  ' + msg);
  const now = Date.now();
  if (now - lastProgressRender > 250) { lastProgressRender = now; render(); }
}

async function update() {
  if (busy) return;
  busy = true; render();
  try {
    if (!valid()) { log("token verlopen: popup-login (prompt='')"); await signInPopup(''); log('popup-login ok'); }
    if (!db) await openLocal();
    const drive = createDrive(() => (valid() ? token!.access_token : null));
    const stats = await runSync(drive, db!, progress);
    log(`sync klaar (${stats.mode}) in ${(stats.durationMs / 1000).toFixed(1)} s: ${stats.md} md, ${stats.folders} mappen, ${stats.otherFiles} andere; `
      + `${stats.downloaded} gedownload, ${stats.skippedUnchanged} ongewijzigd, +${stats.added} ~${stats.modified} -${stats.removed}, ${stats.apiCalls} API-calls`
      + (stats.failedDownloads ? `, ${stats.failedDownloads} MISLUKT` : ''));
    await refreshLocal();
    await logStorage();
  } catch (e: any) {
    if (e?.name === 'AuthError') {
      token = null; localStorage.removeItem(KEY);
      log('token verlopen of afgewezen; opgeslagen notities blijven leesbaar. Tik op Bijwerken.');
    } else log('FOUT: ' + (e?.message ?? e));
  } finally { busy = false; render(); }
}

async function logStorage() {
  try {
    const est = await navigator.storage?.estimate?.();
    if (est) log(`opslag: ${((est.usage ?? 0) / 1048576).toFixed(1)} MB in gebruik van ${((est.quota ?? 0) / 1048576).toFixed(0)} MB`);
  } catch { /* not available */ }
}

async function logout() {
  if (token && typeof google !== 'undefined') google.accounts.oauth2.revoke(token.access_token, () => {});
  token = null; result = ''; local = null;
  localStorage.removeItem(KEY);
  await wipeAll(db);
  db = null;
  log('uitgelogd; lokale notities en caches gewist');
  render();
}

function render() {
  const standalone = (navigator as any).standalone === true || matchMedia('(display-mode: standalone)').matches;
  const left = token ? Math.round((token.expires_at - Date.now()) / 60000) : 0;
  // Static markup only; everything dynamic goes in via textContent (log lines can contain server text).
  const dis = busy ? 'disabled' : '';
  const buttons = local || valid()
    ? `<button id="update" ${dis}>Bijwerken</button>` + (!valid() && token ? `<button class="secondary" id="login" ${dis}>Opnieuw inloggen</button>` : '') + `<button class="secondary" id="logout" ${dis}>Uitloggen</button>`
    : `<button id="login" ${dis}>Inloggen met Google</button>`;
  app.innerHTML = `
    <p class="muted" id="mode"></p>
    <div id="result"></div>
    <p id="status"></p>
    ${buttons}
    <pre id="log"></pre>`;
  document.getElementById('mode')!.textContent = `Modus: ${standalone ? 'beginscherm (standalone)' : 'browser'}`;
  const resultEl = document.getElementById('result')!;
  if (result) {
    const big = document.createElement('div');
    big.className = 'big';
    big.textContent = result;
    const label = document.createElement('p');
    label.textContent = 'md-bestanden lokaal opgeslagen' + (local ? ` · ${local.folders} mappen · ${local.otherFiles} andere bestanden (alleen naam)` : '');
    resultEl.append(big, label);
  }
  document.getElementById('status')!.textContent = valid()
    ? `Ingelogd, token nog ±${left} min geldig.`
    : token ? 'Token verlopen. Lezen kan nog; tik op Bijwerken om te vernieuwen.' : local ? 'Geen geldig token. Lezen kan nog; tik op Bijwerken.' : 'Niet ingelogd.';
  if (local) document.getElementById('status')!.textContent += ` Laatst bijgewerkt ${new Date(local.lastSyncAt).toLocaleString('nl-NL')}.`;
  document.getElementById('log')!.textContent = logLines.join('\n') || '(nog geen log)';
  const on = (id: string, fn: () => void) => document.getElementById(id)?.addEventListener('click', fn);
  on('login', login);
  on('update', update);
  on('logout', logout);
}

async function start() {
  render();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch((e) => log('sw: ' + e.message));
  // Reading never needs a token: show what is stored before anything else.
  try {
    await openLocal();
    const persisted = await requestPersistence();
    log(`opslag blijvend: ${persisted === null ? 'onbekend (niet ondersteund)' : persisted ? 'ja' : 'nee (kan door iOS gewist worden)'}`);
    if (local) log(`lokaal: ${local.md} md, ${local.folders} mappen, ${local.otherFiles} andere; laatste sync ${new Date(local.lastSyncAt).toLocaleString('nl-NL')}`);
    else log('lokaal nog leeg: eerste sync nodig');
  } catch (e: any) { log('IndexedDB: ' + e.message); }
  render();
  if (valid()) { log('bestaand token gebruikt'); await update(); }
  else if (token) log('token verlopen bij opstart; tik op Bijwerken');
}

// Load Google Identity Services, then start.
const s = document.createElement('script');
s.src = 'https://accounts.google.com/gsi/client';
s.onload = () => start();
s.onerror = () => { log('Google-script laden mislukt'); start(); };
document.head.appendChild(s);
