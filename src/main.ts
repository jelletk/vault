// Vault, package 0: login test. Shows whether Google login works in an iOS home-screen PWA
// and counts the .md files in Drive folder "Life OS". Read-only (drive.readonly).
import './style.css';

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
async function login(silent = false) {
  busy = true; render();
  try {
    log(`popup-login (prompt='${silent ? '' : 'consent'}')`);
    await signInPopup(silent ? '' : 'consent');
    log('popup-login ok');
    await count();
  } catch (e: any) {
    log('FOUT: ' + e.message);
  } finally { busy = false; render(); }
}

async function api(path: string) {
  const r = await fetch('https://www.googleapis.com/drive/v3/' + path, { headers: { Authorization: 'Bearer ' + token!.access_token }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`Drive ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

async function count() {
  busy = true; render();
  try {
    const root = await api(`files?q=${encodeURIComponent("name='Life OS' and 'root' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false")}&fields=files(id,name)`);
    if (!root.files.length) { result = 'Map "Life OS" niet gevonden in de root van Mijn Drive'; log(result); return; }
    const rootId = root.files[0].id;
    let md = 0, folders = 0, others = 0;
    let queue = [rootId];
    log('map Life OS gevonden, tellen gestart');
    let calls = 0;
    while (queue.length) {
      const batch = queue.splice(0, 8); // parents in one query keeps requests low
      const q = batch.map((id) => `'${id}' in parents`).join(' or ');
      let pageToken = '';
      do {
        const d = await api(`files?q=${encodeURIComponent(`(${q}) and trashed=false`)}&fields=nextPageToken,files(id,name,mimeType)&pageSize=1000&spaces=drive${pageToken ? '&pageToken=' + pageToken : ''}`);
        for (const f of d.files) {
          if (f.mimeType === 'application/vnd.google-apps.folder') { folders++; queue.push(f.id); }
          else if (f.name.toLowerCase().endsWith('.md')) md++;
          else others++;
        }
        pageToken = d.nextPageToken || '';
        calls++;
        if (calls % 5 === 0) log(`bezig: ${md} md, ${folders} mappen, wachtrij ${queue.length}`);
      } while (pageToken);
    }
    result = String(md);
    log(`telling klaar: ${md} md-bestanden, ${folders} mappen, ${others} andere bestanden`);
  } catch (e: any) {
    if (String(e.message).includes('401')) { token = null; localStorage.removeItem(KEY); log('token afgewezen (401)'); }
    else log('FOUT: ' + e.message);
  } finally { busy = false; render(); }
}

function logout() {
  if (token && typeof google !== 'undefined') google.accounts.oauth2.revoke(token.access_token, () => {});
  token = null; result = '';
  localStorage.removeItem(KEY);
  log('uitgelogd');
}

function render() {
  const standalone = (navigator as any).standalone === true || matchMedia('(display-mode: standalone)').matches;
  const left = token ? Math.round((token.expires_at - Date.now()) / 60000) : 0;
  // Static markup only; everything dynamic goes in via textContent (log lines can contain server text).
  const buttons = valid()
    ? `<button id="count" ${busy ? 'disabled' : ''}>Tel opnieuw</button><button class="secondary" id="logout">Uitloggen</button>`
    : token
      ? `<button id="renew" ${busy ? 'disabled' : ''}>Doorgaan</button><button class="secondary" id="login" ${busy ? 'disabled' : ''}>Opnieuw inloggen</button>`
      : `<button id="login" ${busy ? 'disabled' : ''}>Inloggen met Google</button>`;
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
    label.textContent = 'md-bestanden in Life OS';
    resultEl.append(big, label);
  }
  document.getElementById('status')!.textContent = valid()
    ? `Ingelogd, token nog ±${left} min geldig.`
    : token ? 'Token verlopen. Tik op Doorgaan om te vernieuwen.' : 'Niet ingelogd.';
  document.getElementById('log')!.textContent = logLines.join('\n') || '(nog geen log)';
  const on = (id: string, fn: () => void) => document.getElementById(id)?.addEventListener('click', fn);
  on('login', () => login(false));
  on('renew', () => login(true));
  on('count', count);
  on('logout', logout);
}

async function start() {
  render();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch((e) => log('sw: ' + e.message));
  if (valid()) { log('bestaand token gebruikt, geen login nodig'); await count(); }
  else if (token) log('token verlopen bij opstart; wacht op tik op Doorgaan');
}

// Load Google Identity Services, then start.
const s = document.createElement('script');
s.src = 'https://accounts.google.com/gsi/client';
s.onload = () => start();
s.onerror = () => { log('Google-script laden mislukt'); start(); };
document.head.appendChild(s);
