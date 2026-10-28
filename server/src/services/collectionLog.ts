import type { CollectionLogView, TempleTab } from '@wom/shared';
import type { AccountRow } from '../db/schema.ts';
import { orSourceFailure, readSaved } from '../sources/answers.ts';
import { getCategoryTabs, parseCollectionLog } from '../sources/temple.ts';
import { getSource } from '../store/sourceState.ts';
import { type AccountDeps, freshenAccount, wikiCtx } from './accounts.ts';
import { freshnessOf } from './freshness.ts';

/**
 * The Collection log page: Temple's log for the account, fetched first when it's over an hour
 * old, each entry in its tab, with how the last fetch went. While Temple's list of categories
 * can't be had (with none saved), every entry is under Other, and `tabsError` says why.
 */
export async function getCollectionLogView(
  deps: AccountDeps,
  row: AccountRow,
  now: Date,
): Promise<CollectionLogView> {
  const [freshness = freshnessOf('temple_clog', null, null, false)] = await freshenAccount(
    deps,
    row,
    ['temple_clog'],
    { force: false, now },
  );
  const saved = await getSource(deps.db, row.id, 'temple_clog');
  if (!saved) return { log: null, freshness, tabsError: null };
  const noTabs: Record<string, TempleTab> = {};
  const tabs = await orSourceFailure(getCategoryTabs(wikiCtx(deps, now)), noTabs);
  const log = readSaved(saved.data, (json) => parseCollectionLog(json, tabs.value));
  return { log, freshness, tabsError: tabs.error };
}
