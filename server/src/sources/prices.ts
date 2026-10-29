import { DAY_MS, MINUTE_MS } from '@wom/shared';
import { z } from 'zod';
import { fetchChecked, parseWith } from './answers.ts';
import { cachedFor, type WikiCtx } from './wiki.ts';

// Wiki prices API v2, bulk endpoints only: every item in one request.
const BASE = 'https://prices.runescape.wiki/api/v2/osrs';
const SITE = 'OSRS Wiki';

/** An item the Grand Exchange trades. The wiki leaves out a limit or value it doesn't know. */
export type MappingItem = {
  id: number;
  name: string;
  members: boolean;
  /** How many can be bought every 4 hours. */
  limit: number | null;
  value: number | null;
};

const MappingSchema = z.array(
  z.object({
    id: z.number(),
    name: z.string(),
    members: z.boolean(),
    limit: z.number().optional(),
    value: z.number().optional(),
  }),
);

/** Every tradeable item (`/mapping`, about 870 KB), asked once a day. */
export async function getMapping(ctx: WikiCtx): Promise<MappingItem[]> {
  return cachedFor(ctx, 'prices:mapping', 'prices_mapping', DAY_MS, async () => {
    const parse = (json: unknown) => parseWith(SITE, MappingSchema, json);
    const { value } = await fetchChecked(ctx.req, `${BASE}/mapping`, { parse });
    return value.map((item) => ({
      id: item.id,
      name: item.name,
      members: item.members,
      limit: item.limit ?? null,
      value: item.value ?? null,
    }));
  });
}

const LatestSchema = z.object({
  data: z.record(
    z.string(),
    z.object({
      high: z.number().nullable(),
      highTime: z.number().nullable(),
      low: z.number().nullable(),
      lowTime: z.number().nullable(),
    }),
  ),
});

/** The cache kind of the latest prices, which a caller can watch for in `noteRead`. */
export const LATEST_PRICES_KIND = 'prices_latest';

/** An item's latest buy (high) and sell (low) price, and when each trade happened. */
type Price = {
  high: number | null;
  low: number | null;
  highTime: string | null;
  lowTime: string | null;
};

/**
 * The price an item's latest trades give it: the instant-buy price, else the instant-sell price,
 * with when that trade happened; null when it's had neither.
 */
export function latestTrade(trade: Price | undefined): { price: number; at: string | null } | null {
  if (trade && trade.high !== null) return { price: trade.high, at: trade.highTime };
  if (trade && trade.low !== null) return { price: trade.low, at: trade.lowTime };
  return null;
}

// The API gives times in seconds since 1970.
const isoTime = (seconds: number | null) =>
  seconds === null ? null : new Date(seconds * 1000).toISOString();

/**
 * Every item's latest instant-buy (high) and instant-sell (low) price (`/latest`, about 340 KB),
 * with when each trade happened (it can be months ago), asked once every 5 minutes; null where
 * there's been no such trade, and no entry for an item never traded. Prices can be above
 * 2,147,483,647, which JSON and JavaScript numbers hold exactly.
 */
export async function getLatestPrices(ctx: WikiCtx): Promise<Map<number, Price>> {
  const entries = await cachedFor(
    ctx,
    'prices:latest',
    LATEST_PRICES_KIND,
    5 * MINUTE_MS,
    async (): Promise<[number, Price][]> => {
      const parse = (json: unknown) => parseWith(SITE, LatestSchema, json);
      const { value } = await fetchChecked(ctx.req, `${BASE}/latest`, { parse });
      return Object.entries(value.data).map(([id, price]) => [
        Number(id),
        {
          high: price.high,
          low: price.low,
          highTime: isoTime(price.highTime),
          lowTime: isoTime(price.lowTime),
        },
      ]);
    },
  );
  return new Map(entries);
}
