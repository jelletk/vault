// The sync orchestrator: full sync the first time, Changes API afterwards.
// Reading never depends on this: a failed or token-less sync leaves IndexedDB as it was.
// Every await on the network or the database is raced against `signal`, so a stopped sync
// (watchdog or app) always ends instead of waiting on a promise that never settles.
import type { IDBPDatabase } from 'idb';
import { ChangesBacklogError, ChangesTokenError, MAX_PARALLEL, guard, mapLimit, throwIfAborted, type Drive } from './drive';
import { applyChanges } from './changes';
import { buildTree, filterToRoot, summarize } from './paths';
import type { ContentRecord, DriveFile, PreviousRecord, Progress, SyncStats, TreeNode } from './types';

/** Beyond this many pages of changes (1000 each) a full sync is cheaper and safer. */
export const MAX_CHANGE_PAGES = 10;
/** The watchdog stops a sync after this long without any progress. */
export const WATCHDOG_MS = 120_000;

export class SyncStalledError extends Error {
  constructor(public step: string, ms: number) {
    super(`geen voortgang meer sinds "${step}" (${Math.round(ms / 1000)} s); sync gestopt`);
    this.name = 'SyncStalledError';
  }
}

/** Life OS (the stored root folder) is gone from Drive: trashed, deleted, or no longer reachable. */
export class RootLostError extends Error {
  constructor() {
    super('De map Life OS is in Google Drive verwijderd, naar de prullenbak verplaatst of niet meer bereikbaar. '
      + 'Je lokale kopie blijft leesbaar en is niet aangepast. Zet de map terug en tik op Opnieuw proberen. '
      + 'Is de map echt weg, log dan uit op Status en log opnieuw in.');
    this.name = 'RootLostError';
  }
}

/** The sync was stopped on purpose (logout). Not an error for the user. */
export class SyncStoppedError extends Error {
  constructor() { super('sync gestopt'); this.name = 'SyncStoppedError'; }
}

export interface SyncOptions {
  signal?: AbortSignal;
  maxChangePages?: number;
  /** Called on every unit of progress that is too small to log (each download); feeds the watchdog. */
  onActivity?: () => void;
}

export function nodeToDrive(n: TreeNode): DriveFile {
  return {
    id: n.id, name: n.name, mimeType: n.mimeType, parents: n.parent ? [n.parent] : undefined,
    modifiedTime: n.modifiedTime, md5Checksum: n.md5Checksum || undefined, size: String(n.size),
  };
}

/** True when the stored content no longer matches the tree entry (or is missing). */
function stale(n: TreeNode, c: ContentRecord | undefined): boolean {
  if (!c) return true;
  return n.md5Checksum ? c.md5Checksum !== n.md5Checksum : c.modifiedTime !== n.modifiedTime;
}

export async function runSync(drive: Drive, db: IDBPDatabase, progress: Progress = () => {}, now: () => number = Date.now, opts: SyncOptions = {}): Promise<SyncStats> {
  const { signal } = opts;
  const g = <T,>(p: Promise<T>) => guard(p, signal);
  const t0 = now();
  const callsAtStart = drive.calls;
  let rootId = (await g(db.get('meta', 'rootId'))) as string | undefined;
  if (!rootId) {
    progress('map Life OS zoeken');
    const found = await g(drive.findRoot());
    if (!found) throw new Error('Map "Life OS" niet gevonden in de root van Mijn Drive');
    rootId = found;
  }
  const storedNodes = (await g(db.getAll('tree'))) as TreeNode[];
  const storedToken = (await g(db.get('meta', 'changesToken'))) as string | undefined;
  const current = new Map(storedNodes.map((n) => [n.id, nodeToDrive(n)]));

  let items: Map<string, DriveFile> | null = null;
  let newToken = '';
  let mode: SyncStats['mode'] = 'full';
  let fullReason: string | undefined;

  if (storedToken && storedNodes.length) {
    try {
      progress('wijzigingen ophalen');
      const { changes, newStartPageToken, pages } = await g(drive.listChanges(storedToken, { maxPages: opts.maxChangePages ?? MAX_CHANGE_PAGES }));
      progress(`${changes.length} wijzigingen in ${pages} ${pages === 1 ? 'pagina' : "pagina's"}, toepassen`);
      // Never pick another "Life OS": if the stored root went away, stop and keep the local copy as it is.
      const rootChange = changes.filter((c) => c.fileId === rootId).at(-1);
      if (rootChange && (rootChange.removed || !rootChange.file || rootChange.file.trashed)) throw new RootLostError();
      const res = await g(applyChanges(current, rootId, changes, (ids) => {
        progress(`${ids.length} nieuwe ${ids.length === 1 ? 'map' : 'mappen'} in Life OS: inhoud ophalen`);
        return drive.listChildren(ids, { foldersToo: true });
      }));
      progress(`${changes.length} wijzigingen, ${res.ignored} buiten Life OS genegeerd; +${res.added.length} ~${res.modified.length} -${res.removed.length}`);
      items = res.items;
      newToken = newStartPageToken;
      mode = 'incremental';
    } catch (e) {
      if (e instanceof ChangesTokenError) fullReason = 'het wijzigingen-startpunt is niet meer geldig';
      else if (e instanceof ChangesBacklogError) fullReason = `er zijn ${e.message}`;
      else throw e;
      progress(`${fullReason}: volledige sync. Je notities blijven leesbaar en worden pas aan het eind vervangen.`);
    }
  }

  if (!items) {
    // Take the token first: changes made while we list are then picked up by the next incremental run.
    progress('startpunt voor wijzigingen ophalen');
    newToken = await g(drive.getStartPageToken());
    progress('alle mappen ophalen');
    const folders = await g(drive.listAllFolders());
    const folderMap = new Map(folders.map((f) => [f.id, f]));
    const inRoot = filterToRoot(folderMap, rootId);
    if (!inRoot.has(rootId)) throw new RootLostError();
    progress(`${inRoot.size} mappen onder Life OS (van ${folders.length} in Mijn Drive), bestanden ophalen`);
    const files = await g(drive.listChildren([...inRoot.keys()]));
    items = new Map(inRoot);
    for (const f of files) if (!f.trashed && f.parents?.some((p) => inRoot.has(p))) items.set(f.id, f);
    progress(`${files.length} bestanden gevonden`);
  }

  const nodes = buildTree(items, rootId);
  const oldIds = new Set(storedNodes.map((n) => n.id));
  const oldById = new Map(storedNodes.map((n) => [n.id, n]));
  const removedIds = [...oldIds].filter((id) => !nodes.has(id));
  const added = [...nodes.keys()].filter((id) => !oldIds.has(id)).length;
  const modified = [...nodes.values()].filter((n) => {
    const o = oldById.get(n.id);
    return o && (o.md5Checksum !== n.md5Checksum || o.modifiedTime !== n.modifiedTime || o.path !== n.path);
  }).length;

  // Which md files need their content (new, changed, or left behind by an earlier failed run)?
  const contentRecords = (await g(db.getAll('content'))) as ContentRecord[];
  const contentById = new Map(contentRecords.map((c) => [c.id, c]));
  const md = [...nodes.values()].filter((n) => n.isMd);
  const pending = md.filter((n) => stale(n, contentById.get(n.id)));
  progress(`${md.length} md-bestanden, ${pending.length} te downloaden`);

  // Downloads go to memory first. Nothing is written until every download has finished, so an
  // AuthError or a stop halfway never leaves a mix of old and new notes behind (R2-2).
  const fetched = new Map<string, string>();
  let done = 0, failed = 0;
  await g(mapLimit(pending, MAX_PARALLEL, async (n) => {
    throwIfAborted(signal);
    try {
      fetched.set(n.id, await g(drive.download(n.id)));
    } catch (e: any) {
      if (e?.name === 'AuthError' || signal?.aborted) throw e; // stops the other workers and the run; UI shows "Bijwerken"
      failed++;
      progress(`download mislukt: ${n.path}: ${e?.message ?? e}`);
    }
    done++;
    opts.onActivity?.();
    if (done % 50 === 0 || done === pending.length) progress(`gedownload ${done}/${pending.length}`);
  }));

  // One transaction: content, previous versions, tree and token land together or not at all.
  // Failed downloads keep their old content and are retried next run (the tree says they are stale).
  throwIfAborted(signal);
  progress('opslaan');
  const previousIds = new Set((await g(db.getAllKeys('previous'))) as string[]);
  const tx = db.transaction(['tree', 'content', 'previous', 'meta'], 'readwrite');
  const at = now();
  for (const [id, text] of fetched) {
    const n = nodes.get(id)!;
    const old = contentById.get(id);
    if (old && old.text !== text) {
      const prev: PreviousRecord = { id, text: old.text, md5Checksum: old.md5Checksum, modifiedTime: old.modifiedTime, replacedAt: at };
      tx.objectStore('previous').put(prev);
    }
    const rec: ContentRecord = { id, text, md5Checksum: n.md5Checksum, modifiedTime: n.modifiedTime, fetchedAt: at };
    tx.objectStore('content').put(rec);
  }
  for (const id of removedIds) tx.objectStore('tree').delete(id);
  // Text only belongs to items that are still a markdown note; a rename .md -> .txt drops it (R2-3).
  const isNote = (id: string) => nodes.get(id)?.isMd === true;
  let dropped = 0;
  for (const id of contentById.keys()) if (!isNote(id)) { tx.objectStore('content').delete(id); dropped++; }
  for (const id of previousIds) if (!isNote(id)) tx.objectStore('previous').delete(id);
  for (const n of nodes.values()) {
    const o = oldById.get(n.id);
    if (!o || JSON.stringify(o) !== JSON.stringify(n)) tx.objectStore('tree').put(n);
  }
  const sum = summarize(nodes, rootId);
  const stats: SyncStats = {
    mode, startedAt: t0, durationMs: now() - t0, ...sum,
    downloaded: pending.length - failed, skippedUnchanged: md.length - pending.length,
    removed: removedIds.length, added, modified, apiCalls: drive.calls - callsAtStart, failedDownloads: failed, droppedTexts: dropped,
    ...(fullReason ? { fullReason } : {}),
  };
  tx.objectStore('meta').put(rootId, 'rootId');
  tx.objectStore('meta').put(newToken, 'changesToken');
  tx.objectStore('meta').put(now(), 'lastSyncAt');
  tx.objectStore('meta').put(stats, 'lastSyncStats');
  await tx.done; // not raced: the commit is atomic and short; it either lands completely or not at all
  progress('opgeslagen');
  return stats;
}

/**
 * Runs a sync with a watchdog: when `run` reports no progress for `idleMs`, the signal is aborted
 * and the returned promise rejects with SyncStalledError, even if something inside never settles.
 */
export async function withWatchdog<T>(run: (signal: AbortSignal, ping: (step?: string) => void) => Promise<T>, idleMs = WATCHDOG_MS, stop?: AbortSignal): Promise<T> {
  const ctrl = new AbortController();
  let step = 'start';
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stall!: (e: Error) => void;
  const stalled = new Promise<never>((_, reject) => { stall = reject; });
  stalled.catch(() => {});
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => { const e = new SyncStalledError(step, idleMs); ctrl.abort(e); stall(e); }, idleMs);
  };
  const ping = (s?: string) => { if (s) step = s; arm(); };
  arm();
  const onStop = () => { const e = new SyncStoppedError(); ctrl.abort(e); stall(e); };
  if (stop?.aborted) onStop(); else stop?.addEventListener('abort', onStop, { once: true });
  const running = run(ctrl.signal, ping);
  running.catch(() => {});
  try {
    return await Promise.race([running, stalled]);
  } finally {
    clearTimeout(timer);
    stop?.removeEventListener('abort', onStop);
    if (!ctrl.signal.aborted) ctrl.abort(new Error('sync afgerond')); // stops stragglers after a failure
  }
}
