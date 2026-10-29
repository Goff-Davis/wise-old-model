import { z } from 'zod';

/** Wise Old Man's account types, plus the group ironman types, which are set by hand. */
export const AccountTypeSchema = z.enum([
  'regular',
  'ironman',
  'hardcore',
  'ultimate',
  'group',
  'hardcore_group',
]);

export type AccountType = z.infer<typeof AccountTypeSchema>;

/** Each type as the interface names it. */
export const ACCOUNT_TYPE_LABELS: Record<AccountType, string> = {
  regular: 'Regular',
  ironman: 'Ironman',
  hardcore: 'Hardcore ironman',
  ultimate: 'Ultimate ironman',
  group: 'Group ironman',
  hardcore_group: 'Hardcore group ironman',
};

/** How to get Wise Old Man to track a name. */
export const WOM_TRACKING_STEPS =
  'Look the name up on wiseoldman.net to start tracking it, then Refresh.';

/** Whether accounts of this type have a bank: ultimate ironmen can't use one. */
export const hasBank = (type: AccountType): boolean => type !== 'ultimate';

/** Every kind of data saved per account: the online sources, then Character Export's files. */
export const SourceKindSchema = z.enum([
  'hiscores',
  'wom_player',
  'wom_gains_week',
  'wom_achievements',
  'temple_clog',
  'ce_character',
  'ce_quests',
  'ce_diaries',
  'ce_combat_achievements',
  'ce_bank',
  'ce_seed_vault',
  'ce_inventory',
  'ce_equipment',
]);

export type SourceKind = z.infer<typeof SourceKindSchema>;

/** Data an account doesn't have yet, and how to get it. */
export const MissingSchema = z.object({ kind: SourceKindSchema, fix: z.string() });

/**
 * How fresh one kind of an account's data is. `stale` means the last attempt to fetch it failed
 * (the data shown is the last good copy, from `fetchedAt`), and `error` says why; `notFound`
 * means the source answered that it doesn't know the account (say, a renamed player).
 */
export const FreshnessSchema = z.object({
  kind: SourceKindSchema,
  fetchedAt: z.string().nullable(),
  stale: z.boolean(),
  error: z.string().nullable(),
  notFound: z.boolean(),
});

export type Freshness = z.infer<typeof FreshnessSchema>;

/**
 * An OSRS name as typed or pasted: a non-breaking space (RuneLite's) counts as a space, the ends
 * are trimmed, and what's left must be 1 to 12 letters, numbers, spaces, hyphens or underscores,
 * with at least one letter or number.
 */
export const AccountNameSchema = z
  .string()
  .transform((name) => name.replace(/\u00a0/g, ' ').trim())
  .pipe(
    z
      .string()
      .regex(
        /^(?=.*[A-Za-z0-9])[A-Za-z0-9 _-]{1,12}$/,
        'A name is 1 to 12 letters, numbers, spaces, hyphens or underscores, with at least one letter or number.',
      ),
  );

export const AccountSchema = z.object({
  id: z.number(),
  name: z.string(),
  type: AccountTypeSchema,
  /** Whether the type came from Wise Old Man or was set by hand. */
  typeSource: z.enum(['wom', 'manual']),
  createdAt: z.string(),
});

export type Account = z.infer<typeof AccountSchema>;

/**
 * What the add-account dialog shows about a name before it's added. `onHiscores`, `womTracked`,
 * `temple.synced` and `characterExport.found` are null when that source couldn't be checked;
 * `problems` says why.
 */
export const AccountLookupSchema = z.object({
  name: z.string(),
  onHiscores: z.boolean().nullable(),
  combatLevel: z.number().nullable(),
  totalLevel: z.number().nullable(),
  womType: AccountTypeSchema.nullable(),
  womTracked: z.boolean().nullable(),
  characterExport: z.object({ found: z.boolean().nullable(), lastWritten: z.string().nullable() }),
  /** Whether the name has synced its collection log on TempleOSRS, and when it last did. */
  temple: z.object({ synced: z.boolean().nullable(), lastChecked: z.string().nullable() }),
  /** Sources that couldn't be checked, and why, so "not found" isn't claimed when it's unknown. */
  problems: z.array(z.string()),
});

export type AccountLookup = z.infer<typeof AccountLookupSchema>;

export const NewAccountSchema = z.object({
  name: AccountNameSchema,
  type: AccountTypeSchema,
  /** Ask Wise Old Man to start tracking the name; only when the person chose to. */
  trackOnWom: z.boolean(),
});

export type NewAccount = z.infer<typeof NewAccountSchema>;

/** The account just added, and anything that didn't work along the way (starting tracking). */
export const AddedAccountSchema = z.object({
  account: AccountSchema,
  problems: z.array(z.string()),
});

export type AddedAccount = z.infer<typeof AddedAccountSchema>;

export const AccountChangesSchema = z
  .object({ name: AccountNameSchema.optional(), type: AccountTypeSchema.optional() })
  .strict();

export type AccountChanges = z.infer<typeof AccountChangesSchema>;

export const RefreshAnswerSchema = z.object({
  freshness: z.array(FreshnessSchema),
  /** The account's new name, when the hiscores no longer know the old one and WOM saw a rename. */
  renameSuggestion: z.string().nullable(),
});

export type RefreshAnswer = z.infer<typeof RefreshAnswerSchema>;

/**
 * What a check of an account's Character Export files found: the kinds whose data changed,
 * those with no file yet, and those whose file couldn't be read (the data from before stays);
 * and how many goals the changed data showed reached, which were marked done.
 */
export const FileCheckSchema = z.object({
  changed: z.array(SourceKindSchema),
  missing: z.array(SourceKindSchema),
  errors: z.array(z.object({ kind: SourceKindSchema, message: z.string() })),
  goalsCompleted: z.number(),
});

export type FileCheck = z.infer<typeof FileCheckSchema>;
