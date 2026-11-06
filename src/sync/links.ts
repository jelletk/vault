// Link resolution, Obsidian style: a wikilink names a file without ".md", anywhere in the vault.
import type { TreeNode } from './types';

export interface LinkIndex {
  /** lowercase basename without ".md" -> md files with that name */
  byName: Map<string, TreeNode[]>;
  /** lowercase full file name (with extension) -> non-md files */
  byFullName: Map<string, TreeNode[]>;
  /** lowercase path without ".md" -> node */
  byPath: Map<string, TreeNode>;
}

export function buildLinkIndex(nodes: Iterable<TreeNode>): LinkIndex {
  const idx: LinkIndex = { byName: new Map(), byFullName: new Map(), byPath: new Map() };
  const push = (m: Map<string, TreeNode[]>, k: string, n: TreeNode) => {
    const a = m.get(k);
    if (a) a.push(n); else m.set(k, [n]);
  };
  for (const n of nodes) {
    if (n.isFolder) continue;
    if (n.isMd) {
      const base = n.name.slice(0, -3).toLowerCase();
      push(idx.byName, base, n);
      idx.byPath.set(n.path.slice(0, -3).toLowerCase(), n);
    } else {
      push(idx.byFullName, n.name.toLowerCase(), n);
    }
  }
  return idx;
}

function dirOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

/** Number of leading path segments two directories share. */
function commonDepth(a: string, b: string): number {
  const x = a ? a.split('/') : [], y = b ? b.split('/') : [];
  let i = 0;
  while (i < x.length && i < y.length && x[i] === y[i]) i++;
  return i;
}

function pickClosest(cands: TreeNode[], fromPath: string): TreeNode {
  const fromDir = dirOf(fromPath);
  return [...cands].sort((p, q) => {
    const dp = commonDepth(dirOf(p.path), fromDir), dq = commonDepth(dirOf(q.path), fromDir);
    if (dp !== dq) return dq - dp; // closest to the source first
    if (p.path.length !== q.path.length) return p.path.length - q.path.length; // then shortest path
    return p.path < q.path ? -1 : 1;
  })[0];
}

export interface WikiTarget { node: TreeNode | null; heading: string | null; alias: string | null; raw: string }

/**
 * Resolves the inside of `[[...]]` (so without the brackets).
 * Handles `Name`, `Name|alias`, `Name#Heading`, `folder/Name`, and an optional ".md".
 * Returns node=null when nothing matches ("niet gevonden").
 */
export function resolveWikilink(inner: string, fromPath: string, idx: LinkIndex): WikiTarget {
  const [targetPart, ...aliasParts] = inner.split('|');
  const alias = aliasParts.length ? aliasParts.join('|').trim() : null;
  const hashAt = targetPart.indexOf('#');
  const heading = hashAt >= 0 ? targetPart.slice(hashAt + 1).trim() || null : null;
  let target = (hashAt >= 0 ? targetPart.slice(0, hashAt) : targetPart).trim();
  const result = (node: TreeNode | null): WikiTarget => ({ node, heading, alias, raw: inner });
  if (!target) return result(null); // [[#Heading]]: same file, caller handles
  target = target.replace(/^\/+/, '');
  const lower = target.toLowerCase();
  const hasPath = lower.includes('/');
  const noMd = lower.endsWith('.md') ? lower.slice(0, -3) : lower;
  if (hasPath) {
    const exact = idx.byPath.get(noMd);
    if (exact) return result(exact);
    // Obsidian also accepts a path suffix: [[Werk/MEMORY]] matches "02 Areas/Werk/MEMORY.md"
    const hits = [...idx.byPath.entries()].filter(([p]) => p.endsWith('/' + noMd)).map(([, n]) => n);
    return result(hits.length ? pickClosest(hits, fromPath) : null);
  }
  const md = idx.byName.get(noMd);
  if (md && md.length) return result(pickClosest(md, fromPath));
  const other = idx.byFullName.get(lower);
  if (other && other.length) return result(pickClosest(other, fromPath));
  return result(null);
}

/** Resolves a relative markdown link (`../Werk/MEMORY.md`, `#kop` excluded) against the note it is in. */
export function resolveRelativeLink(href: string, fromPath: string, idx: LinkIndex): TreeNode | null {
  let clean = href.split('#')[0].split('?')[0];
  try { clean = decodeURIComponent(clean); } catch { /* keep raw */ }
  if (!clean || /^[a-z][a-z0-9+.-]*:/i.test(clean) || clean.startsWith('//')) return null;
  const parts = (clean.startsWith('/') ? clean.slice(1) : dirOf(fromPath) + '/' + clean).split('/');
  const out: string[] = [];
  for (const p of parts) {
    if (!p || p === '.') continue;
    if (p === '..') { if (!out.length) return null; out.pop(); } else out.push(p);
  }
  const full = out.join('/').toLowerCase();
  const md = idx.byPath.get(full.endsWith('.md') ? full.slice(0, -3) : full);
  if (md) return md;
  const name = out[out.length - 1]?.toLowerCase();
  const dir = out.slice(0, -1).join('/').toLowerCase();
  return (name && idx.byFullName.get(name)?.find((n) => dirOf(n.path).toLowerCase() === dir)) || null;
}
