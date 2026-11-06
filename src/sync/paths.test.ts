import { describe, expect, it } from 'vitest';
import { buildTree, filterToRoot, summarize } from './paths';
import { FOLDER_MIME, type DriveFile } from './types';

const folder = (id: string, name: string, parent: string): DriveFile => ({ id, name, mimeType: FOLDER_MIME, parents: [parent] });
const file = (id: string, name: string, parent: string): DriveFile => ({ id, name, mimeType: 'text/markdown', parents: [parent], md5Checksum: id });
const map = (...fs: DriveFile[]) => new Map(fs.map((f) => [f.id, f]));

describe('padopbouw', () => {
  const all = map(
    folder('root', 'Life OS', 'drive'), folder('a', '02 Areas', 'root'), folder('w', 'Werk', 'a'),
    file('m1', 'MEMORY.md', 'w'), file('m2', 'CLAUDE.md', 'root'), file('x', 'notes.txt', 'w'),
  );
  it('bouwt paden relatief aan Life OS', () => {
    const t = buildTree(filterToRoot(all, 'root'), 'root');
    expect(t.get('root')!.path).toBe('');
    expect(t.get('w')!.path).toBe('02 Areas/Werk');
    expect(t.get('m1')!.path).toBe('02 Areas/Werk/MEMORY.md');
    expect(t.get('m2')!.path).toBe('CLAUDE.md');
  });
  it('markeert md, mappen en andere bestanden', () => {
    const t = buildTree(filterToRoot(all, 'root'), 'root');
    expect(summarize(t, 'root')).toEqual({ md: 2, folders: 2, otherFiles: 1 });
    expect(t.get('x')!.isMd).toBe(false);
    expect(buildTree(map(file('q', 'README.MD', 'root'), folder('root', 'Life OS', 'd')), 'root').get('q')!.isMd).toBe(true);
  });
  it('laat dingen buiten Life OS, getrashte items en lussen weg', () => {
    const odd = map(
      folder('root', 'Life OS', 'drive'), folder('media', 'Media', 'drive'), file('out', 'a.md', 'media'),
      { ...file('gone', 'b.md', 'root'), trashed: true }, folder('c1', 'c1', 'c2'), folder('c2', 'c2', 'c1'),
      file('orphan', 'o.md', 'unknown'), file('in', 'in.md', 'root'),
    );
    expect([...filterToRoot(odd, 'root').keys()].sort()).toEqual(['in', 'root']);
  });
});
