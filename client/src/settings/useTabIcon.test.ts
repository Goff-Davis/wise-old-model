import { renderHook } from '@testing-library/react';
import type { Settings } from '@wom/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { headCrop } from './pixelate.ts';
import { useTabIcon } from './useTabIcon.ts';

const pixelatedPicture = vi.hoisted(() => vi.fn<(url: string) => Promise<string>>());

vi.mock('./pixelate.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./pixelate.ts')>()),
  pixelatedPicture,
}));

const HEAD = '/api/icons/wiki/Wise_Old_Man_chathead.png';
const FACE = 'data:image/png;base64,RkFDRQ==';

const icons = () => [...document.head.querySelectorAll<HTMLLinkElement>('link[rel="icon"]')];

/** The tab's icon as the page names it: its address and type. */
const shown = () => {
  const [link] = icons();
  return link && { href: link.getAttribute('href'), type: link.getAttribute('type') };
};

type Choice = Settings['tabIcon'] | undefined;

const render = (choice: Choice) =>
  renderHook((props: { choice: Choice }) => useTabIcon(props.choice), {
    initialProps: { choice },
  });

beforeEach(() => {
  pixelatedPicture.mockReset();
});

describe('useTabIcon', () => {
  it("shows the pixel art, adding the tab's icon when the page has none", () => {
    render('pixel-art');
    expect(icons()).toHaveLength(1);
    expect(shown()).toEqual({ href: '/favicon.svg', type: 'image/svg+xml' });
  });

  it("shows the game's Partyhat & specs, changing the icon already there", () => {
    const { rerender } = render('pixel-art');
    rerender({ choice: 'partyhat' });
    expect(icons()).toHaveLength(1);
    expect(shown()).toEqual({ href: '/api/icons/item/12399', type: 'image/png' });
  });

  it("shows the wiki's Wise Old Man, pixelated", async () => {
    pixelatedPicture.mockResolvedValue(FACE);
    render('wise-old-man');
    await vi.waitFor(() => expect(shown()).toEqual({ href: FACE, type: 'image/png' }));
    expect(pixelatedPicture).toHaveBeenCalledWith(HEAD, headCrop, 16, 2);
  });

  it("shows the pixel art when the Wise Old Man can't be loaded or pixelated", async () => {
    const { rerender } = render('partyhat');
    pixelatedPicture.mockRejectedValue(new Error("This browser can't draw pictures."));
    rerender({ choice: 'wise-old-man' });
    await vi.waitFor(() =>
      expect(shown()).toEqual({ href: '/favicon.svg', type: 'image/svg+xml' }),
    );
  });

  it('keeps a choice made while the Wise Old Man was still being pixelated', async () => {
    let finish = (_href: string) => {};
    pixelatedPicture.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const { rerender } = render('wise-old-man');
    rerender({ choice: 'pixel-art' });
    finish(FACE);
    await Promise.resolve();
    await Promise.resolve();
    expect(shown()).toEqual({ href: '/favicon.svg', type: 'image/svg+xml' });
  });

  it('keeps a choice made while the Wise Old Man was failing to load', async () => {
    let fail = (_error: Error) => {};
    pixelatedPicture.mockReturnValue(new Promise((_resolve, reject) => (fail = reject)));
    const { rerender } = render('wise-old-man');
    rerender({ choice: 'partyhat' });
    fail(new Error("The wiki didn't answer."));
    await Promise.resolve();
    await Promise.resolve();
    expect(shown()).toEqual({ href: '/api/icons/item/12399', type: 'image/png' });
  });

  it("leaves the page's icon alone until the settings have loaded", () => {
    // One the page already shows, as if left from an earlier choice, so nothing put there matches.
    const link = document.createElement('link');
    link.rel = 'icon';
    link.setAttribute('href', '/api/icons/item/12399');
    document.head.append(link);
    render(undefined);
    expect(icons()).toEqual([link]);
    expect(link.getAttribute('href')).toBe('/api/icons/item/12399');
    expect(pixelatedPicture).not.toHaveBeenCalled();
  });
});
