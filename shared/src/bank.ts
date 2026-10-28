import { z } from 'zod';
import { MissingSchema, type SourceKind, SourceKindSchema } from './accounts.ts';

/** A stack the account owns, where it's kept, and its Grand Exchange price each. */
export const OwnedItemSchema = z.object({
  id: z.number(),
  name: z.string(),
  quantity: z.number(),
  where: z.enum(['bank', 'seed_vault', 'inventory', 'equipment']),
  /** Its slot there; for worn gear, the equipment slot (0 head, 1 cape, … 13 ammo). */
  slot: z.number().nullable(),
  /** Null for an item with no price (one the Grand Exchange doesn't trade). */
  unitPrice: z.number().nullable(),
});

export type OwnedItem = z.infer<typeof OwnedItemSchema>;

/** Where items are kept, by the Character Export file each is read from, in a search's order. */
export const BANK_PLACES = [
  { kind: 'ce_bank', where: 'bank' },
  { kind: 'ce_seed_vault', where: 'seed_vault' },
  { kind: 'ce_inventory', where: 'inventory' },
  { kind: 'ce_equipment', where: 'equipment' },
] as const satisfies readonly { kind: SourceKind; where: OwnedItem['where'] }[];

/** An account's Bank and gear page: everything it shows, from Character Export's files. */
export const BankViewSchema = z.object({
  /** When Character Export saved the bank, which it does whenever the bank is opened. */
  bankSeenAt: z.string().nullable(),
  /**
   * When it saved the worn gear and the inventory. It skips changes made within a few seconds of
   * its last save of a file, so these can lag behind the game.
   */
  wornSavedAt: z.string().nullable(),
  inventorySavedAt: z.string().nullable(),
  /** False for an ultimate ironman, who has no bank. */
  hasBank: z.boolean(),
  /** The bank's worth at Grand Exchange prices; null without a bank, or without prices. */
  totalValue: z.number().nullable(),
  /** When the latest prices were fetched; with `pricesError`, they're an old copy. */
  pricesAsOf: z.string().nullable(),
  /** Why the latest try for prices failed: there are none, or only an old copy. */
  pricesError: z.string().nullable(),
  /** The eight priciest stacks in the bank, priciest first. */
  mostValuable: z.array(OwnedItemSchema),
  /** The whole bank and seed vault in their order; null until Character Export has saved them. */
  bank: z.array(OwnedItemSchema).nullable(),
  seedVault: z.array(OwnedItemSchema).nullable(),
  /** By equipment slot; null until Character Export has saved it. */
  worn: z.array(OwnedItemSchema).nullable(),
  /** The 28 inventory slots, null where empty; null until Character Export has saved it. */
  inventory: z.array(OwnedItemSchema.nullable()).nullable(),
  /**
   * The stacks matching the search, best match first, each place it's kept; null without one.
   * `searchMore` says it matched more items than it lists.
   */
  search: z.array(OwnedItemSchema).nullable(),
  searchMore: z.boolean(),
  /** For every type but regular: they can't trade, so values are only for reference. */
  ironmanNote: z.boolean(),
  /** The places not saved yet, and what to do in game (or why the file couldn't be read). */
  missing: z.array(MissingSchema),
  /** Places whose latest file couldn't be read: what's shown is from the last read that worked. */
  failed: z.array(z.object({ kind: SourceKindSchema, error: z.string() })),
});

export type BankView = z.infer<typeof BankViewSchema>;

/** The page's search: up to 100 characters, trimmed; empty means no search. */
export const BankSearchSchema = z
  .string()
  .trim()
  .max(100, 'A search is at most 100 characters.')
  .optional()
  .transform((search) => search || null);
