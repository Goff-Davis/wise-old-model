import { describe, expect, it } from 'vitest';

/** Every stylesheet in the client, by path, as text. */
const SHEETS = import.meta.glob<string>('../**/*.css', {
  query: '?raw',
  import: 'default',
  eager: true,
});

/** Every rule in the client's stylesheets, as [where, selector, declarations], comments dropped. */
function rules(): [where: string, selector: string, body: string][] {
  return Object.entries(SHEETS).flatMap(([file, text]) => {
    const css = text.replace(/\/\*[\s\S]*?\*\//g, '');
    // The innermost blocks: a rule inside @media is matched on its own.
    return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(
      ([, selector = '', body = '']): [string, string, string] => [
        file.replace('../', ''),
        selector.trim(),
        body,
      ],
    );
  });
}

describe('scroll boxes', () => {
  it('are positioned, so what is positioned inside them (hidden text) scrolls and clips with them', () => {
    // A box that scrolls but isn't positioned lets an absolutely positioned descendant, such as
    // .visually-hidden text, belong to a box outside it: the text then sits where it would be in
    // the scrolled content, far outside the box, and makes the box around it scroll too.
    const all = rules();
    const scrolling = all.filter(([, , body]) =>
      /overflow(-[xy]|-block|-inline)?:\s*(auto|scroll)/.test(body),
    );
    expect(scrolling.length).toBeGreaterThan(4);
    const unpositioned = scrolling
      .filter(([, , body]) => !/position:\s*(relative|absolute|fixed|sticky)/.test(body))
      .map(([where, selector]) => `${where}: ${selector}`);
    expect(unpositioned).toEqual([]);
  });
});
