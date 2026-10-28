import { z } from 'zod';
import { FreshnessSchema } from './accounts.ts';

/** How to get a name's collection log onto Temple, which keeps a sync only for a profile it has. */
export const TEMPLE_SYNC_STEPS =
  'To sync it, search the name on templeosrs.com and press Update if Temple has no profile for it yet (Temple keeps a sync only for a player it has a profile for), add the Temple OSRS plugin to RuneLite, then open the collection log in game and press its sync button.';

/** The collection log's tabs, as in game. */
export const TEMPLE_TABS = ['bosses', 'raids', 'clues', 'minigames', 'other'] as const;

export const TempleTabSchema = z.enum(TEMPLE_TABS);

export type TempleTab = z.infer<typeof TempleTabSchema>;

/** A player's collection log as TempleOSRS has it, each entry in its tab, in the game's order. */
export const CollectionLogSchema = z.object({
  /** When the player last synced, and last synced a new item. */
  lastChecked: z.string().nullable(),
  lastChanged: z.string().nullable(),
  obtained: z.number(),
  total: z.number(),
  categories: z.array(
    z.object({
      key: z.string(),
      tab: TempleTabSchema,
      name: z.string(),
      /**
       * `count` is null when Temple doesn't give one; an item is obtained when it has a count
       * or a date (when it was first obtained).
       */
      items: z.array(
        z.object({
          id: z.number(),
          name: z.string(),
          count: z.number().nullable(),
          date: z.string().nullable(),
          obtained: z.boolean(),
        }),
      ),
    }),
  ),
});

export type CollectionLog = z.infer<typeof CollectionLogSchema>;

/**
 * The Collection log page: the log as last fetched from Temple (null when there's none: a name
 * that has never synced, or Temple down before it was ever fetched), when Temple was asked and
 * how that went, and why Temple's list of categories couldn't be had, when it couldn't (every
 * entry is then under Other).
 */
export const CollectionLogViewSchema = z.object({
  log: CollectionLogSchema.nullable(),
  freshness: FreshnessSchema,
  tabsError: z.string().nullable(),
});

export type CollectionLogView = z.infer<typeof CollectionLogViewSchema>;
