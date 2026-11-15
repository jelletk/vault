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

export const googleReady = () => typeof google !== 'undefined';

/** The Google script just finished loading, but the tap that asked for it is used up: Safari only opens a popup straight from a tap. */
export class NeedTapError extends Error {
  constructor() { super('Google-login is nu geladen. Tik nog een keer op Bijwerken om in te loggen.'); this.name = 'NeedTapError'; }
}
export class GisLoadError extends Error {
  constructor(why: string) { super(`Google-login kon niet laden (${why}). Probeer het opnieuw zodra je internet hebt.`); this.name = 'GisLoadError'; }
}

const POPUP_TIMEOUT_MS = 5 * 60_000; // generous (two-step login), but never wait forever for a popup that iOS lost

/** Must be called from a tap: Safari blocks a popup without a user gesture. */
export function signInPopup(prompt: '' | 'consent' | 'select_account'): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!googleReady()) return reject(new NeedTapError());
    const timer = setTimeout(() => reject(new Error('Inloggen bij Google duurde te lang of het venster is gesloten. Tik opnieuw.')), POPUP_TIMEOUT_MS);
    const client = google.accounts.oauth2.initTokenClient({
      client_id: CLIENT_ID,
      scope: SCOPE,
      prompt,
      callback: (r: any) => {
        clearTimeout(timer);
        if (r.error) return reject(new Error(r.error + (r.error_description ? ': ' + r.error_description : '')));
        save({ access_token: r.access_token, expires_at: Date.now() + Number(r.expires_in) * 1000 - 60_000 });
        resolve();
      },
      error_callback: (e: any) => { clearTimeout(timer); reject(new Error(e.type === 'popup_closed' ? 'Het Google-venster is gesloten voordat je was ingelogd.' : e.type || 'popup-fout')); },
    });
    client.requestAccessToken();
  });
}

/**
 * Loads the Google script on demand. Offline this fails quietly; reading does not need it.
 * A failed or stalled load is forgotten, so the next tap (or coming back online) tries again (R2-6).
 */
const GIS_TIMEOUT_MS = 20_000;
let gisLoad: Promise<void> | null = null;
export function loadGoogleScript(): Promise<void> {
  if (googleReady()) return Promise.resolve();
  if (!gisLoad) {
    gisLoad = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      const fail = (why: string) => { clearTimeout(timer); s.remove(); gisLoad = null; reject(new GisLoadError(why)); };
      const timer = setTimeout(() => fail('geen antwoord binnen 20 s'), GIS_TIMEOUT_MS);
      s.src = 'https://accounts.google.com/gsi/client';
      s.onload = () => { clearTimeout(timer); if (googleReady()) resolve(); else fail('script zonder inhoud'); };
      s.onerror = () => fail('geen verbinding?');
      document.head.appendChild(s);
    });
  }
  return gisLoad;
}
