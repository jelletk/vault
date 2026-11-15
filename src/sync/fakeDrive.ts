// In-memory Drive for tests: same interface as the real client, plus a change log.
import { AuthError, ChangesBacklogError, ChangesTokenError, type Drive, type ListChangesOptions } from './drive';
import { FOLDER_MIME, type DriveChange, type DriveFile } from './types';

export class FakeDrive implements Drive {
  files = new Map<string, DriveFile>();
  texts = new Map<string, string>();
  log: DriveChange[] = [];
  calls = 0;
  downloads: string[] = [];
  failDownload = new Set<string>();
  authExpired = false;
  invalidTokens = false;
  /** Methods that never settle, like a request that hangs on a phone network. */
  hang = new Set<string>();
  changesPageSize = 1000;
  /** After this many successful downloads the token "expires" (AuthError on every later call). */
  authExpireAfterDownloads: number | null = null;
  private v = 1;

  constructor(public rootName = 'Life OS') {
    this.files.set('myroot', { id: 'myroot', name: 'Mijn Drive', mimeType: FOLDER_MIME });
  }

  private check() { this.calls++; if (this.authExpired) throw new AuthError(); }

  /** Creates or replaces an item and records a change, like Drive does. */
  put(id: string, name: string, parent: string | null, opts: { folder?: boolean; text?: string } = {}) {
    const mimeType = opts.folder ? FOLDER_MIME : name.endsWith('.md') ? 'text/markdown' : 'application/octet-stream';
    const f: DriveFile = { id, name, mimeType, parents: parent ? [parent] : undefined, modifiedTime: `2026-11-0${this.v}T10:00:00Z`, size: String((opts.text ?? '').length) };
    if (!opts.folder) { f.md5Checksum = 'md5-' + id + '-' + this.v; this.texts.set(id, opts.text ?? ''); }
    this.v++;
    this.files.set(id, f);
    this.log.push({ fileId: id, file: { ...f } });
    return f;
  }
  setText(id: string, text: string) { const f = this.files.get(id)!; this.put(id, f.name, f.parents![0], { text }); }
  rename(id: string, name: string) { const f = { ...this.files.get(id)!, name }; this.files.set(id, f); this.log.push({ fileId: id, file: { ...f } }); }
  move(id: string, parent: string) { const f = this.files.get(id)!; this.files.set(id, { ...f, parents: [parent] }); this.log.push({ fileId: id, file: { ...this.files.get(id)! } }); }
  remove(id: string) { this.files.delete(id); this.log.push({ fileId: id, removed: true }); }
  trash(id: string) { const f = { ...this.files.get(id)!, trashed: true }; this.files.set(id, f); this.log.push({ fileId: id, file: f }); }

  async findRoot() {
    this.check();
    return [...this.files.values()].find((f) => f.name === this.rootName && f.parents?.[0] === 'myroot')?.id ?? null;
  }
  async listAllFolders() { this.check(); return [...this.files.values()].filter((f) => f.mimeType === FOLDER_MIME && !f.trashed).map((f) => ({ ...f })); }
  async listChildren(ids: string[], opts?: { foldersToo?: boolean }) {
    this.check();
    return [...this.files.values()].filter((f) => !f.trashed && f.parents && ids.includes(f.parents[0]) && (opts?.foldersToo || f.mimeType !== FOLDER_MIME)).map((f) => ({ ...f }));
  }
  async getStartPageToken() { this.check(); return String(this.log.length); }
  async listChanges(token: string, opts?: ListChangesOptions) {
    this.check();
    if (this.hang.has('listChanges')) return new Promise<never>(() => {});
    if (this.invalidTokens) throw new ChangesTokenError();
    const changes = this.log.slice(Number(token)).map((c) => ({ ...c }));
    const pages = Math.max(1, Math.ceil(changes.length / this.changesPageSize));
    if (opts?.maxPages && pages > opts.maxPages) throw new ChangesBacklogError(opts.maxPages * this.changesPageSize);
    return { changes, newStartPageToken: String(this.log.length), pages };
  }
  async download(id: string) {
    this.check();
    this.downloads.push(id);
    await new Promise((r) => setTimeout(r, 1)); // a real network answer arrives later; lets workers interleave
    if (this.authExpireAfterDownloads !== null && this.downloads.length > this.authExpireAfterDownloads) { this.authExpired = true; throw new AuthError(); }
    if (this.failDownload.has(id)) throw new Error('boom');
    return this.texts.get(id) ?? '';
  }
}

/** A small Life OS: root with PARA-ish folders, md and non-md files, plus things outside. */
export function seed(): FakeDrive {
  const d = new FakeDrive();
  d.put('root', 'Life OS', 'myroot', { folder: true });
  d.put('f-res', '00 Resources', 'root', { folder: true });
  d.put('f-areas', '02 Areas', 'root', { folder: true });
  d.put('f-werk', 'Werk', 'f-areas', { folder: true });
  d.put('claude', 'CLAUDE.md', 'root', { text: '# root' });
  d.put('mem-root', 'MEMORY.md', 'root', { text: '# mem root' });
  d.put('mem-werk', 'MEMORY.md', 'f-werk', { text: '# mem werk' });
  d.put('prof', 'personal-profile.md', 'f-res', { text: '# profiel' });
  d.put('pdf', 'offerte.pdf', 'f-werk', { text: 'pdfbytes' });
  d.put('ds', '.DS_Store', 'root', { text: 'x' });
  d.put('media', 'Media', 'myroot', { folder: true });
  d.put('m1', 'foto.md', 'media', { text: 'buiten Life OS' });
  d.put('lo-out', 'losse-notitie.md', 'myroot', { text: 'ook buiten' });
  return d;
}
