import { describe, expect, it } from 'vitest';
import tokens from './tokens.css?raw';

/** The colors a rule block in tokens.css sets, by token name without its dashes. */
function colorsIn(selector: string): Record<string, string> {
  const start = tokens.indexOf(`${selector} {`);
  const body = tokens.slice(start, tokens.indexOf('}', start));
  return Object.fromEntries(
    [...body.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6});/gi)].map(([, name = '', hex = '']) => [
      name,
      hex,
    ]),
  );
}

/** Each theme's colors, as its own block sets them (light borrows none of dark's). */
const THEMES = { dark: colorsIn(':root'), light: colorsIn(':root[data-theme="light"]') };

/** A color's relative luminance, as WCAG defines it. */
function luminance(hex: string): number {
  const [r = 0, g = 0, b = 0] = [1, 3, 5].map((at) => {
    const channel = Number.parseInt(hex.slice(at, at + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG's contrast ratio between two colors, from 1 to 21. */
function contrast(a: string, b: string): number {
  const [light, darker] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (light + 0.05) / (darker + 0.05);
}

/** The surfaces text and controls sit on. */
const SURFACES = ['bg', 'panel', 'raised'];
/** The colors text is written in. */
const TEXT = ['text', 'muted', 'accent', 'not-started', 'in-progress', 'done'];
/** Every color the checks below use. */
const CHECKED = [
  ...SURFACES,
  ...TEXT,
  'tile',
  'tile-name',
  'tile-level',
  'stack-thousands',
  'stack-millions',
  'control-border',
];

/** Each pair of `colors` that falls short of `ratio` against `on`, as "fg on bg (ratio)". */
function shortOf(
  theme: Record<string, string>,
  colors: string[],
  on: string[],
  ratio: number,
): string[] {
  return colors.flatMap((fg) =>
    on
      .map((bg) => ({ bg, value: contrast(theme[fg] ?? '', theme[bg] ?? '') }))
      .filter(({ value }) => !(value >= ratio))
      .map(({ bg, value }) => `${fg} on ${bg} (${value.toFixed(2)})`),
  );
}

describe.each(Object.entries(THEMES))('the %s theme', (_name, theme) => {
  it('has every color it is checked by', () => {
    expect(CHECKED.filter((name) => !theme[name])).toEqual([]);
  });

  it('writes text at 7:1 or more on every surface (WCAG 1.4.6, AAA)', () => {
    expect(shortOf(theme, TEXT, SURFACES, 7)).toEqual([]);
  });

  it('writes a primary button, in the background color on the accent, at 7:1 or more', () => {
    expect(shortOf(theme, ['bg'], ['accent'], 7)).toEqual([]);
  });

  it('writes the stats tiles and stack sizes at 7:1 or more', () => {
    expect(shortOf(theme, ['tile-name', 'tile-level'], ['tile'], 7)).toEqual([]);
    // Stack sizes sit on the inventory, which is the background.
    expect(shortOf(theme, ['tile-level', 'stack-thousands', 'stack-millions'], ['bg'], 7)).toEqual(
      [],
    );
  });

  it("draws the focus ring and controls' borders at 3:1 or more (WCAG 1.4.11, 2.4.13)", () => {
    expect(shortOf(theme, ['accent', 'control-border'], SURFACES, 3)).toEqual([]);
  });
});

describe('the themes', () => {
  it('are each read from their own block: light text on dark, and dark text on light', () => {
    const { dark, light } = THEMES;
    expect(luminance(dark.text ?? '')).toBeGreaterThan(luminance(dark.bg ?? ''));
    expect(luminance(light.text ?? '')).toBeLessThan(luminance(light.bg ?? ''));
  });
});

describe('contrast', () => {
  it('measures as WCAG does', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21);
    expect(contrast('#777777', '#ffffff')).toBeCloseTo(4.48, 2);
    expect(contrast('#ffffff', '#777777')).toBeCloseTo(4.48, 2);
    // A dark grey, on the curve's other side.
    expect(contrast('#333333', '#ffffff')).toBeCloseTo(12.6, 1);
  });
});
