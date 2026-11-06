// The sync orchestrator: full sync the first time, Changes API afterwards.
// Reading never depends on this: a failed or token-less sync leaves IndexedDB as it was.
import type { IDBPDatabase } from 'idb';
import { ChangesTokenError, MAX_PARALLEL, mapLimit, type Drive } from './drive';
import { applyChanges } from './changes';
import { buildTree, filterToRoot, summarize } from './paths';
import type { ContentRecord, DriveFile, PreviousRecord, Progress, SyncStats, TreeNode } from './types';

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

export async function runSync(drive: Drive, db: IDBPDatabase, progress: Progress = () => {}, now: () => number = Date.now): Promise<SyncStats> {
  const t0 = now();
  const callsAtStart = drive.calls;
  let rootId = (await db.get('meta', 'rootId')) as string | undefined;
  if (!rootId) {
    progress('map Life OS zoeken');
    const found = await drive.findRoot();
    if (!found) throw new Error('Map "Life OS" niet gevonden in de root van Mijn Drive');
    rootId = found;
  }
  const storedNodes = (await db.getAll('tree')) as TreeNode[];
  const storedToken = (await db.get('meta', 'changesToken')) as string | undefined;
  const current = new Map(storedNodes.map((n) => [n.id, nodeToDrive(n)]));

  let items: Map<string, DriveFile> | null = null;
  let newToken = '';
  let mode: SyncStats['mode'] = 'full';

  if (storedToken && storedNodes.length) {
    try {
      progress('wijzigingen ophalen');
      const { changes, newStartPageToken } = await drive.listChanges(storedToken);
      const res = await applyChanges(current, rootId, changes, (ids) => drive.listChildren(ids, { foldersToo: true }));
      progress(`${changes.length} wijzigingen, ${res.ignored} buiten Life OS genegeerd`);
      items = res.items;
      newToken = newStartPageToken;
      mode = 'incremental';
    } catch (e) {
      if (!(e instanceof ChangesTokenError)) throw e;
      progress('changes-token ongeldig, volledige sync');
    }
  }

  if (!items) {
    // Take the token first: changes made while we list are then picked up by the next incremental run.
    newToken = await drive.getStartPageToken();
    progress('alle mappen ophalen');
    const folders = await drive.listAllFolders();
    const folderMap = new Map(folders.map((f) => [f.id, f]));
    const inRoot = filterToRoot(folderMap, rootId);
    if (!inRoot.has(rootId)) throw new Error('Life OS niet gevonden in de mappenlijst');
    progress(`${inRoot.size} mappen onder Life OS (van ${folders.length} in Mijn Drive), bestanden ophalen`);
    const files = await drive.listChildren([...inRoot.keys()]);
    items = new Map(inRoot);
    for (const f of files) if (!f.trashed && f.parents?.some((p) => inRoot.has(p))) items.set(f.id, f);
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
  const contentRecords = (await db.getAll('content')) as ContentRecord[];
  const contentById = new Map(contentRecords.map((c) => [c.id, c]));
  const md = [...nodes.values()].filter((n) => n.isMd);
  const pending = md.filter((n) => stale(n, contentById.get(n.id)));
  progress(`${md.length} md-bestanden, ${pending.length} te downloaden`);

  let done = 0, failed = 0;
  await mapLimit(pending, MAX_PARALLEL, async (n) => {
    try {
      const text = await drive.download(n.id);
      const old = contentById.get(n.id);
      const tx = db.transaction(['content', 'previous'], 'readwrite');
      if (old && old.text !== text) {
        const prev: PreviousRecord = { id: n.id, text: old.text, md5Checksum: old.md5Checksum, modifiedTime: old.modifiedTime, replacedAt: now() };
        await tx.objectStore('previous').put(prev);
      }
      const rec: ContentRecord = { id: n.id, text, md5Checksum: n.md5Checksum, modifiedTime: n.modifiedTime, fetchedAt: now() };
      await tx.objectStore('content').put(rec);
      await tx.done;
    } catch (e: any) {
      if (e?.name === 'AuthError') throw e; // stop the whole run, UI shows "Bijwerken"
      failed++;
      progress(`download mislukt: ${n.path}: ${e?.message ?? e}`);
    }
    done++;
    if (done % 50 === 0 || done === pending.length) progress(`gedownload ${done}/${pending.length}`);
  });

  // Commit the tree and token only after the content is in; failures above are retried next run.
  const tx = db.transaction(['tree', 'content', 'previous', 'meta'], 'readwrite');
  for (const id of removedIds) {
    tx.objectStore('tree').delete(id);
    tx.objectStore('content').delete(id);
    tx.objectStore('previous').delete(id);
  }
  for (const n of nodes.values()) {
    const o = oldById.get(n.id);
    if (!o || JSON.stringify(o) !== JSON.stringify(n)) tx.objectStore('tree').put(n);
  }
  const sum = summarize(nodes, rootId);
  const stats: SyncStats = {
    mode, startedAt: t0, durationMs: now() - t0, ...sum,
    downloaded: pending.length - failed, skippedUnchanged: md.length - pending.length,
    removed: removedIds.length, added, modified, apiCalls: drive.calls - callsAtStart, failedDownloads: failed,
  };
  tx.objectStore('meta').put(rootId, 'rootId');
  tx.objectStore('meta').put(newToken, 'changesToken');
  tx.objectStore('meta').put(now(), 'lastSyncAt');
  tx.objectStore('meta').put(stats, 'lastSyncStats');
  await tx.done;
  return stats;
}
