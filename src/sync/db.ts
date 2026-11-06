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

/** Wipes everything on this device: IndexedDB plus our own caches (used by "Uitloggen"). */
export async function wipeAll(db: IDBPDatabase | null, name = DB_NAME): Promise<void> {
  db?.close();
  await deleteDB(name);
  if (typeof caches !== 'undefined') {
    for (const k of await caches.keys()) if (k.startsWith('vault-')) await caches.delete(k);
  }
}

/** Asks the browser not to evict our data. Returns whether it was granted (iOS may say no). */
export async function requestPersistence(): Promise<boolean | null> {
  try {
    if (navigator.storage?.persist) return await navigator.storage.persist();
  } catch { /* ignore */ }
  return null;
}
