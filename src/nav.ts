// Routes and folder ordering. Pure functions, no DOM, so they are unit-testable.
import type { TreeNode } from './sync/types';

export type Route =
  | { kind: 'folder'; id: string | null } // null = root of Life OS
  | { kind: 'note'; id: string; heading: string | null }
  | { kind: 'sync' };

/** decodeURIComponent that never throws: a broken link (e.g. "/n/%") must give "Niet gevonden", not a crash. */
function safeDecode(s: string): string | null {
  try { return decodeURIComponent(s); } catch { return null; }
}

export function parseRoute(pathname: string, hash: string): Route {
  const h = hash.startsWith('#') ? safeDecode(hash.slice(1)) ?? '' : '';
  const m = pathname.match(/^\/([fn])\/([^/]+)\/?$/);
  // An undecodable id is kept raw; it matches no item, so the screen shows "Niet gevonden".
  if (m && m[1] === 'n') return { kind: 'note', id: safeDecode(m[2]) ?? m[2], heading: h || null };
  if (m && m[1] === 'f') return { kind: 'folder', id: safeDecode(m[2]) ?? m[2] };
  if (/^\/sync\/?$/.test(pathname)) return { kind: 'sync' };
  return { kind: 'folder', id: null };
}

export function urlFor(r: Route): string {
  if (r.kind === 'sync') return '/sync';
  if (r.kind === 'note') return `/n/${encodeURIComponent(r.id)}` + (r.heading ? '#' + encodeURIComponent(r.heading) : '');
  return r.id ? `/f/${encodeURIComponent(r.id)}` : '/';
}

/** PARA order: "00 …" to "03 …" first (numeric), other names alphabetical, then "_" names (_Inbox), and hidden tool folders (.claude, .obsidian, …) at the very end. */
function rank(name: string): number {
  if (name.startsWith('.')) return 4;
  if (name.startsWith('_')) return 3;
  return /^\d\d(\s|$)/.test(name) ? 0 : 1;
}
const collator = new Intl.Collator('nl', { numeric: true, sensitivity: 'base' });
export function compareFolders(a: TreeNode, b: TreeNode): number {
  return rank(a.name) - rank(b.name) || collator.compare(a.name, b.name);
}

export interface Listing { folders: TreeNode[]; notes: TreeNode[]; others: TreeNode[] }

/** Children of a folder, split and ordered. `.DS_Store` and similar noise is left out. */
export function listFolder(children: TreeNode[]): Listing {
  const folders = children.filter((n) => n.isFolder).sort(compareFolders);
  const notes = children.filter((n) => n.isMd).sort((a, b) => collator.compare(a.name, b.name));
  const others = children.filter((n) => !n.isFolder && !n.isMd && n.name !== '.DS_Store')
    .sort((a, b) => collator.compare(a.name, b.name));
  return { folders, notes, others };
}

/** Strips ".md" for display. */
export const noteTitle = (n: TreeNode) => (n.isMd ? n.name.slice(0, -3) : n.name);

/** "01 Projects" -> { prefix: "01", label: "Projects" } */
export function splitPrefix(name: string): { prefix: string | null; label: string } {
  const m = name.match(/^(\d\d)\s+(.*)$/);
  return m ? { prefix: m[1], label: m[2] } : { prefix: null, label: name };
}

export const driveUrl = (id: string) => `https://drive.google.com/file/d/${encodeURIComponent(id)}/view`;

/**
 * Document title per screen (R2-13), e.g. "MEMORY – Vault". `node` is the item the route points at
 * (the root folder for the start screen); undefined means it is not on this device.
 */
export function screenTitle(r: Route, node: TreeNode | undefined, hasData: boolean): string {
  const t = (s: string) => `${s} – Vault`;
  if (r.kind === 'sync') return t('Status');
  if (!hasData) return 'Vault';
  if (!node) return t('Niet gevonden');
  if (r.kind === 'note') return node.isMd ? t(noteTitle(node)) : t('Niet gevonden');
  if (!node.isFolder) return t('Niet gevonden');
  return t(node.parent === null ? 'Life OS' : splitPrefix(node.name).label);
}
