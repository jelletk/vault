import { describe, expect, it } from 'vitest';
import { previewOf, renderMarkdown, slugify, splitFrontmatter } from './markdown';
import { buildLinkIndex } from './sync/links';
import type { TreeNode } from './sync/types';

const n = (path: string, id = path, isFolder = false): TreeNode => ({
  id, name: path.split('/').pop()!, mimeType: '', parent: null, isFolder, isMd: path.endsWith('.md'),
  modifiedTime: '', md5Checksum: '', size: 0, path,
});
const index = buildLinkIndex([
  n('MEMORY.md', 'mem'), n('02 Areas/Werk/MEMORY.md', 'werk'), n('02 Areas/Werk/Offerte <b>.md', 'off'),
  n('02 Areas/Werk/plaat.png', 'png'), n('CLAUDE.md', 'claude'),
]);
const render = (s: string, from = 'CLAUDE.md') => renderMarkdown(s, { fromPath: from, index });

describe('frontmatter', () => {
  it('splits and ignores a lone ---', () => {
    expect(splitFrontmatter('---\na: 1\n---\n# Kop')).toEqual({ front: 'a: 1', body: '# Kop' });
    expect(splitFrontmatter('# Kop\n---\ntekst').front).toBeNull();
    expect(splitFrontmatter('---\nzonder einde').front).toBeNull();
  });
});

describe('rendering', () => {
  it('shows raw html as text (html:false)', () => {
    const h = render('hallo <script>alert(1)</script> <img src=x onerror=alert(1)>');
    expect(h).not.toContain('<script>');
    expect(h).not.toContain('<img');
    expect(h).toContain('&lt;script&gt;');
  });
  it('blocks javascript: links', () => {
    // markdown-it refuses the link and leaves plain, escaped text: no anchor, no href.
    const h = render('[x](javascript:alert(1))');
    expect(h).not.toContain('<a');
    expect(h).not.toContain('href');
  });
  it('wraps tables and renders task lists as disabled checkboxes', () => {
    const h = render('| a | b |\n| - | - |\n| 1 | 2 |\n\n- [x] klaar\n- [ ] open');
    expect(h).toContain('<div class="tablewrap"><table>');
    expect((h.match(/disabled/g) || []).length).toBe(2);
    expect(h).toContain('checked');
  });
  it('resolves wikilinks, aliases, headings, other files and unknown targets', () => {
    expect(render('[[MEMORY]]')).toContain('href="/n/mem"');
    expect(render('[[Werk/MEMORY|het werk]]')).toMatch(/href="\/n\/werk".*>het werk</);
    expect(render('[[CLAUDE#Sessie start]]')).toContain('href="/n/claude#sessie-start"');
    expect(render('[[plaat.png]]')).toContain('drive.google.com/file/d/png/view');
    const broken = render('[[Bestaat niet]]');
    expect(broken).toContain('class="broken"');
    expect(broken).not.toContain('href');
  });
  it('escapes file names that look like html', () => {
    const h = render('[[Offerte <b>]]');
    expect(h).not.toContain('<b>');
    expect(h).toContain('Offerte &lt;b&gt;');
  });
  it('resolves relative links and marks unknown ones', () => {
    expect(render('[w](02%20Areas/Werk/MEMORY.md)')).toContain('href="/n/werk"');
    expect(render('[w](../../MEMORY.md)', '02 Areas/Werk/MEMORY.md')).toContain('data-nav');
    expect(render('[w](nope.md)')).toContain('class="broken"');
    expect(render('[g](https://example.com)')).toContain('rel="noopener noreferrer"');
  });
  it('gives headings unique ids and supports same-note anchors', () => {
    const h = render('# Kop\n\n## Kop\n\n[ga](#kop)');
    expect(h).toContain('id="kop"');
    expect(h).toContain('id="kop-1"');
    expect(h).toContain('data-anchor="kop"');
  });
  it('shows images as text', () => {
    const h = render('![alt tekst](x.png)');
    expect(h).not.toContain('<img');
    expect(h).toContain('alt tekst');
  });
});

describe('previewOf', () => {
  it('skips frontmatter, headings and tables', () => {
    const p = previewOf('---\na: 1\n---\n# Kop\n\n| a | b |\n\nEerste **zin** met [[Link|alias]].');
    expect(p).toBe('Eerste zin met alias.');
  });
  it('slugifies like headings', () => { expect(slugify('Één kop, met: leestekens!')).toBe('een-kop-met-leestekens'); });
});
