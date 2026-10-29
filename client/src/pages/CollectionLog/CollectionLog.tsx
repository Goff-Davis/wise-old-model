import { useQuery } from '@tanstack/react-query';
import {
  type CollectionLogView,
  formatNumber,
  formatTime,
  type CollectionLog as LogData,
  TEMPLE_SYNC_STEPS,
  TEMPLE_TABS,
  type TempleTab,
} from '@wom/shared';
import { type JSX, type KeyboardEvent, useId, useState } from 'react';
import { useParams } from 'react-router';
import { collectionLogQuery, useAccountName, useRefreshAccount } from '../../api/accounts.ts';
import { Icon } from '../../components/Icon.tsx';
import { pageStates } from '../../components/PageStates.tsx';
import { RefreshButton } from '../../components/RefreshButton.tsx';
import { useTimeZone } from '../../settings/useSettings.ts';
import styles from './CollectionLog.module.css';

const TAB_LABELS: Record<TempleTab, string> = {
  bosses: 'Bosses',
  raids: 'Raids',
  clues: 'Clues',
  minigames: 'Minigames',
  other: 'Other',
};

type Category = LogData['categories'][number];
type Item = Category['items'][number];

const obtainedIn = (category: Category) => category.items.filter((item) => item.obtained).length;

/** What's said of a picked item: when it was first obtained, or that it hasn't been. */
function itemDetail(item: Item, zone: string): string {
  if (!item.obtained) return `${item.name}: not obtained yet.`;
  return item.date
    ? `${item.name}: first obtained ${formatTime(item.date, zone, 'date')}.`
    : `${item.name}: obtained.`;
}

/** The log's totals and when the player last synced it with Temple. */
function totals(log: LogData, zone: string): string {
  const items = `${formatNumber(log.obtained)} of ${formatNumber(log.total)} items.`;
  return log.lastChecked
    ? `${items} Synced with Temple ${formatTime(log.lastChecked, zone, 'relative')}.`
    : items;
}

/** Tabs like the in-game log's; arrow keys, Home and End move between them, as tabs do. */
function Tabs(props: {
  open: TempleTab;
  onOpen: (tab: TempleTab) => void;
  tabId: (tab: TempleTab) => string;
  panelId: string;
}) {
  const move = (event: KeyboardEvent, index: number) => {
    const last = TEMPLE_TABS.length - 1;
    const keys: Record<string, number> = {
      ArrowRight: index === last ? 0 : index + 1,
      ArrowLeft: index === 0 ? last : index - 1,
      Home: 0,
      End: last,
    };
    const next = TEMPLE_TABS[keys[event.key] ?? -1];
    if (!next) return;
    event.preventDefault();
    props.onOpen(next);
    document.getElementById(props.tabId(next))?.focus();
  };
  return (
    <div role="tablist" aria-label="Collection log tabs" className={styles.tabs}>
      {TEMPLE_TABS.map((tab, index) => (
        <button
          key={tab}
          type="button"
          role="tab"
          id={props.tabId(tab)}
          aria-selected={tab === props.open}
          aria-controls={props.panelId}
          tabIndex={tab === props.open ? 0 : -1}
          onClick={() => props.onOpen(tab)}
          onKeyDown={(event) => move(event, index)}
        >
          {TAB_LABELS[tab]}
        </button>
      ))}
    </div>
  );
}

/** An entry's items, the missing ones greyed; picking one says when it was first obtained. */
function EntryItems(props: { category: Category }) {
  const zone = useTimeZone();
  const [picked, setPicked] = useState<number | null>(null);
  const item = props.category.items.find((each) => each.id === picked);
  return (
    <div className={styles.entry}>
      {/* Above the items, so it's in view whichever one is picked in a long entry. */}
      <p className={styles.detail} aria-live="polite">
        {item ? itemDetail(item, zone) : 'Pick an item to see when it was first obtained.'}
      </p>
      <ul aria-label={props.category.name} className={styles.items}>
        {props.category.items.map((each) => (
          <li key={each.id}>
            <button
              type="button"
              aria-pressed={each.id === picked}
              data-missing={!each.obtained}
              title={each.name}
              onClick={() => setPicked(each.id)}
            >
              <Icon kind="item" id={each.id} name={each.name} size={32} />
              <span>
                {each.obtained
                  ? each.count
                    ? `×${formatNumber(each.count)}`
                    : 'Obtained'
                  : 'Missing'}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The open tab's entries, complete ones in green, beside the picked entry's items. */
function Entries(props: { categories: Category[] }) {
  const [picked, setPicked] = useState<string | null>(null);
  const category = props.categories.find((each) => each.key === picked) ?? props.categories[0];
  if (!category) return <p className={styles.note}>No entries here yet.</p>;
  return (
    <div className={styles.log}>
      <ul aria-label="Entries" className={styles.entries}>
        {props.categories.map((each) => {
          const obtained = obtainedIn(each);
          return (
            <li key={each.key}>
              <button
                type="button"
                className={obtained === each.items.length ? styles.done : undefined}
                aria-current={each.key === category.key}
                onClick={() => setPicked(each.key)}
              >
                <span>{each.name}</span>
                <span className={styles.count}>
                  {obtained} of {each.items.length}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      <EntryItems key={category.key} category={category} />
    </div>
  );
}

/** What the page says when there's no log: how to sync it, or why it couldn't be had. */
function noLog(view: CollectionLogView, name: string): string {
  if (view.freshness.notFound) {
    return `TempleOSRS doesn't have ${name}'s collection log yet. ${TEMPLE_SYNC_STEPS} Then press Refresh.`;
  }
  return view.freshness.error
    ? `Couldn't get the collection log from TempleOSRS. ${view.freshness.error}`
    : 'No collection log yet.';
}

/**
 * The account's collection log from TempleOSRS: totals and when it was last synced, tabs like
 * the in-game log's, each tab's entries (complete ones in green) and the picked entry's items
 * (missing ones greyed, counts on the others, the first-obtained date of a picked one).
 */
export function CollectionLog(): JSX.Element {
  const { accountId = '' } = useParams();
  const zone = useTimeZone();
  const query = useQuery(collectionLogQuery(accountId));
  // Refresh: Temple's log again (at most once a minute), with the account's other online data.
  const refresh = useRefreshAccount(accountId);
  const name = useAccountName(accountId);
  const [open, setOpen] = useState<TempleTab>('bosses');
  const baseId = useId();
  const tabId = (tab: TempleTab) => `${baseId}-${tab}`;
  const panelId = `${baseId}-panel`;

  const state = pageStates(query, 'the collection log');
  if ('show' in state) return state.show;
  const { data, reloadFailed } = state;
  const { log, freshness } = data;
  return (
    <div className={styles.page}>
      {reloadFailed}
      <header>
        <h2>Collection log</h2>
        {log && <p className={styles.totals}>{totals(log, zone)}</p>}
      </header>
      {!log && <p className={styles.note}>{noLog(data, name)}</p>}
      <div className={styles.refresh}>
        <RefreshButton refresh={refresh} />
      </div>
      {log && (
        <>
          {data.tabsError && (
            <p className={styles.stale}>
              Temple's list of categories couldn't be fetched, so every entry is under Other.{' '}
              {data.tabsError}
            </p>
          )}
          {freshness.error && (
            <p className={styles.stale}>
              {freshness.fetchedAt
                ? `Fetched from TempleOSRS ${formatTime(freshness.fetchedAt, zone, 'relative')}. `
                : ''}
              The last try failed: {freshness.error}
            </p>
          )}
          <Tabs open={open} onOpen={setOpen} tabId={tabId} panelId={panelId} />
          <div role="tabpanel" id={panelId} aria-labelledby={tabId(open)}>
            <Entries key={open} categories={log.categories.filter((each) => each.tab === open)} />
          </div>
        </>
      )}
    </div>
  );
}
