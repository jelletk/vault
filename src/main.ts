// Vault, package 0: login test. Shows whether Google login works in an iOS home-screen PWA
// and counts the .md files in Drive folder "Life OS". Read-only (drive.readonly).

const CLIENT_ID = '998109822582-0d8r91l6vnasl8uo56bk3gicj29f19gu.apps.googleusercontent.com';
const SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
const REDIRECT_URI = location.origin + '/vault/';
const KEY = 'vault.token';
const MODE_KEY = 'vault.mode';

type Mode = 'popup' | 'redirect';
interface Token { access_token: string; expires_at: number }

declare const google: any;

const app = document.getElementById('app')!;
const logLines: string[] = [];
function log(msg: string) {
  logLines.push(new Date().toLocaleTimeString('nl-NL') + '  ' + msg);
  render();
}

let mode: Mode = (localStorage.getItem(MODE_KEY) as Mode) || 'popup';
let token: Token | null = null;
let result = '';
let busy = false;

try { token = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { token = null; }

// Redirect variant: Google returns #access_token=... on the same page.
function consumeHash() {
  if (!location.hash.includes('access_token')) return;
  const p = new URLSearchParams(location.hash.slice(1));
  const at = p.get('access_token');
  const exp = Number(p.get('expires_in') || '3600');
  if (at) {
    saveToken({ access_token: at, expires_at: Date.now() + exp * 1000 - 60_000 });
    log(`redirect-login ok, token geldig ${exp}s`);
  }
  history.replaceState(null, '', location.pathname);
}

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

function signInRedirect(silent: boolean) {
  const p = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'token',
    scope: SCOPE,
    include_granted_scopes: 'true',
  });
  if (silent) p.set('prompt', 'none');
  location.href = 'https://accounts.google.com/o/oauth2/v2/auth?' + p;
}

async function login(silent = false) {
  busy = true; render();
  try {
    if (mode === 'popup') {
      log(`popup-login (prompt='${silent ? '' : 'consent'}')`);
      await signInPopup(silent ? '' : 'consent');
      log('popup-login ok');
    } else {
      log('redirect-login gestart');
      signInRedirect(silent);
      return;
    }
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

function setMode(m: Mode) { mode = m; localStorage.setItem(MODE_KEY, m); log('modus: ' + m); }

function logout() {
  if (token && typeof google !== 'undefined') google.accounts.oauth2.revoke(token.access_token, () => {});
  token = null; result = '';
  localStorage.removeItem(KEY);
  log('uitgelogd');
}

function render() {
  const standalone = (navigator as any).standalone === true || matchMedia('(display-mode: standalone)').matches;
  const left = token ? Math.round((token.expires_at - Date.now()) / 60000) : 0;
  app.innerHTML = `
    <p class="muted">Modus: ${standalone ? 'beginscherm (standalone)' : 'browser'} · login: ${mode}</p>
    ${result ? `<div class="big">${result}</div><p>md-bestanden in Life OS</p>` : ''}
    <p>${valid() ? `Ingelogd, token nog ±${left} min geldig.` : token ? 'Token verlopen.' : 'Niet ingelogd.'}</p>
    ${valid()
      ? `<button id="count" ${busy ? 'disabled' : ''}>Tel opnieuw</button><button class="secondary" id="logout">Uitloggen</button>`
      : `<button id="login" ${busy ? 'disabled' : ''}>Inloggen met Google</button>`}
    <p class="muted">Testknoppen</p>
    <button class="secondary" id="m-popup">Popup</button><button class="secondary" id="m-redirect">Redirect</button>
    <button class="secondary" id="silent">Stil vernieuwen</button>
    <pre>${logLines.join('\n') || '(nog geen log)'}</pre>`;
  const on = (id: string, fn: () => void) => document.getElementById(id)?.addEventListener('click', fn);
  on('login', () => login(false));
  on('count', count);
  on('logout', logout);
  on('m-popup', () => setMode('popup'));
  on('m-redirect', () => setMode('redirect'));
  on('silent', () => login(true));
}

async function start() {
  consumeHash();
  render();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/vault/sw.js').catch((e) => log('sw: ' + e.message));
  if (valid()) { log('bestaand token gebruikt, geen login nodig'); await count(); }
  else if (token) { log('token verlopen bij opstart, probeer stil vernieuwen'); await login(true); }
}

// Load Google Identity Services, then start.
const s = document.createElement('script');
s.src = 'https://accounts.google.com/gsi/client';
s.onload = () => start();
s.onerror = () => { log('Google-script laden mislukt'); start(); };
document.head.appendChild(s);
