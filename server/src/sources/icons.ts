import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { MINUTE_MS, WIKI_ICON_FILE } from '@wom/shared';
import { NotFoundError, type Requester, SourceError, siteOf } from '../http/requester.ts';
import { shareIn } from '../store/cache.ts';

/** An icon to serve: where it's kept in the data folder, and where it comes from. */
export type IconSource = { kind: 'wiki' | 'item'; file: string; url: string };

const ITEM_ID = /^\d{1,6}$/;

/** A wiki image by file name (`Attack_icon.png`), or null for a name that isn't one. */
export function wikiIcon(file: string): IconSource | null {
  if (!WIKI_ICON_FILE.test(file)) return null;
  return {
    kind: 'wiki',
    file,
    url: `https://oldschool.runescape.wiki/images/${encodeURIComponent(file)}`,
  };
}

/** RuneLite's icon for an item id (it covers untradeable items too), or null for a bad id. */
export function itemIcon(id: string): IconSource | null {
  if (!ITEM_ID.test(id)) return null;
  const number = Number(id);
  return {
    kind: 'item',
    file: `${number}.png`,
    url: `https://static.runelite.net/cache/item/icon/${number}.png`,
  };
}

export type IconStore = { get(icon: IconSource): Promise<Uint8Array> };

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** How long a site whose icon fetch failed is left alone. */
const ICON_RETRY_MS = MINUTE_MS;

/** The icon kept on disk, or null when there isn't one (or it can't be read). */
async function readKept(file: string): Promise<Uint8Array | null> {
  try {
    return await readFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error(`Couldn't read the icon ${file}:`, error);
    }
    return null;
  }
}

/** Writes an icon whole (a partial file renamed into place); failing that, it's served anyway. */
async function keep(icon: IconSource, file: string, bytes: Uint8Array): Promise<void> {
  const partial = `${file}.${process.pid}.partial`;
  try {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(partial, bytes);
    await rename(partial, file);
  } catch (error) {
    console.error(`Couldn't keep the icon ${icon.file}, so it will be fetched again:`, error);
    await rm(partial, { force: true }).catch(() => {});
  }
}

/**
 * Game icons, fetched once through the requester and kept in `<dataDir>/icons/<kind>/` for good.
 * A file is written whole or not at all, so an interrupted fetch never leaves half an icon, and
 * two pages asking for the same icon at once share one fetch. An answer that isn't a PNG is a
 * failure. An icon the site doesn't have isn't asked for again while the server runs, and a site
 * that failed isn't asked for any icon for a minute, so pages full of icons can't hold up its
 * queue (which the chat's wiki lookups share) during an outage.
 */
export function createIconStore(
  req: Requester,
  dataDir: string,
  opts: { now?: () => number } = {},
): IconStore {
  const now = opts.now ?? Date.now;
  const inFlight = new Map<string, Promise<Uint8Array>>();
  const missing = new Map<string, NotFoundError>();
  const failed = new Map<IconSource['kind'], { at: number; error: SourceError }>();

  async function fetchIcon(icon: IconSource): Promise<Uint8Array> {
    const bytes = await req.bytes(icon.url);
    if (!PNG_SIGNATURE.every((byte, i) => bytes[i] === byte)) {
      const site = siteOf(icon.url);
      throw new SourceError(site, null, `${site}: the answer wasn't an image`);
    }
    return bytes;
  }

  async function load(icon: IconSource, key: string): Promise<Uint8Array> {
    const file = path.join(dataDir, 'icons', icon.kind, icon.file);
    const kept = await readKept(file);
    if (kept) return kept;

    const gone = missing.get(key);
    if (gone) throw gone;
    const down = failed.get(icon.kind);
    if (down && now() - down.at < ICON_RETRY_MS) throw down.error;
    let bytes: Uint8Array;
    try {
      bytes = await fetchIcon(icon);
    } catch (error) {
      if (error instanceof NotFoundError) missing.set(key, error);
      else if (error instanceof SourceError) failed.set(icon.kind, { at: now(), error });
      throw error;
    }
    await keep(icon, file, bytes);
    return bytes;
  }

  return {
    get(icon) {
      const key = `${icon.kind}/${icon.file}`;
      return shareIn(inFlight, key, () => load(icon, key));
    },
  };
}
