// Guards for the H2b accessibility fixes that live in CSS: colour pairs (R2-10) and scalable text (R2-14).
// Reads the real stylesheet, so a future colour tweak that drops below WCAG fails here.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css: string = readFileSync(new URL('./style.css', import.meta.url), 'utf8');

function tokens(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of block.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})/gi)) out[m[1]] = m[2].toLowerCase();
  return out;
}
const lightBlock = css.slice(css.indexOf(':root {'), css.indexOf('@media (prefers-color-scheme: dark)'));
const darkBlock = css.slice(css.indexOf('@media (prefers-color-scheme: dark)'), css.indexOf('* { box-sizing'));
const light = tokens(lightBlock);
const dark = { ...light, ...tokens(darkBlock) };

const lum = (hex: string) => {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const ratio = (a: string, b: string) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };

// [foreground token, background token, minimum]
const TEXT = 4.5, UI = 3;
const pairs: [string, string, number][] = [
  ...['bg', 'bg2', 'card', 'tint'].flatMap((bg): [string, string, number][] => [['ink', bg, TEXT], ['mute', bg, TEXT], ['accent-text', bg, TEXT]]),
  ['accent-ink', 'accent', TEXT], // text on the green buttons
  ['accent', 'bg', UI], ['accent', 'bg2', UI], ['accent', 'card', UI], // focus ring, checked task box
  ['mute', 'bg', UI], ['mute', 'card', UI], // open task box border
  ['warn', 'card', UI], // notice card border
];

describe('colour contrast (R2-10)', () => {
  it('reads the stylesheet and both colour schemes', () => {
    expect(css.length).toBeGreaterThan(1000);
    for (const t of [light, dark]) for (const k of ['bg', 'bg2', 'card', 'tint', 'ink', 'mute', 'accent', 'accent-text', 'accent-ink', 'warn']) expect(t[k], k).toMatch(/^#[0-9a-f]{6}$/);
  });
  for (const [name, t] of [['licht', light], ['donker', dark]] as const) {
    it(`${name}: every pair meets its minimum`, () => {
      const failing = pairs
        .map(([fg, bg, min]) => ({ fg, bg, min, r: ratio(t[fg], t[bg]) }))
        .filter((p) => !(p.r >= p.min))
        .map((p) => `${p.fg} op ${p.bg}: ${p.r.toFixed(2)} < ${p.min}`);
      expect(failing).toEqual([]);
    });
  }
});

describe('scalable text (R2-14)', () => {
  it('has no font size in fixed pixels', () => {
    const fixed = [...css.matchAll(/font(?:-size)?:\s*[^;]*?\b\d+(?:\.\d+)?px/g)].map((m) => m[0]);
    expect(fixed).toEqual([]);
  });
});
