import { capitalize, DAY_MS, squeeze } from '@wom/shared';
import type { Kysely } from 'kysely';
import { HTMLElement, type Node, parse, TextNode } from 'node-html-parser';
import { z } from 'zod';
import type { DB } from '../db/schema.ts';
import { NotFoundError, type Requester, SourceError } from '../http/requester.ts';
import {
  type CacheEntry,
  type CacheRow,
  cachedEntry,
  cacheRowsBefore,
  isFresh,
  markCacheOutdated,
  perDatabase,
  readCache,
  savedEntry,
  shareLoad,
  touchCache,
  writeCache,
} from '../store/cache.ts';
import { fetchChecked, parseWith } from './answers.ts';

/** How old a cached answer used was, and, when it's an old copy, why it wasn't fetched again. */
export type CacheRead = { kind: string; fetchedAt: string; error: string | null };

/**
 * What the wiki and prices sources need. `noteRead` is told about every cached answer they use,
 * so a caller (an AI tool) can say how old its data is, and that it's stale and why.
 */
export type WikiCtx = {
  req: Requester;
  db: Kysely<DB>;
  now: () => Date;
  noteRead?: (read: CacheRead) => void;
};

/** cachedEntry's value, telling `ctx.noteRead` how old it is and whether it's an old copy. */
export async function cachedFor<T>(
  ctx: WikiCtx,
  key: string,
  kind: string,
  ttlMs: number,
  load: () => Promise<T>,
): Promise<T> {
  return noted(ctx, kind, await cachedEntry(ctx.db, key, kind, ttlMs, ctx.now(), load));
}

function noted<T>(ctx: WikiCtx, kind: string, entry: CacheEntry<T>): T {
  ctx.noteRead?.({ kind, fetchedAt: entry.fetchedAt, error: entry.error });
  return entry.value;
}

const parsedCopies = perDatabase(() => new Map<string, { fetchedAt: string; value: unknown }>());

/**
 * `parse`'s result for the copy of a cached answer that `read` gives (under `key`), worked out
 * once per copy (by when it was fetched) while the server runs: parsing a whole table costs more
 * than reading it, and the Goals page reloads as you play.
 */
export async function parsedOnce<R, T>(
  ctx: WikiCtx,
  key: string,
  read: (ctx: WikiCtx) => Promise<R>,
  parse: (raw: R) => T,
): Promise<T> {
  let fetchedAt: string | null = null;
  const raw = await read({
    ...ctx,
    noteRead: (cacheRead) => {
      fetchedAt = cacheRead.fetchedAt;
      ctx.noteRead?.(cacheRead);
    },
  });
  const copies = parsedCopies(ctx.db);
  const kept = copies.get(key);
  if (kept && kept.fetchedAt === fetchedAt) return kept.value as T;
  const value = parse(raw);
  if (fetchedAt !== null) copies.set(key, { fetchedAt, value });
  return value;
}

const API = 'https://oldschool.runescape.wiki/api.php';
const SITE = 'OSRS Wiki';
const PAGE_KIND = 'wiki_page';
const TEXT_LIMIT = 4_000;
const TRUNCATED = '… (truncated; ask for a narrower section)';
// The API takes up to 50 titles per query.
const TITLES_PER_REQUEST = 50;

/** A title as the wiki writes it: spaces rather than underscores, and a capital first letter. */
export function pageTitle(title: string): string {
  return capitalize(squeeze(title.replaceAll('_', ' ')));
}

/** A page's URL, at a section when given: `…/w/Dragon_Slayer_II#Starting_off`. */
export function wikiUrl(title: string, section?: string): string {
  const part = (text: string) =>
    encodeURIComponent(text.replaceAll(' ', '_')).replaceAll('%2F', '/').replaceAll('%3A', ':');
  const anchor = section ? `#${part(section)}` : '';
  return `https://oldschool.runescape.wiki/w/${part(pageTitle(title))}${anchor}`;
}

/** A link's page, as the wiki names it: `[[Dragon_Slayer_I#Rewards|…]]` is Dragon Slayer I. */
export const linkPage = (target: string) => target.split('#')[0].replaceAll('_', ' ').trim();

/** Whether a link's target is a file (an icon), which is no page. */
export const isFileLink = (target: string) => /^\s*(file|image):/i.test(target);

// A link, `[[Target#Section|Text]]`, its target in the first group.
const LINK_PATTERN = String.raw`\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]`;

/** Every link in a piece of wikitext, for `matchAll` and `replace`. */
export const LINK = new RegExp(LINK_PATTERN, 'g');

const LONE_LINK = new RegExp(`^${LINK_PATTERN}\\s*$`);

/** The pages a piece of wikitext links to, in order, leaving out files. */
export const linkPages = (text: string) =>
  [...text.matchAll(LINK)]
    .map((link) => link[1])
    .filter((target) => !isFileLink(target))
    .map(linkPage);

/** The page a line links to when it's that link (to a page, not a file) and nothing else. */
export function loneLink(text: string): string | undefined {
  const target = LONE_LINK.exec(text)?.[1];
  return target !== undefined && !isFileLink(target) ? linkPage(target) : undefined;
}

/** The API's own refusal (`{ error: { code, info } }`), or Bucket's (`{ error: "…" }`). */
const RefusalSchema = z.object({
  error: z.union([z.string(), z.object({ code: z.string(), info: z.string() })]),
});

/**
 * One API call, checked against `schema`. A refusal is a SourceError giving the wiki's reason,
 * and a page that doesn't exist a NotFoundError.
 */
async function callApi<T>(
  ctx: WikiCtx,
  params: Record<string, string>,
  schema: z.ZodType<T>,
): Promise<T> {
  const url = `${API}?${new URLSearchParams({ ...params, format: 'json', formatversion: '2' })}`;
  const parseAnswer = (json: unknown): T => {
    const refusal = RefusalSchema.safeParse(json);
    if (!refusal.success) return parseWith(SITE, schema, json);
    const { error } = refusal.data;
    if (typeof error !== 'string' && error.code === 'missingtitle') {
      throw new NotFoundError(SITE, null, `${SITE}: there's no page called ${params.page}`);
    }
    throw new SourceError(SITE, null, `${SITE}: ${typeof error === 'string' ? error : error.info}`);
  };
  return (await fetchChecked(ctx.req, url, { parse: parseAnswer })).value;
}

/** HTML (a search snippet, a section's name) as plain text, its entities written out. */
export function plainText(html: string): string {
  return squeeze(parse(html).text);
}

const SearchSchema = z.object({
  query: z.object({ search: z.array(z.object({ title: z.string(), snippet: z.string() })) }),
});

/** The top five pages for a search, with plain-text snippets; a search is asked once a day. */
export async function searchWiki(
  ctx: WikiCtx,
  query: string,
): Promise<{ title: string; snippet: string; url: string }[]> {
  const asked = query.trim();
  return cachedFor(ctx, `search:${asked.toLowerCase()}`, 'wiki_search', DAY_MS, async () => {
    const answer = await callApi(
      ctx,
      { action: 'query', list: 'search', srsearch: asked, srlimit: '5' },
      SearchSchema,
    );
    return answer.query.search.map((hit) => ({
      title: hit.title,
      snippet: plainText(hit.snippet),
      url: wikiUrl(hit.title),
    }));
  });
}

/** Tags whose content starts a line of its own. */
const BLOCK_TAGS = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'caption',
  'center',
  'dd',
  'div',
  'dl',
  'dt',
  'figcaption',
  'figure',
  'footer',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hr',
  'li',
  'main',
  'nav',
  'ol',
  'p',
  'pre',
  'section',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'tr',
  'ul',
]);

/**
 * References, navboxes, the table of contents, edit and map links aren't the page's content;
 * styles and scripts aren't text.
 */
const DROPPED =
  'sup.reference, .navbox, #toc, .toc, .mw-editsection, .mw-kartographer-maplink, style, script';

// The parsed document's root has no tag name, whatever its type says.
const tagOf = (node: Node) =>
  node instanceof HTMLElement ? ((node.rawTagName as string | null) ?? '').toLowerCase() : '';

const isList = (node: Node) => tagOf(node) === 'ul' || tagOf(node) === 'ol';

/**
 * A node's text with blocks spaced apart, each list item ended by a semicolon and a list inside
 * an item put in brackets after it.
 */
function spacedText(node: Node): string {
  if (node instanceof TextNode) return node.text;
  if (!(node instanceof HTMLElement)) return '';
  const tag = tagOf(node);
  if (tag === 'br') return ' ';
  if (tag === 'li') {
    const own = node.childNodes
      .filter((child) => !isList(child))
      .map(spacedText)
      .join('');
    const inner = squeeze(node.childNodes.filter(isList).map(spacedText).join(''));
    return ` ${own}${inner === '' ? '' : ` (${inner})`}; `;
  }
  const text = node.childNodes.map(spacedText).join('');
  return BLOCK_TAGS.has(tag) ? ` ${text} ` : text;
}

/**
 * A table cell's text on one line, its lists kept apart:
 * `75 Magic; Quests: (Legends' Quest (Family Crest); Dream Mentor)`.
 */
function cellText(cell: Node): string {
  return squeeze(spacedText(cell))
    .replace(/(\s*;)+/g, ';')
    .replace(/;\s*\)/g, ')')
    .replace(/;$/, '');
}

/**
 * A section's HTML as lines of plain text: one per heading, paragraph and list item (`- item`,
 * indented under the item it's in), and one per table row (`cell | cell`). Links become their
 * text.
 */
function textLines(root: HTMLElement): string[] {
  const lines: string[] = [];
  let line = '';
  let bullet = '';
  const flush = () => {
    const text = squeeze(line);
    if (text !== '') lines.push(bullet + text);
    line = '';
    bullet = '';
  };
  // `depth` counts the list items the node is in.
  const walk = (node: Node, depth: number): void => {
    if (node instanceof TextNode) {
      line += node.text;
      return;
    }
    if (!(node instanceof HTMLElement)) return;
    const tag = tagOf(node);
    if (tag === 'br') {
      line += ' ';
      return;
    }
    if (tag === 'tr') {
      flush();
      const cells = node.childNodes.filter((cell) => tagOf(cell) === 'td' || tagOf(cell) === 'th');
      line = cells.map(cellText).join(' | ');
      flush();
      return;
    }
    const block = BLOCK_TAGS.has(tag);
    if (block) flush();
    if (tag === 'li') bullet = `${'  '.repeat(depth)}- `;
    for (const child of node.childNodes) walk(child, tag === 'li' ? depth + 1 : depth);
    if (block) flush();
  };
  walk(root, 0);
  flush();
  return lines;
}

/** A section's name and anchor (from its heading) and its text. */
function readSection(html: string): { section: string; anchor: string | null; text: string } {
  const root = parse(html);
  for (const dropped of root.querySelectorAll(DROPPED)) dropped.remove();
  const heading = root.querySelector('h1, h2, h3, h4, h5, h6');
  return {
    // The part before a page's first heading has none.
    section: heading ? squeeze(heading.text) : 'Introduction',
    anchor: heading ? heading.id || (heading.querySelector('.mw-headline')?.id ?? null) : null,
    text: textLines(root).join('\n'),
  };
}

/** The title in a page key, `page:<title>:<part>` (a part has no colon). */
const titleOfKey = (key: string) => key.slice('page:'.length, key.lastIndexOf(':'));

/**
 * Whether a saved part of a page is still the page's current revision. Every other day-old page
 * is checked in the same request (up to 50 pages in all): each unchanged part is dated as
 * checked now, so it isn't checked again for a day, and each changed one is marked out of date
 * (its revision cleared), so it's downloaded when next wanted and left out of later checks.
 */
async function stillCurrent(ctx: WikiCtx, saved: CacheRow, now: Date): Promise<boolean> {
  const dayOld = await cacheRowsBefore(ctx.db, PAGE_KIND, new Date(now.getTime() - DAY_MS));
  const others = dayOld.filter((row) => row.key !== saved.key && row.revision !== null);
  const candidates = [saved, ...others];
  const titles = [...new Set(candidates.map((row) => titleOfKey(row.key)))].slice(
    0,
    TITLES_PER_REQUEST,
  );
  const checked = candidates.filter((row) => titles.includes(titleOfKey(row.key)));
  const current = await latestRevisions(ctx, titles);
  const isCurrent = (row: Pick<CacheRow, 'key' | 'revision'>) => {
    const revision = current[titleOfKey(row.key)];
    return revision !== undefined && String(revision) === row.revision;
  };
  await touchCache(
    ctx.db,
    checked.filter(isCurrent).map((row) => row.key),
    now.toISOString(),
  );
  await markCacheOutdated(
    ctx.db,
    checked.filter((row) => !isCurrent(row)).map((row) => row.key),
  );
  return isCurrent(saved);
}

/**
 * Part of a page (its section list, a section's HTML, its wikitext) from the cache, downloaded when it
 * isn't saved or is known to be out of date. Once a saved copy is a day old, the page's current
 * revision is checked, and the page is downloaded again only if it changed. While the wiki can't
 * be reached, the saved copy is served however old, with the failure. A fetch already under way
 * for the same part is shared.
 */
function pagePart<T>(
  ctx: WikiCtx,
  title: string,
  part: string,
  download: () => Promise<{ revision: number; value: T }>,
): Promise<CacheEntry<T>> {
  const key = `page:${title}:${part}`;
  return shareLoad(ctx.db, key, async () => {
    const now = ctx.now();
    const saved = await readCache(ctx.db, key);
    // A saved part without a revision is known to be out of date.
    const known = saved?.revision !== null ? saved : null;
    if (known && isFresh(known.fetchedAt, DAY_MS, now)) return savedEntry<T>(ctx.db, known, null);
    try {
      if (known && (await stillCurrent(ctx, known, now))) {
        return savedEntry<T>(ctx.db, known, null, now.toISOString());
      }
      const { revision, value } = await download();
      const fetchedAt = now.toISOString();
      await writeCache(ctx.db, {
        key,
        kind: PAGE_KIND,
        fetchedAt,
        revision: String(revision),
        data: JSON.stringify(value),
      });
      return { value, fetchedAt, error: null };
    } catch (error) {
      if (saved && error instanceof SourceError) return savedEntry<T>(ctx.db, saved, error.message);
      throw error;
    }
  });
}

const SectionsSchema = z.object({
  parse: z.object({
    revid: z.number(),
    sections: z.array(z.object({ index: z.string(), line: z.string() })),
  }),
});

/** A page's sections, by index (`'1'`) and name. */
export async function getSections(
  ctx: WikiCtx,
  title: string,
): Promise<{ index: string; line: string }[]> {
  const page = pageTitle(title);
  const entry = await pagePart(ctx, page, 'sections', async () => {
    const answer = await callApi(
      ctx,
      { action: 'parse', page, prop: 'sections|revid', redirects: '1' },
      SectionsSchema,
    );
    // Kept as the wiki sends them (a name can hold HTML), and made plain when read.
    return { revision: answer.parse.revid, value: answer.parse.sections };
  });
  return noted(ctx, PAGE_KIND, entry).map((section) => ({
    index: section.index,
    line: plainText(section.line),
  }));
}

const WikitextSchema = z.object({ parse: z.object({ revid: z.number(), wikitext: z.string() }) });

/** A page's wikitext, kept until the page's revision changes (checked once a day). */
export async function getPageWikitext(ctx: WikiCtx, title: string): Promise<string> {
  const page = pageTitle(title);
  const entry = await pagePart(ctx, page, 'wikitext', async () => {
    const answer = await callApi(
      ctx,
      { action: 'parse', page, prop: 'wikitext|revid', redirects: '1' },
      WikitextSchema,
    );
    return { revision: answer.parse.revid, value: answer.parse.wikitext };
  });
  return noted(ctx, PAGE_KIND, entry);
}

const RenderedSchema = z.object({ parse: z.object({ text: z.string() }) });

/**
 * A whole page's HTML as the wiki renders it, asked once a day: for a page built from other
 * pages (a list the wiki makes with DPL, such as Quests/List), which changes without a revision
 * of its own, so it can't be kept by revision as other pages are.
 */
export async function getRenderedPage(ctx: WikiCtx, title: string): Promise<string> {
  const page = pageTitle(title);
  return cachedFor(ctx, `rendered:${page}`, 'wiki_rendered', DAY_MS, async () => {
    const answer = await callApi(
      ctx,
      {
        action: 'parse',
        page,
        prop: 'text',
        disableeditsection: '1',
        disablelimitreport: '1',
        disabletoc: '1',
        redirects: '1',
      },
      RenderedSchema,
    );
    return answer.parse.text;
  });
}

const SectionTextSchema = z.object({
  parse: z.object({ title: z.string(), revid: z.number(), text: z.string() }),
});

/** A section's index: `1`, or `T-1` for one taken in from a template (rather than its name). */
export const SECTION_INDEX = /^(T-)?\d+$/;

/**
 * One section of a page as plain text, with its URL. A section over 4,000 characters is cut
 * there, saying so, so the AI asks for a narrower one. The page's HTML is what's saved, so a
 * better conversion to text reaches pages already saved.
 */
export async function getSectionText(
  ctx: WikiCtx,
  title: string,
  index: string,
): Promise<{ title: string; section: string; text: string; url: string }> {
  // Checked here, so a mistake (say from the AI's tool call) costs no request.
  if (!SECTION_INDEX.test(index)) {
    throw new RangeError(`"${index}" isn't a section index; getSections lists a page's sections.`);
  }
  const page = pageTitle(title);
  const entry = await pagePart(ctx, page, index, async () => {
    const answer = await callApi(
      ctx,
      {
        action: 'parse',
        page,
        section: index,
        prop: 'text|revid',
        disableeditsection: '1',
        disablelimitreport: '1',
        disabletoc: '1',
        redirects: '1',
      },
      SectionTextSchema,
    );
    return {
      revision: answer.parse.revid,
      value: { title: answer.parse.title, html: answer.parse.text },
    };
  });
  const saved = noted(ctx, PAGE_KIND, entry);
  const { section, anchor, text } = readSection(saved.html);
  return {
    title: saved.title,
    section,
    text: text.length > TEXT_LIMIT ? `${text.slice(0, TEXT_LIMIT)}${TRUNCATED}` : text,
    url: wikiUrl(saved.title, anchor ?? undefined),
  };
}

const RevisionsSchema = z.object({
  query: z.object({
    normalized: z.array(z.object({ from: z.string(), to: z.string() })).optional(),
    redirects: z.array(z.object({ from: z.string(), to: z.string() })).optional(),
    pages: z.array(
      z.object({
        title: z.string(),
        revisions: z.array(z.object({ revid: z.number() })).optional(),
      }),
    ),
  }),
});

/**
 * Each page's current revision id, by the title asked for (following the wiki's spelling of it,
 * and redirects); a page that doesn't exist is left out. Up to 50 titles go in each request.
 */
export async function latestRevisions(
  ctx: WikiCtx,
  titles: string[],
): Promise<Record<string, number>> {
  const ids: Record<string, number> = {};
  for (let start = 0; start < titles.length; start += TITLES_PER_REQUEST) {
    const batch = titles.slice(start, start + TITLES_PER_REQUEST);
    const { query } = await callApi(
      ctx,
      {
        action: 'query',
        prop: 'revisions',
        rvprop: 'ids',
        titles: batch.join('|'),
        redirects: '1',
      },
      RevisionsSchema,
    );
    const renamed = new Map(
      [...(query.normalized ?? []), ...(query.redirects ?? [])].map(({ from, to }) => [from, to]),
    );
    const current = new Map<string, number>();
    for (const page of query.pages) {
      const revid = page.revisions?.[0]?.revid;
      if (revid !== undefined) current.set(page.title, revid);
    }
    for (const title of batch) {
      // A title can be respelled and then redirected.
      let name = title;
      for (let hop = 0; hop < 2; hop++) name = renamed.get(name) ?? name;
      const revid = current.get(name);
      if (revid !== undefined) ids[title] = revid;
    }
  }
  return ids;
}

const BucketSchema = z.object({ bucket: z.array(z.unknown()) });

/**
 * The rows of a Bucket query, such as
 * `bucket('quest').select('page_name','requirements').where('page_name','Dragon Slayer II').run()`,
 * asked once a day. The caller checks their shape.
 */
export async function bucketQuery<T>(ctx: WikiCtx, query: string): Promise<T[]> {
  return cachedFor(ctx, `bucket:${query}`, 'wiki_bucket', DAY_MS, async () => {
    const answer = await callApi(ctx, { action: 'bucket', query }, BucketSchema);
    return answer.bucket as T[];
  });
}

/** Text as a string in a Bucket query: `'Karil\'s coif'`. */
const bucketString = (text: string) => `'${text.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;

/**
 * A Bucket query, its names and values quoted:
 * `bucket('dropsline').select('page_name','drop_json').where('item_name','Karil\'s coif').limit(5000).run()`.
 */
export function bucketSelect(
  table: string,
  fields: string[],
  opts: { where?: [field: string, value: string]; limit?: number } = {},
): string {
  const where = opts.where ? `.where(${opts.where.map(bucketString).join(',')})` : '';
  const limit = opts.limit ? `.limit(${opts.limit})` : '';
  return `bucket(${bucketString(table)}).select(${fields.map(bucketString).join(',')})${where}${limit}.run()`;
}

const ExpandSchema = z.object({ expandtemplates: z.object({ wikitext: z.string() }) });

/** Wikitext with its templates expanded (`{{Globals|ca elite points}}` is `1100`), once a day. */
export async function expandTemplates(ctx: WikiCtx, text: string): Promise<string> {
  return cachedFor(ctx, `templates:${text}`, 'wiki_templates', DAY_MS, async () => {
    const answer = await callApi(
      ctx,
      { action: 'expandtemplates', prop: 'wikitext', text },
      ExpandSchema,
    );
    return answer.expandtemplates.wikitext;
  });
}
