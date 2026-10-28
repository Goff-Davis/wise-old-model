import { afterEach, describe, expect, it } from 'vitest';
import indexHtmlSource from '../../index.html?raw';
import { THEME_HINT_KEY } from '../settings/useSettings.ts';

const indexHtml = new DOMParser().parseFromString(indexHtmlSource, 'text/html');

/** Sets this document up like index.html, then runs its inline script, as a browser would. */
function loadIndexHtml(): HTMLMetaElement {
  document.documentElement.dataset.theme = indexHtml.documentElement.dataset.theme;
  const meta = indexHtml.querySelector('meta[name="color-scheme"]')?.cloneNode() as HTMLMetaElement;
  document.head.append(meta);
  const script = indexHtml.querySelector('script:not([src])')?.textContent ?? '';
  new Function(script)();
  return meta;
}

afterEach(() => {
  for (const meta of document.head.querySelectorAll('meta[name="color-scheme"]')) meta.remove();
});

describe('index.html', () => {
  it('starts dark, with a dark page behind it even on a light-mode computer', () => {
    const meta = loadIndexHtml();
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(meta.content).toBe('dark');
  });

  it('applies the theme remembered last time before the app loads, so light never flashes dark', () => {
    localStorage.setItem(THEME_HINT_KEY, 'light');
    const meta = loadIndexHtml();
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(meta.content).toBe('light');
  });

  it('ignores anything else found under that key', () => {
    localStorage.setItem(THEME_HINT_KEY, 'purple');
    loadIndexHtml();
    expect(document.documentElement.dataset.theme).toBe('dark');
  });
});
