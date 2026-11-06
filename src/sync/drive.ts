// Thin Drive v3 client. Everything goes through `request`, which retries rate limits and
// reports an expired token as AuthError so the UI can show the "Bijwerken" button.
import { FOLDER_MIME, type DriveChange, type DriveFile } from './types';

const API = 'https://www.googleapis.com/drive/v3/';
export const FILE_FIELDS = 'id,name,mimeType,parents,modifiedTime,md5Checksum,size,trashed';
const PARENTS_PER_QUERY = 40; // keeps the GET url well under the length limit
export const MAX_PARALLEL = 5;

export class AuthError extends Error {
  constructor(msg = 'Token verlopen of afgewezen') { super(msg); this.name = 'AuthError'; }
}
export class ChangesTokenError extends Error {
  constructor() { super('Changes-token ongeldig'); this.name = 'ChangesTokenError'; }
}

/** The surface the sync code depends on. Tests use an in-memory implementation. */
export interface Drive {
  findRoot(): Promise<string | null>;
  listAllFolders(): Promise<DriveFile[]>;
  /** Children (files and folders) of the given folders, any number of parents. */
  listChildren(parentIds: string[], opts?: { foldersToo?: boolean }): Promise<DriveFile[]>;
  getStartPageToken(): Promise<string>;
  listChanges(token: string): Promise<{ changes: DriveChange[]; newStartPageToken: string }>;
  download(id: string): Promise<string>;
  readonly calls: number;
}

export type TokenProvider = () => string | null;

export function createDrive(getToken: TokenProvider, fetchImpl: typeof fetch = fetch): Drive {
  let calls = 0;

  async function request(url: string, asText = false): Promise<any> {
    for (let attempt = 0; ; attempt++) {
      const token = getToken();
      if (!token) throw new AuthError();
      calls++;
      let r: Response;
      try {
        r = await fetchImpl(url, { headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(30000) });
      } catch (e) {
        if (attempt < 4) { await sleep(400 * 2 ** attempt); continue; }
        throw e;
      }
      if (r.ok) return asText ? r.text() : r.json();
      if (r.status === 401) throw new AuthError();
      const body = (await r.text()).slice(0, 300);
      const retryable = r.status === 429 || r.status >= 500 || (r.status === 403 && /rateLimit|userRateLimit/i.test(body));
      if (retryable && attempt < 5) { await sleep(500 * 2 ** attempt + Math.random() * 250); continue; }
      if (r.status === 410 || (r.status === 400 && /pageToken/i.test(body))) throw new ChangesTokenError();
      throw new Error(`Drive ${r.status}: ${body}`);
    }
  }

  async function pagedFiles(q: string): Promise<DriveFile[]> {
    const out: DriveFile[] = [];
    let page = '';
    do {
      const url = API + 'files?q=' + encodeURIComponent(q) + '&fields=' + encodeURIComponent(`nextPageToken,files(${FILE_FIELDS})`)
        + '&pageSize=1000&spaces=drive&corpora=user' + (page ? '&pageToken=' + encodeURIComponent(page) : '');
      const d = await request(url);
      out.push(...d.files);
      page = d.nextPageToken || '';
    } while (page);
    return out;
  }

  return {
    get calls() { return calls; },

    async findRoot() {
      const q = "name='Life OS' and 'root' in parents and mimeType='" + FOLDER_MIME + "' and trashed=false";
      const d = await request(API + 'files?q=' + encodeURIComponent(q) + '&fields=files(id,name)');
      return d.files.length ? d.files[0].id : null;
    },

    // One paginated stream with every folder in My Drive; the Life OS subset is picked out locally.
    listAllFolders: () => pagedFiles("mimeType='" + FOLDER_MIME + "' and trashed=false"),

    async listChildren(parentIds, opts) {
      const chunks: string[][] = [];
      for (let i = 0; i < parentIds.length; i += PARENTS_PER_QUERY) chunks.push(parentIds.slice(i, i + PARENTS_PER_QUERY));
      const results = await mapLimit(chunks, MAX_PARALLEL, (chunk) => {
        const parents = chunk.map((id) => `'${id}' in parents`).join(' or ');
        const kind = opts?.foldersToo ? '' : " and mimeType!='" + FOLDER_MIME + "'";
        return pagedFiles(`(${parents}) and trashed=false${kind}`);
      });
      return results.flat();
    },

    async getStartPageToken() {
      const d = await request(API + 'changes/startPageToken?supportsAllDrives=false');
      return d.startPageToken;
    },

    async listChanges(token) {
      const changes: DriveChange[] = [];
      let page = token;
      for (;;) {
        const url = API + 'changes?pageToken=' + encodeURIComponent(page) + '&pageSize=1000&includeRemoved=true&restrictToMyDrive=true&spaces=drive'
          + '&fields=' + encodeURIComponent(`nextPageToken,newStartPageToken,changes(fileId,removed,file(${FILE_FIELDS}))`);
        const d = await request(url);
        changes.push(...d.changes);
        if (d.nextPageToken) page = d.nextPageToken;
        else return { changes, newStartPageToken: d.newStartPageToken };
      }
    },

    download: (id) => request(API + 'files/' + encodeURIComponent(id) + '?alt=media', true),
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Runs `fn` over `items` with at most `limit` in flight; results keep input order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
