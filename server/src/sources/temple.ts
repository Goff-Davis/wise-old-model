import { type CollectionLog, DAY_MS, TEMPLE_TABS, type TempleTab } from '@wom/shared';
import { z } from 'zod';
import { NotFoundError, type Requester, SourceError } from '../http/requester.ts';
import { fetchChecked, parseWith } from './answers.ts';
import { cachedFor, type WikiCtx } from './wiki.ts';

const BASE = 'https://templeosrs.com/api/collection-log';
const SITE = 'Temple';

const TABS: readonly string[] = TEMPLE_TABS;

/** Temple's refusal, `{ error: { Code, Message } }`. Code 402: the player hasn't synced yet. */
const RefusalSchema = z.object({ error: z.object({ Code: z.number(), Message: z.string() }) });
const NOT_SYNCED_CODE = 402;
const NOT_SYNCED = Symbol('not synced');

const LogSchema = z.object({
  data: z.object({
    last_checked: z.string().nullable(),
    last_changed: z.string().nullable(),
    total_collections_finished: z.number(),
    total_collections_available: z.number(),
    items: z.record(
      z.string(),
      z.array(
        z.object({
          id: z.number(),
          name: z.string(),
          count: z.number().nullable(),
          date: z.string().nullable(),
        }),
      ),
    ),
  }),
});

const SummarySchema = z.object({ data: z.object({ last_checked: z.string().nullable() }) });

/**
 * A Temple answer checked against `schema`, or NOT_SYNCED for a player who has never synced
 * their collection log. Any other refusal is a SourceError giving Temple's reason.
 */
function readAnswer<T>(json: unknown, schema: z.ZodType<T>): T | typeof NOT_SYNCED {
  const refusal = RefusalSchema.safeParse(json);
  if (!refusal.success) return parseWith(SITE, schema, json);
  if (refusal.data.error.Code === NOT_SYNCED_CODE) return NOT_SYNCED;
  throw new SourceError(SITE, null, `${SITE}: ${refusal.data.error.Message}`);
}

/** A Temple time, written in UTC without saying so ("2026-10-24 06:43:21"), as an ISO time. */
function utc(time: string | null): string | null {
  if (time === null) return null;
  const parsed = Date.parse(`${time.replace(' ', 'T')}Z`);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

const SMALL_WORDS = new Set(['a', 'an', 'and', 'at', 'for', 'in', 'of', 'on', 'the', 'to']);

/**
 * The entries whose names the key can't give (apostrophes, capitals, a "The"), as the wiki's
 * Collection log page names them (checked against all 125 categories on 2026-10-28).
 */
const CATEGORY_NAMES = new Map([
  ['crazy_archaeologist', 'Crazy archaeologist'],
  ['hueycoatl', 'The Hueycoatl'],
  ['kree_arra', "Kree'arra"],
  ['kril_tsutsaroth', "K'ril Tsutsaroth"],
  ['thermonuclear_smoke_devil', 'Thermonuclear smoke devil'],
  ['vetion_and_calvarion', "Vet'ion and Calvar'ion"],
  ['giants_foundry', "Giants' Foundry"],
  ['rogues_den', "Rogues' Den"],
  ['shades_of_mortton', "Shades of Mort'ton"],
  ['champions_challenge', "Champion's Challenge"],
  ['gloughs_experiments', "Glough's Experiments"],
  ['tzhaar', 'TzHaar'],
]);

/**
 * A category's name, made from its key (`chambers_of_xeric` is Chambers of Xeric) unless the
 * game names it otherwise.
 */
export function categoryName(key: string): string {
  return (
    CATEGORY_NAMES.get(key) ??
    key
      .split('_')
      .filter(Boolean)
      .map((word, i) =>
        i > 0 && SMALL_WORDS.has(word) ? word : word.charAt(0).toUpperCase() + word.slice(1),
      )
      .join(' ')
  );
}

function toCollectionLog(
  answer: z.infer<typeof LogSchema>,
  tabs: Record<string, TempleTab>,
): CollectionLog {
  const { data } = answer;
  return {
    lastChecked: utc(data.last_checked),
    lastChanged: utc(data.last_changed),
    obtained: data.total_collections_finished,
    total: data.total_collections_available,
    categories: Object.entries(data.items).map(([key, items]) => ({
      key,
      // A category Temple's list doesn't have yet (the list is cached for a day).
      tab: tabs[key] ?? 'other',
      name: categoryName(key),
      items: items.map((item) => ({
        id: item.id,
        name: item.name,
        count: item.count,
        date: utc(item.date),
        obtained: (item.count ?? 0) > 0 || item.date !== null,
      })),
    })),
  };
}

/**
 * A player's collection log from Temple's answer (as stored), each category in its tab; null
 * when they've never synced.
 */
export function parseCollectionLog(
  json: unknown,
  tabs: Record<string, TempleTab>,
): CollectionLog | null {
  const answer = readAnswer(json, LogSchema);
  return answer === NOT_SYNCED ? null : toCollectionLog(answer, tabs);
}

/** Every category, with item names and the items still missing. */
const logUrl = (rsn: string) =>
  `${BASE}/player_collection_log.php?player=${encodeURIComponent(rsn)}&categories=all&includenames=1&includemissingitems=1`;

const fetchLog = (req: Requester, rsn: string) =>
  fetchChecked(req, logUrl(rsn), { parse: (json) => readAnswer(json, LogSchema) });

/**
 * The player's whole collection log exactly as received, which is what gets stored, once it
 * reads as one. Throws NotFoundError for a player who hasn't synced.
 */
export async function fetchCollectionLogText(req: Requester, rsn: string): Promise<string> {
  const { text, value } = await fetchLog(req, rsn);
  if (value === NOT_SYNCED) {
    throw new NotFoundError(SITE, null, `${SITE}: ${rsn} hasn't synced their collection log yet`);
  }
  return text;
}

/**
 * A stored collection log's text to compare for changes: the answer without the player's rank
 * and last sync time, which move without the log changing.
 */
export function comparableLog(text: string): string {
  const answer = JSON.parse(text) as { data: Record<string, unknown> };
  const { collections_hiscores_rank: _rank, last_checked: _checked, ...data } = answer.data;
  return JSON.stringify({ ...answer, data });
}

/**
 * Whether the player has synced their collection log on Temple, and when they last did. Only
 * the summary is asked for (Temple asks clients to query only what they need).
 */
export async function getSyncStatus(
  req: Requester,
  rsn: string,
): Promise<{ synced: boolean; lastChecked: string | null }> {
  const url = `${BASE}/player_collection_log.php?player=${encodeURIComponent(rsn)}`;
  const { value } = await fetchChecked(req, url, {
    parse: (json) => readAnswer(json, SummarySchema),
  });
  if (value === NOT_SYNCED) return { synced: false, lastChecked: null };
  return { synced: true, lastChecked: utc(value.data.last_checked) };
}

const CategoriesSchema = z.record(z.string(), z.record(z.string(), z.array(z.number())));

/** Each category's tab, from Temple's list of categories, asked once a day. */
export async function getCategoryTabs(ctx: WikiCtx): Promise<Record<string, TempleTab>> {
  return cachedFor(ctx, 'temple:categories', 'temple_categories', DAY_MS, async () => {
    const { value } = await fetchChecked(ctx.req, `${BASE}/categories.php`, {
      parse: (json) => parseWith(SITE, CategoriesSchema, json),
    });
    const tabs: Record<string, TempleTab> = {};
    for (const [tab, categories] of Object.entries(value)) {
      for (const key of Object.keys(categories)) {
        tabs[key] = TABS.includes(tab) ? (tab as TempleTab) : 'other';
      }
    }
    return tabs;
  });
}
