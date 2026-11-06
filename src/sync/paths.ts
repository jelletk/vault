// Pure helpers: which Drive items belong to Life OS, and what their paths are.
import { FOLDER_MIME, type DriveFile, type TreeNode } from './types';

export function parentOf(f: DriveFile): string | null {
  return f.parents && f.parents.length ? f.parents[0] : null;
}

/** Walks the parent chain; true when it reaches rootId. Cycle-safe. */
export function reachesRoot(id: string, rootId: string, all: Map<string, DriveFile>): boolean {
  const seen = new Set<string>();
  let cur: string | null = id;
  while (cur) {
    if (cur === rootId) return true;
    if (seen.has(cur)) return false;
    seen.add(cur);
    const f = all.get(cur);
    if (!f) return false;
    cur = parentOf(f);
  }
  return false;
}

/** Keeps only items at or below rootId. The root itself is kept if present in `all`. */
export function filterToRoot(all: Map<string, DriveFile>, rootId: string): Map<string, DriveFile> {
  const memo = new Map<string, boolean>();
  const out = new Map<string, DriveFile>();
  const check = (id: string): boolean => {
    const hit = memo.get(id);
    if (hit !== undefined) return hit;
    const ok = reachesRoot(id, rootId, all);
    memo.set(id, ok);
    return ok;
  };
  for (const [id, f] of all) if (!f.trashed && check(id)) out.set(id, f);
  return out;
}

export function isMdName(name: string): boolean {
  return name.toLowerCase().endsWith('.md');
}

/** Builds TreeNodes (with relative paths) for items already filtered to Life OS. */
export function buildTree(items: Map<string, DriveFile>, rootId: string): Map<string, TreeNode> {
  const nodes = new Map<string, TreeNode>();
  const pathCache = new Map<string, string>();
  pathCache.set(rootId, '');
  const pathOf = (id: string): string => {
    const cached = pathCache.get(id);
    if (cached !== undefined) return cached;
    const f = items.get(id)!;
    const p = parentOf(f);
    const parentPath = p && items.has(p) ? pathOf(p) : '';
    const path = parentPath ? parentPath + '/' + f.name : f.name;
    pathCache.set(id, path);
    return path;
  };
  for (const [id, f] of items) {
    const isFolder = f.mimeType === FOLDER_MIME;
    nodes.set(id, {
      id,
      name: f.name,
      mimeType: f.mimeType,
      parent: id === rootId ? null : parentOf(f),
      isFolder,
      isMd: !isFolder && isMdName(f.name),
      modifiedTime: f.modifiedTime ?? '',
      md5Checksum: f.md5Checksum ?? '',
      size: Number(f.size ?? 0),
      path: pathOf(id),
    });
  }
  return nodes;
}

export function summarize(nodes: Map<string, TreeNode>, rootId: string) {
  let md = 0, folders = 0, otherFiles = 0;
  for (const n of nodes.values()) {
    if (n.id === rootId) continue;
    if (n.isFolder) folders++;
    else if (n.isMd) md++;
    else otherFiles++;
  }
  return { md, folders, otherFiles };
}
