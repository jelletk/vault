// IndexedDB stores. Drive content lives here and only here (never in the Cache API).
import { openDB, deleteDB, type IDBPDatabase } from 'idb';
import type { ContentRecord, PreviousRecord, SyncStats, TreeNode } from './types';

export const DB_NAME = 'vault';

export interface MetaValues {
  rootId: string;
  changesToken: string;
  lastSyncAt: number;
  lastSyncStats: SyncStats;
}

export async function openVault(name = DB_NAME): Promise<IDBPDatabase> {
  return openDB(name, 1, {
    upgrade(db) {
      db.createObjectStore('tree', { keyPath: 'id' });      // TreeNode
      db.createObjectStore('content', { keyPath: 'id' });   // ContentRecord
      db.createObjectStore('previous', { keyPath: 'id' });  // PreviousRecord
      db.createObjectStore('meta');                         // key -> value
    },
  });
}

export async function getMeta<K extends keyof MetaValues>(db: IDBPDatabase, k: K): Promise<MetaValues[K] | undefined> {
  return db.get('meta', k);
}
export const loadTree = (db: IDBPDatabase) => db.getAll('tree') as Promise<TreeNode[]>;
export const loadContent = (db: IDBPDatabase, id: string) => db.get('content', id) as Promise<ContentRecord | undefined>;
export const loadPrevious = (db: IDBPDatabase, id: string) => db.get('previous', id) as Promise<PreviousRecord | undefined>;

const WIPE_FLAG = 'vault.wipePending';
const WIPE_TIMEOUT_MS = 5000;

/** deleteDB, but never waits forever: a stuck transaction or another open connection can block it. */
async function deleteWithin(name: string, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<boolean>((r) => { timer = setTimeout(() => r(false), ms); });
  const done = deleteDB(name).then(() => true, () => false);
  const ok = await Promise.race([done, late]);
  clearTimeout(timer);
  return ok;
}

/**
 * Wipes everything on this device: IndexedDB plus our own caches (used by "Uitloggen").
 * Returns false when the database could not be deleted in time; the wipe is then finished at the next start.
 */
export async function wipeAll(db: IDBPDatabase | null, name = DB_NAME, timeoutMs = WIPE_TIMEOUT_MS): Promise<boolean> {
  try { db?.close(); } catch { /* already closed */ }
  const ok = await deleteWithin(name, timeoutMs);
  try { if (ok) localStorage.removeItem(WIPE_FLAG); else localStorage.setItem(WIPE_FLAG, name); } catch { /* storage blocked */ }
  try {
    if (typeof caches !== 'undefined') {
      for (const k of await caches.keys()) if (k.startsWith('vault-')) await caches.delete(k);
    }
  } catch { /* caches are only the app shell; it is rebuilt by the service worker */ }
  return ok;
}

/** Called before opening the database at startup: finishes a logout whose wipe did not complete. */
export async function finishPendingWipe(): Promise<boolean> {
  let name: string | null = null;
  try { name = localStorage.getItem(WIPE_FLAG); } catch { return false; }
  if (!name) return false;
  const ok = await deleteWithin(name, WIPE_TIMEOUT_MS);
  if (ok) try { localStorage.removeItem(WIPE_FLAG); } catch { /* ignore */ }
  return ok;
}

/** Asks the browser not to evict our data. Returns whether it was granted (iOS may say no). */
export async function requestPersistence(): Promise<boolean | null> {
  try {
    if (navigator.storage?.persist) return await navigator.storage.persist();
  } catch { /* ignore */ }
  return null;
}
