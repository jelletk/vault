// Markdown -> safe HTML for notes. markdown-it runs with html:false, so raw HTML in a note is shown as text,
// and every piece of text we add ourselves (file names, link labels) is escaped.
import MarkdownIt from 'markdown-it';
import taskLists from 'markdown-it-task-lists';
import { resolveRelativeLink, resolveWikilink, type LinkIndex } from './sync/links';
import { driveUrl } from './nav';

export interface RenderEnv {
  fromPath: string;
  index: LinkIndex;
  /** heading ids already used in this note (for unique anchors) */
  slugs?: Map<string, number>;
}

/** Splits YAML frontmatter (`---` ... `---` at the very start) from the body. */
export function splitFrontmatter(src: string): { front: string | null; body: string } {
  const m = src.replace(/^﻿/, '').match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!m) return { front: null, body: src };
  return { front: m[1], body: src.replace(/^﻿/, '').slice(m[0].length) };
}

export function slugify(s: string): string {
  return s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, '').trim().replace(/\s+/g, '-');
}

const md = new MarkdownIt({ html: false, linkify: true, breaks: false });
md.use(taskLists, { enabled: false, label: false }); // checkboxes are shown, never changed (read-only app)
const esc = md.utils.escapeHtml;

// --- [[wikilinks]] as an inline rule ---
md.inline.ruler.before('link', 'wikilink', (state, silent) => {
  const s = state.src, p = state.pos;
  if (s.charCodeAt(p) !== 0x5b || s.charCodeAt(p + 1) !== 0x5b) return false;
  const end = s.indexOf(']]', p + 2);
  if (end < 0) return false;
  const inner = s.slice(p + 2, end);
  if (!inner.trim() || inner.includes('\n') || inner.includes('[')) return false;
  if (!silent) {
    const t = state.push('wikilink', '', 0);
    t.content = inner;
  }
  state.pos = end + 2;
  return true;
});

function noteHref(id: string, heading: string | null): string {
  return `/n/${encodeURIComponent(id)}` + (heading ? '#' + encodeURIComponent(slugify(heading)) : '');
}

md.renderer.rules.wikilink = (tokens, i, _o, env: any) => {
  const inner = tokens[i].content;
  const targetPart = inner.split('|')[0];
  if (targetPart.trim().startsWith('#')) {
    const heading = targetPart.trim().slice(1);
    const label = inner.includes('|') ? inner.split('|').slice(1).join('|').trim() : heading;
    return `<a class="wl" href="#${encodeURIComponent(slugify(heading))}" data-anchor="${esc(slugify(heading))}">${esc(label)}</a>`;
  }
  const t = resolveWikilink(inner, env.fromPath, env.index);
  const shown = t.alias ?? targetPart.trim().replace(/^.*\//, '').replace(/\.md$/i, '');
  const label = t.alias ?? (t.heading ? `${shown} › ${t.heading}` : shown);
  if (!t.node) return `<a class="broken" title="niet gevonden">${esc(label)}</a>`;
  if (t.node.isMd) return `<a class="wl" href="${noteHref(t.node.id, t.heading)}" data-nav="1">${esc(label)}</a>`;
  return `<a class="wl ext" href="${esc(driveUrl(t.node.id))}" target="_blank" rel="noopener noreferrer">${esc(label)}</a>`;
};

// --- normal links: external, anchors, relative paths ---
md.renderer.rules.link_open = (tokens, i, _o, env: any) => {
  const tok = tokens[i];
  const href = String(tok.attrGet('href') ?? '');
  if (/^https?:\/\//i.test(href)) {
    return `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">`;
  }
  if (/^(mailto|tel):/i.test(href)) return `<a href="${esc(href)}">`;
  if (href.startsWith('#')) {
    let a = href.slice(1);
    try { a = decodeURIComponent(a); } catch { /* keep raw */ }
    return `<a href="${esc(href)}" data-anchor="${esc(slugify(a))}">`;
  }
  const hashAt = href.indexOf('#');
  const frag = hashAt >= 0 ? href.slice(hashAt + 1) : null;
  const node = resolveRelativeLink(href, env.fromPath, env.index);
  if (!node) return `<a class="broken" title="niet gevonden">`;
  if (node.isMd) {
    let heading: string | null = null;
    if (frag) { try { heading = decodeURIComponent(frag); } catch { heading = frag; } }
    return `<a class="wl" href="${noteHref(node.id, heading)}" data-nav="1">`;
  }
  return `<a class="wl ext" href="${esc(driveUrl(node.id))}" target="_blank" rel="noopener noreferrer">`;
};

// Images are not loaded (no network for them, CSP img-src 'self'): show the alt text instead.
md.renderer.rules.image = (tokens, i) => `<span class="img">${esc(tokens[i].content || 'afbeelding')}</span>`;

// Headings get stable ids for #anchors.
md.renderer.rules.heading_open = (tokens, i, _o, env: any, self) => {
  const text = tokens[i + 1]?.content ?? '';
  const base = slugify(text) || 'kop';
  const seen = (env.slugs ??= new Map());
  const n = seen.get(base) ?? 0;
  seen.set(base, n + 1);
  tokens[i].attrSet('id', n ? `${base}-${n}` : base);
  return self.renderToken(tokens, i, _o);
};

// Tables scroll inside their own card on a phone.
md.renderer.rules.table_open = () => '<div class="tablewrap"><table>';
md.renderer.rules.table_close = () => '</table></div>';

export function renderMarkdown(body: string, env: any): string {
  return md.render(body, { ...env, slugs: new Map() });
}

/** First readable lines of a note, as plain text, for the preview on a card. */
export function previewOf(src: string, max = 180): string {
  const { body } = splitFrontmatter(src);
  const out: string[] = [];
  let inCode = false;
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('```')) { inCode = !inCode; continue; }
    if (inCode || !line || /^#{1,6}\s/.test(line) || /^[-*_]{3,}$/.test(line) || /^\|/.test(line)) continue;
    out.push(line.replace(/!?\[\[([^\]|]*\|)?([^\]]*)\]\]/g, '$2').replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/^[-*+]\s+(\[[ xX]\]\s+)?/, '').replace(/^>\s?/, '').replace(/[*_`~]/g, ''));
    if (out.join(' ').length >= max) break;
  }
  const text = out.join(' ');
  return text.length > max ? text.slice(0, max - 1).trimEnd() + '…' : text;
}
