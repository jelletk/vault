import { describe, expect, it } from 'vitest';
import { applyChanges } from './changes';
import { FOLDER_MIME, type DriveChange, type DriveFile } from './types';

const folder = (id: string, parent: string): DriveFile => ({ id, name: id, mimeType: FOLDER_MIME, parents: [parent] });
const md = (id: string, parent: string, v = '1'): DriveFile => ({ id, name: id + '.md', mimeType: 'text/markdown', parents: [parent], md5Checksum: v, modifiedTime: v });
const base = () => new Map<string, DriveFile>([
  ['root', folder('root', 'drive')], ['a', folder('a', 'root')], ['b', folder('b', 'a')], ['n1', md('n1', 'b')], ['n2', md('n2', 'root')],
]);
const upsert = (f: DriveFile): DriveChange => ({ fileId: f.id, file: f });
const none = async () => [] as DriveFile[];
const ids = (r: { items: Map<string, DriveFile> }) => [...r.items.keys()].sort();

describe('changes filteren op Life OS', () => {
  it('negeert wijzigingen buiten Life OS', async () => {
    const r = await applyChanges(base(), 'root', [upsert(md('x', 'media')), upsert(folder('media', 'drive')), { fileId: 'y', removed: true }], none);
    expect(ids(r)).toEqual(['a', 'b', 'n1', 'n2', 'root']);
    expect(r.added).toEqual([]);
    expect(r.ignored).toBe(3);
  });
  it('voegt een nieuw bestand toe en meldt een gewijzigd bestand', async () => {
    const r = await applyChanges(base(), 'root', [upsert(md('new', 'a')), upsert(md('n1', 'b', '2'))], none);
    expect(r.added).toEqual(['new']);
    expect(r.modified).toEqual(['n1']);
  });
  it('verwijdert bij removed en bij trashed', async () => {
    const r = await applyChanges(base(), 'root', [{ fileId: 'n1', removed: true }, upsert({ ...md('n2', 'root'), trashed: true })], none);
    expect(r.removed.sort()).toEqual(['n1', 'n2']);
  });
  it('een bestand dat uit Life OS wordt verplaatst verdwijnt', async () => {
    const r = await applyChanges(base(), 'root', [upsert(md('n1', 'media'))], none);
    expect(r.removed).toEqual(['n1']);
    expect(r.items.has('n1')).toBe(false);
  });
  it('een bestand dat naar Life OS wordt verplaatst komt erbij', async () => {
    const r = await applyChanges(base(), 'root', [upsert(md('ext', 'b'))], none);
    expect(r.added).toEqual(['ext']);
  });
  it('een nieuwe submap met bestand in dezelfde batch komt mee, in elke volgorde', async () => {
    const calls: string[][] = [];
    const list = async (x: string[]) => { calls.push(x); return [] as DriveFile[]; };
    for (const order of [[folder('new', 'b'), md('f', 'new')], [md('f', 'new'), folder('new', 'b')]]) {
      const r = await applyChanges(base(), 'root', order.map(upsert), list);
      expect(r.added.sort()).toEqual(['f', 'new']);
    }
    expect(calls.length).toBe(2); // de nieuwe map wordt wel opgevraagd; de lege lijst voegt niets dubbel toe
  });
  it('een nieuwe map buiten Life OS met bestand blijft buiten', async () => {
    const r = await applyChanges(base(), 'root', [upsert(folder('out', 'drive')), upsert(md('f', 'out'))], none);
    expect(r.added).toEqual([]);
  });
  it('een map die uit Life OS wordt verplaatst neemt de inhoud mee weg', async () => {
    const r = await applyChanges(base(), 'root', [upsert(folder('a', 'media'))], none);
    expect(r.removed.sort()).toEqual(['a', 'b', 'n1']);
    expect(ids(r)).toEqual(['n2', 'root']);
  });
  it('een map die naar Life OS wordt verplaatst haalt de inhoud op (daar zijn geen change-records voor)', async () => {
    const tree: Record<string, DriveFile[]> = { moved: [md('m1', 'moved'), folder('sub', 'moved')], sub: [md('m2', 'sub')] };
    const list = async (parents: string[]) => parents.flatMap((p) => tree[p] ?? []);
    const r = await applyChanges(base(), 'root', [upsert(folder('moved', 'a'))], list);
    expect(r.added.sort()).toEqual(['m1', 'm2', 'moved', 'sub']);
  });
  it('hernoemen en verplaatsen binnen Life OS tellen als gewijzigd', async () => {
    const r = await applyChanges(base(), 'root', [upsert({ ...md('n1', 'a'), name: 'nieuw.md' })], none);
    expect(r.modified).toEqual(['n1']);
    expect(r.removed).toEqual([]);
  });
});
