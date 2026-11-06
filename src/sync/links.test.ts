import { describe, expect, it } from 'vitest';
import { buildLinkIndex, resolveRelativeLink, resolveWikilink } from './links';
import type { TreeNode } from './types';

const n = (path: string, isFolder = false): TreeNode => ({
  id: path, name: path.split('/').pop()!, mimeType: '', parent: null, isFolder, isMd: !isFolder && path.endsWith('.md'),
  modifiedTime: '', md5Checksum: '', size: 0, path,
});
const idx = buildLinkIndex([
  n('CLAUDE.md'), n('MEMORY.md'), n('02 Areas/Werk/MEMORY.md'), n('02 Areas/Gezin/MEMORY.md'), n('02 Areas/Werk/Notes/Idee.md'),
  n('00 Resources/personal-profile.md'), n('02 Areas/Werk', true), n('02 Areas/Werk/offerte.pdf'),
  n('01 Projects/A/Resources/Idee.md'),
]);

describe('wikilinks (op bestandsnaam zonder .md, zoals Obsidian)', () => {
  it('resolveert op naam, ongeacht hoofdletters en met of zonder .md', () => {
    expect(resolveWikilink('Personal-Profile', 'CLAUDE.md', idx).node!.path).toBe('00 Resources/personal-profile.md');
    expect(resolveWikilink('personal-profile.md', 'CLAUDE.md', idx).node!.path).toBe('00 Resources/personal-profile.md');
  });
  it('splitst alias en kop af', () => {
    const r = resolveWikilink('personal-profile#Werk|mijn profiel', 'CLAUDE.md', idx);
    expect(r.node!.path).toBe('00 Resources/personal-profile.md');
    expect(r.heading).toBe('Werk');
    expect(r.alias).toBe('mijn profiel');
  });
  it('kiest bij dubbele namen de dichtstbijzijnde, dan de kortste', () => {
    expect(resolveWikilink('MEMORY', '02 Areas/Werk/Notes/Idee.md', idx).node!.path).toBe('02 Areas/Werk/MEMORY.md');
    expect(resolveWikilink('MEMORY', '02 Areas/Gezin/x.md', idx).node!.path).toBe('02 Areas/Gezin/MEMORY.md');
    expect(resolveWikilink('MEMORY', '00 Resources/personal-profile.md', idx).node!.path).toBe('MEMORY.md');
  });
  it('ondersteunt een pad of padeinde', () => {
    expect(resolveWikilink('Gezin/MEMORY', 'CLAUDE.md', idx).node!.path).toBe('02 Areas/Gezin/MEMORY.md');
    expect(resolveWikilink('02 Areas/Werk/MEMORY', 'CLAUDE.md', idx).node!.path).toBe('02 Areas/Werk/MEMORY.md');
  });
  it('vindt andere bestanden op volledige naam en meldt onbekend als null', () => {
    expect(resolveWikilink('offerte.pdf', 'CLAUDE.md', idx).node!.path).toBe('02 Areas/Werk/offerte.pdf');
    expect(resolveWikilink('Bestaat niet', 'CLAUDE.md', idx).node).toBeNull();
    expect(resolveWikilink('#Alleen kop', 'CLAUDE.md', idx).node).toBeNull();
  });
});

describe('relatieve links', () => {
  it('lost ../ en ./ op tegen de map van de notitie', () => {
    expect(resolveRelativeLink('../Gezin/MEMORY.md', '02 Areas/Werk/MEMORY.md', idx)!.path).toBe('02 Areas/Gezin/MEMORY.md');
    expect(resolveRelativeLink('./Notes/Idee.md#kop', '02 Areas/Werk/MEMORY.md', idx)!.path).toBe('02 Areas/Werk/Notes/Idee.md');
    expect(resolveRelativeLink('offerte.pdf', '02 Areas/Werk/MEMORY.md', idx)!.path).toBe('02 Areas/Werk/offerte.pdf');
  });
  it('negeert externe links en paden buiten de vault', () => {
    expect(resolveRelativeLink('https://example.com/a.md', 'CLAUDE.md', idx)).toBeNull();
    expect(resolveRelativeLink('mailto:a@b.nl', 'CLAUDE.md', idx)).toBeNull();
    expect(resolveRelativeLink('../../x.md', 'CLAUDE.md', idx)).toBeNull();
    expect(resolveRelativeLink('niet-aanwezig.md', 'CLAUDE.md', idx)).toBeNull();
  });
  it('decodeert %20', () => {
    expect(resolveRelativeLink('00%20Resources/personal-profile.md', 'CLAUDE.md', idx)!.path).toBe('00 Resources/personal-profile.md');
  });
});
