import { describe, expect, it } from 'vitest';
import { compareFolders, listFolder, parseRoute, splitPrefix, urlFor } from './nav';
import type { TreeNode } from './sync/types';

const node = (name: string, over: Partial<TreeNode> = {}): TreeNode => ({
  id: name, name, mimeType: '', parent: 'root', isFolder: false, isMd: name.endsWith('.md'),
  modifiedTime: '', md5Checksum: '', size: 0, path: name, ...over,
});
const folder = (name: string) => node(name, { isFolder: true, isMd: false });

describe('routes', () => {
  it('parses and rebuilds', () => {
    expect(parseRoute('/', '')).toEqual({ kind: 'folder', id: null });
    expect(parseRoute('/f/abc', '')).toEqual({ kind: 'folder', id: 'abc' });
    expect(parseRoute('/n/abc', '#mijn-kop')).toEqual({ kind: 'note', id: 'abc', heading: 'mijn-kop' });
    expect(parseRoute('/sync', '')).toEqual({ kind: 'sync' });
    expect(parseRoute('/onzin/x', '')).toEqual({ kind: 'folder', id: null });
    expect(urlFor({ kind: 'note', id: 'a b', heading: 'kop' })).toBe('/n/a%20b#kop');
    expect(parseRoute('/n/a%20b', '#kop')).toEqual({ kind: 'note', id: 'a b', heading: 'kop' });
  });
});

describe('ordering', () => {
  it('puts 00-03 first, _Inbox after the rest, and hidden tool folders (.claude, .obsidian) last', () => {
    const names = ['.obsidian', '_Inbox', '03 Archive', '.claude', '00 Resources', 'Media', '02 Areas', '01 Projects', '10 Later'];
    const sorted = names.map(folder).sort(compareFolders).map((n) => n.name);
    expect(sorted).toEqual(['00 Resources', '01 Projects', '02 Areas', '03 Archive', '10 Later', 'Media', '_Inbox', '.claude', '.obsidian']);
  });
  it('sorts numbers naturally inside folders (2 before 10)', () => {
    const l = listFolder([node('note 10.md'), node('note 2.md'), node('.DS_Store'), node('plaatje.png'), folder('b'), folder('a')]);
    expect(l.notes.map((n) => n.name)).toEqual(['note 2.md', 'note 10.md']);
    expect(l.folders.map((n) => n.name)).toEqual(['a', 'b']);
    expect(l.others.map((n) => n.name)).toEqual(['plaatje.png']);
  });
  it('splits the numeric prefix', () => {
    expect(splitPrefix('01 Projects')).toEqual({ prefix: '01', label: 'Projects' });
    expect(splitPrefix('_Inbox')).toEqual({ prefix: null, label: '_Inbox' });
  });
});
