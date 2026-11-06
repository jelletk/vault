// Google token handling (GIS token client, popup). Unchanged behaviour from package 0-2, moved out of main.
// Reading never depends on a valid token: this module only matters for "Bijwerken".
const CLIENT_ID = '998109822582-0d8r91l6vnasl8uo56bk3gicj29f19gu.apps.googleusercontent.com';
const SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
const KEY = 'vault.token';

export interface Token { access_token: string; expires_at: number }

declare const google: any;

let token: Token | null = null;
try { token = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { token = null; }

export const getToken = () => token;
export const hasValidToken = () => !!token && token.expires_at > Date.now();
export const accessToken = () => (hasValidToken() ? token!.access_token : null);

function save(t: Token) {
  token = t;
  try { localStorage.setItem(KEY, JSON.stringify(t)); } catch { /* storage blocked: token stays in memory */ }
}

export function dropToken() {
  token = null;
  try { localStorage.removeItem(KEY); } catch { /* ignore */ }
}

export function revokeToken() {
  if (token && typeof google !== 'undefined') google.accounts.oauth2.revoke(token.access_token, () => {});
}

/** Must be called from a tap: Safari blocks a popup without a user gesture. */
export function signInPopup(prompt: '' | 'consent' | 'select_account'): Promise<void> {
  return new Promise((resolve, reject) => {
    if (typeof google === 'undefined') return reject(new Error('Google-script niet geladen (offline?)'));
    const client = google.accounts.oauth2.initTokenClient({
      client_id: CLIENT_ID,
      scope: SCOPE,
      prompt,
      callback: (r: any) => {
        if (r.error) return reject(new Error(r.error + (r.error_description ? ': ' + r.error_description : '')));
        save({ access_token: r.access_token, expires_at: Date.now() + Number(r.expires_in) * 1000 - 60_000 });
        resolve();
      },
      error_callback: (e: any) => reject(new Error(e.type || 'popup-fout')),
    });
    client.requestAccessToken();
  });
}

/** Loads the Google script on demand. Offline this fails quietly; reading does not need it. */
let gisLoad: Promise<void> | null = null;
export function loadGoogleScript(): Promise<void> {
  if (typeof google !== 'undefined') return Promise.resolve();
  if (!gisLoad) {
    gisLoad = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client';
      s.onload = () => resolve();
      s.onerror = () => { gisLoad = null; reject(new Error('Google-script laden mislukt (offline?)')); };
      document.head.appendChild(s);
    });
  }
  return gisLoad;
}
