// Thin Drive v3 client. Everything goes through `request`, which:
// - gives every attempt a hard deadline that covers the response body too (a phone network can stall
//   after the headers arrived; we do not rely on the browser propagating an abort into the body),
// - retries network errors, time-outs and rate limits a bounded number of times, logging each retry,
// - reports an expired token as AuthError so the UI can show the "Bijwerken" button,
// - stops at once when the sync is aborted (watchdog or a stop from the app).
import { FOLDER_MIME, type DriveChange, type DriveFile } from './types';

const API = 'https://www.googleapis.com/drive/v3/';
export const FILE_FIELDS = 'id,name,mimeType,parents,modifiedTime,md5Checksum,size,trashed';
const PARENTS_PER_QUERY = 40; // keeps the GET url well under the length limit
export const MAX_PARALLEL = 5;
export const REQUEST_TIMEOUT_MS = 25_000;
export const REQUEST_ATTEMPTS = 4;

export class AuthError extends Error {
  constructor(msg = 'Token verlopen of afgewezen') { super(msg); this.name = 'AuthError'; }
}
export class ChangesTokenError extends Error {
  constructor() { super('Changes-token ongeldig'); this.name = 'ChangesTokenError'; }
}
/** More changes since the last sync than we want to page through; a full sync is cheaper. */
export class ChangesBacklogError extends Error {
  constructor(public seen: number) { super(`meer dan ${seen} wijzigingen sinds de vorige sync`); this.name = 'ChangesBacklogError'; }
}
export class DriveTimeoutError extends Error {
  constructor(label: string, ms: number) { super(`${label}: geen antwoord binnen ${Math.round(ms / 1000)} s`); this.name = 'DriveTimeoutError'; }
}
export class HttpError extends Error {
  constructor(public status: number, body: string, public retryable: boolean) {
    super(`Drive ${status}: ${body.slice(0, 200)}`); this.name = 'HttpError';
  }
}

export interface ListChangesOptions {
  /** Stop with ChangesBacklogError once more than this many pages are needed. */
  maxPages?: number;
}

/** The surface the sync code depends on. Tests use an in-memory implementation. */
export interface Drive {
  findRoot(): Promise<string | null>;
  listAllFolders(): Promise<DriveFile[]>;
  /** Children (files and folders) of the given folders, any number of parents. */
  listChildren(parentIds: string[], opts?: { foldersToo?: boolean }): Promise<DriveFile[]>;
  getStartPageToken(): Promise<string>;
  listChanges(token: string, opts?: ListChangesOptions): Promise<{ changes: DriveChange[]; newStartPageToken: string; pages: number }>;
  download(id: string): Promise<string>;
  readonly calls: number;
}

export type TokenProvider = () => string | null;

export interface DriveOptions {
  timeoutMs?: number;
  attempts?: number;
  /** Aborts every request in flight and every request that follows. */
  signal?: AbortSignal;
  /** Log lines (retries, pages). */
  onEvent?: (msg: string) => void;
  /** Called after every successful response; feeds the sync watchdog. */
  onActivity?: () => void;
  sleep?: (ms: number) => Promise<void>;
}

export function createDrive(getToken: TokenProvider, fetchImpl: typeof fetch = fetch, opts: DriveOptions = {}): Drive {
  const timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const attempts = opts.attempts ?? REQUEST_ATTEMPTS;
  const signal = opts.signal;
  const event = opts.onEvent ?? (() => {});
  const wait = opts.sleep ?? sleep;
  let calls = 0;

  async function once(url: string, asText: boolean, ctrl: AbortController): Promise<any> {
    const token = getToken();
    if (!token) throw new AuthError();
    calls++;
    const r = await fetchImpl(url, { headers: { Authorization: 'Bearer ' + token }, signal: ctrl.signal });
    if (r.ok) return asText ? r.text() : r.json();
    if (r.status === 401) throw new AuthError();
    const body = (await r.text()).slice(0, 1000);
    if (r.status === 410 || (r.status === 400 && /pageToken/i.test(body))) throw new ChangesTokenError();
    const retryable = r.status === 429 || r.status >= 500 || (r.status === 403 && /rateLimit|userRateLimit/i.test(body));
    throw new HttpError(r.status, body, retryable);
  }

  async function request(url: string, label: string, asText = false): Promise<any> {
    for (let attempt = 1; ; attempt++) {
      throwIfAborted(signal);
      const ctrl = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let onAbort: (() => void) | undefined;
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => { ctrl.abort(); reject(new DriveTimeoutError(label, timeoutMs)); }, timeoutMs);
        if (signal) {
          onAbort = () => { ctrl.abort(); reject(signal.reason); };
          signal.addEventListener('abort', onAbort, { once: true });
        }
      });
      deadline.catch(() => {}); // the losing side of the race must not become an unhandled rejection
      const attemptP = once(url, asText, ctrl);
      attemptP.catch(() => {});
      try {
        const out = await Promise.race([attemptP, deadline]);
        opts.onActivity?.();
        return out;
      } catch (e: any) {
        if (signal?.aborted) throw signal.reason;
        const retry = e instanceof DriveTimeoutError || e instanceof TypeError || (e instanceof HttpError && e.retryable);
        if (!retry || attempt >= attempts) throw e;
        const ms = e instanceof HttpError ? 500 * 2 ** attempt + Math.random() * 250 : 400 * 2 ** (attempt - 1);
        event(`${label}: poging ${attempt}/${attempts} mislukt (${e?.message ?? e}), opnieuw over ${(ms / 1000).toFixed(1)} s`);
        await guard(wait(ms), signal);
      } finally {
        clearTimeout(timer);
        if (onAbort) signal!.removeEventListener('abort', onAbort);
      }
    }
  }

  async function pagedFiles(q: string, label: string): Promise<DriveFile[]> {
    const out: DriveFile[] = [];
    let page = '';
    for (let n = 1; ; n++) {
      const url = API + 'files?q=' + encodeURIComponent(q) + '&fields=' + encodeURIComponent(`nextPageToken,files(${FILE_FIELDS})`)
        + '&pageSize=1000&spaces=drive&corpora=user' + (page ? '&pageToken=' + encodeURIComponent(page) : '');
      const d = await request(url, `${label} pagina ${n}`);
      out.push(...(d.files ?? []));
      const next = d.nextPageToken || '';
      if (!next) return out;
      if (next === page) throw new Error(`${label}: Drive gaf twee keer dezelfde pagina`);
      page = next;
    }
  }

  return {
    get calls() { return calls; },

    async findRoot() {
      const q = "name='Life OS' and 'root' in parents and mimeType='" + FOLDER_MIME + "' and trashed=false";
      const d = await request(API + 'files?q=' + encodeURIComponent(q) + '&fields=files(id,name)', 'map Life OS zoeken');
      return d.files?.length ? d.files[0].id : null;
    },

    // One paginated stream with every folder in My Drive; the Life OS subset is picked out locally.
    listAllFolders: () => pagedFiles("mimeType='" + FOLDER_MIME + "' and trashed=false", 'mappen'),

    async listChildren(parentIds, o) {
      const chunks: string[][] = [];
      for (let i = 0; i < parentIds.length; i += PARENTS_PER_QUERY) chunks.push(parentIds.slice(i, i + PARENTS_PER_QUERY));
      const results = await mapLimit(chunks, MAX_PARALLEL, (chunk, i) => {
        const parents = chunk.map((id) => `'${id}' in parents`).join(' or ');
        const kind = o?.foldersToo ? '' : " and mimeType!='" + FOLDER_MIME + "'";
        return pagedFiles(`(${parents}) and trashed=false${kind}`, `bestanden ${i + 1}/${chunks.length}`);
      });
      return results.flat();
    },

    async getStartPageToken() {
      const d = await request(API + 'changes/startPageToken?supportsAllDrives=false', 'startpunt ophalen');
      return d.startPageToken;
    },

    async listChanges(token, o) {
      const changes: DriveChange[] = [];
      let page = token;
      for (let n = 1; ; n++) {
        if (o?.maxPages && n > o.maxPages) throw new ChangesBacklogError(changes.length);
        const url = API + 'changes?pageToken=' + encodeURIComponent(page) + '&pageSize=1000&includeRemoved=true&restrictToMyDrive=true&spaces=drive'
          + '&fields=' + encodeURIComponent(`nextPageToken,newStartPageToken,changes(fileId,removed,file(${FILE_FIELDS}))`);
        const d = await request(url, `wijzigingen pagina ${n}`);
        changes.push(...(d.changes ?? []));
        event(`wijzigingen pagina ${n}: ${(d.changes ?? []).length} (totaal ${changes.length})`);
        if (!d.nextPageToken) {
          if (!d.newStartPageToken) throw new Error('Drive gaf geen nieuw startpunt voor wijzigingen');
          return { changes, newStartPageToken: d.newStartPageToken, pages: n };
        }
        if (d.nextPageToken === page) throw new Error('wijzigingen: Drive gaf twee keer dezelfde pagina');
        page = d.nextPageToken;
      }
    },

    download: (id) => request(API + 'files/' + encodeURIComponent(id) + '?alt=media', 'download', true),
  };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw signal.reason;
}

/** Races a promise against the abort signal, so an await never outlives a stopped sync. */
export function guard<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return p;
  p.catch(() => {});
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

/**
 * Runs `fn` over `items` with at most `limit` in flight; results keep input order.
 * The first failure stops the other workers from starting new items.
 */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  let stopped = false;
  const worker = async () => {
    while (!stopped && next < items.length) {
      const i = next++;
      try { out[i] = await fn(items[i], i); } catch (e) { stopped = true; throw e; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
