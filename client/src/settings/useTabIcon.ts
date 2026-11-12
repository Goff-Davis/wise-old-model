import type { Settings } from '@wom/shared';
import { useEffect } from 'react';
import { headCrop, pixelatedPicture } from './pixelate.ts';

type TabIcon = { href: string; type: string };

/**
 * The icons kept as they are: the app's pixel art (index.html's own, so it shows before the app
 * loads), and RuneLite's icon of item 12399, Partyhat & specs, the Wise Old Man's own hat.
 */
const ICONS = {
  'pixel-art': { href: '/favicon.svg', type: 'image/svg+xml' },
  partyhat: { href: '/api/icons/item/12399', type: 'image/png' },
} satisfies Record<string, TabIcon>;

/** The wiki's picture of the Wise Old Man's head, which is pixelated for the tab. */
const HEAD = '/api/icons/wiki/Wise_Old_Man_chathead.png';

/** Puts an icon on the browser tab, through the page's icon link (added if it has none). */
function show(icon: TabIcon): void {
  let link = document.head.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!link) {
    link = document.createElement('link');
    link.rel = 'icon';
    document.head.append(link);
  }
  link.type = icon.type;
  link.href = icon.href;
}

/**
 * Keeps the browser tab's icon to the setting. The Wise Old Man is pixelated in the page, 16
 * pixels square shown at 32 so they stay sharp. Until he's ready the last icon stays, and if his
 * picture can't be loaded (the wiki is down) or drawn, the pixel art shows instead.
 */
export function useTabIcon(choice: Settings['tabIcon'] | undefined): void {
  useEffect(() => {
    if (!choice) return;
    if (choice !== 'wise-old-man') {
      show(ICONS[choice]);
      return;
    }
    let current = true;
    pixelatedPicture(HEAD, headCrop, 16, 2).then(
      (href) => current && show({ href, type: 'image/png' }),
      () => current && show(ICONS['pixel-art']),
    );
    return () => {
      current = false;
    };
  }, [choice]);
}
