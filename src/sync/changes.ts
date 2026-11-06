// Applies a batch of Drive changes to the Life OS tree. Pure apart from `listChildren`,
// which is called for folders that newly entered Life OS (their files produce no change records).
import { FOLDER_MIME, type DriveChange, type DriveFile } from './types';
import { parentOf, reachesRoot } from './paths';

export interface ApplyResult {
  /** The new set of Life OS items (raw Drive records), root included when known. */
  items: Map<string, DriveFile>;
  added: string[];
  removed: string[];
  modified: string[];
  /** Changes seen for things outside Life OS (ignored). */
  ignored: number;
}

export type ListChildren = (folderIds: string[]) => Promise<DriveFile[]>;

function differs(a: DriveFile, b: DriveFile): boolean {
  return a.name !== b.name || a.md5Checksum !== b.md5Checksum || a.modifiedTime !== b.modifiedTime
    || parentOf(a) !== parentOf(b) || a.mimeType !== b.mimeType;
}

export async function applyChanges(
  current: Map<string, DriveFile>,
  rootId: string,
  changes: DriveChange[],
  listChildren: ListChildren,
): Promise<ApplyResult> {
  // Working view: everything we know. Items outside Life OS are only kept so parent chains resolve
  // within this batch (e.g. a folder created outside and a file moved into it in the same batch).
  const all = new Map(current);
  const touched = new Set<string>();
  for (const c of changes) {
    touched.add(c.fileId);
    if (c.removed || !c.file || c.file.trashed) all.delete(c.fileId);
    else all.set(c.fileId, c.file);
  }

  const included = new Map<string, DriveFile>();
  const memo = new Map<string, boolean>();
  const check = (id: string) => {
    let v = memo.get(id);
    if (v === undefined) { v = reachesRoot(id, rootId, all); memo.set(id, v); }
    return v;
  };
  for (const [id, f] of all) if (check(id)) included.set(id, f);

  // Folders that are now inside Life OS but were not before: fetch their subtree.
  const entered = [...included.values()].filter((f) => f.mimeType === FOLDER_MIME && !current.has(f.id) && f.id !== rootId);
  let frontier = entered.map((f) => f.id);
  while (frontier.length) {
    const kids = await listChildren(frontier);
    frontier = [];
    for (const k of kids) {
      if (k.trashed) continue;
      // Make sure the child records point at a parent we know, even if the API omitted `parents`.
      included.set(k.id, k);
      all.set(k.id, k);
      if (k.mimeType === FOLDER_MIME && !current.has(k.id)) frontier.push(k.id);
    }
  }

  const added: string[] = [], removed: string[] = [], modified: string[] = [];
  for (const [id, f] of included) {
    const old = current.get(id);
    if (!old) added.push(id);
    else if (differs(old, f)) modified.push(id);
  }
  for (const id of current.keys()) if (!included.has(id)) removed.push(id);

  let ignored = 0;
  for (const id of touched) if (!included.has(id) && !current.has(id)) ignored++;
  return { items: included, added, removed, modified, ignored };
}
