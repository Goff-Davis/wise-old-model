import { type UseQueryResult, useQuery } from '@tanstack/react-query';
import {
  BANK_PLACES,
  type BankView,
  capitalize,
  EQUIPMENT_SLOTS,
  formatCompact,
  formatNumber,
  formatTime,
  type OwnedItem,
  PLACE_NAMES,
  SEARCH_MAX_LENGTH,
  type SourceKind,
} from '@wom/shared';
import { type JSX, memo, useId, useState } from 'react';
import { useParams } from 'react-router';
import { bankQuery, bankSearchQuery } from '../../api/accounts.ts';
import { Icon } from '../../components/Icon.tsx';
import { pageStates } from '../../components/PageStates.tsx';
import { Problem } from '../../components/Problem.tsx';
import { useTimeZone } from '../../settings/useSettings.ts';
import styles from './BankGear.module.css';
import { stackSize } from './stackSize.ts';

const SEARCH_LABEL = 'Search bank, inventory, gear and seed vault';

/** The equipment screen: each slot's row and column in its 3 × 5 grid, and its name. */
const EQUIPMENT_SCREEN = [
  { slot: 0, row: 1, column: 2 },
  { slot: 1, row: 2, column: 1 },
  { slot: 2, row: 2, column: 2 },
  { slot: 13, row: 2, column: 3 },
  { slot: 3, row: 3, column: 1 },
  { slot: 4, row: 3, column: 2 },
  { slot: 5, row: 3, column: 3 },
  { slot: 7, row: 4, column: 2 },
  { slot: 9, row: 5, column: 1 },
  { slot: 10, row: 5, column: 2 },
  { slot: 12, row: 5, column: 3 },
].map((place) => ({ ...place, name: capitalize(EQUIPMENT_SLOTS[place.slot]) }));

/** "The bank's": a place's name in a note about its latest file. */
function placeOf(kind: SourceKind): string {
  const place = BANK_PLACES.find((one) => one.kind === kind);
  return place ? `${capitalize(PLACE_NAMES[place.where].place)}'s` : '';
}

const withQuantity = (item: OwnedItem) =>
  item.quantity > 1 ? `${item.name} ×${formatNumber(item.quantity)}` : item.name;

/** What to do in game for a place Character Export hasn't saved, or why its file didn't read. */
const fixFor = (view: BankView, kind: SourceKind) =>
  view.missing.find((entry) => entry.kind === kind)?.fix;

/** A sentence about a place, then what to do for it, when there's something to do. */
function withFix(lead: string, view: BankView, kind: SourceKind): string {
  const fix = fixFor(view, kind);
  return fix ? `${lead} ${fix}` : lead;
}

/** When Character Export saved a place, under its heading. */
function SavedAt(props: { at: string | null }) {
  const zone = useTimeZone();
  if (!props.at) return null;
  return <p className={styles.note}>Saved {formatTime(props.at, zone, 'relative')}.</p>;
}

/** A note when a place's latest file couldn't be read, so what's shown is from before. */
function FailedNote(props: { view: BankView; kind: SourceKind }) {
  const failed = props.view.failed.find((entry) => entry.kind === props.kind);
  if (!failed) return null;
  return (
    <p className={styles.stale}>
      {placeOf(props.kind)} latest file couldn't be read, so this is from before. {failed.error}
    </p>
  );
}

/** When the bank was seen and what it's worth, or why that isn't known. */
function bankLine(view: BankView, zone: string): string {
  if (!view.bankSeenAt) {
    if (!view.hasBank) return 'Ultimate ironmen have no bank.';
    return withFix('Bank not seen yet.', view, 'ce_bank');
  }
  const seen = `Bank seen ${formatTime(view.bankSeenAt, zone, 'relative')}.`;
  if (view.totalValue === null) {
    return view.pricesError
      ? `${seen} Its value isn't known: the last try for prices failed. ${view.pricesError}`
      : seen;
  }
  const worth = `Worth ${formatCompact(view.totalValue)} at Grand Exchange prices`;
  const note = view.ironmanNote ? " (for reference: ironmen can't trade)" : '';
  // An old copy of the prices, kept while the wiki can't be reached.
  if (view.pricesError && view.pricesAsOf) {
    const asOf = formatTime(view.pricesAsOf, zone, 'relative');
    return `${seen} ${worth} from ${asOf}${note}. The last try for newer prices failed: ${view.pricesError}`;
  }
  return `${seen} ${worth}${note}.`;
}

/** A stack: its icon, name and size, where it's kept when asked, and its worth when priced. */
function ItemRow(props: { item: OwnedItem; showWhere?: boolean }) {
  const { item } = props;
  return (
    <li className={props.showWhere ? styles.found : undefined}>
      <Icon kind="item" id={item.id} name={item.name} size={30} decorative />
      <span className={styles.name}>{withQuantity(item)}</span>
      {props.showWhere && (
        <span className={styles.where}>{capitalize(PLACE_NAMES[item.where].at)}</span>
      )}
      {item.unitPrice !== null && (
        <span className={styles.worth}>{formatCompact(item.quantity * item.unitPrice)}</span>
      )}
    </li>
  );
}

/** The worn gear laid out like the in-game equipment screen. */
function Worn(props: { view: BankView }) {
  const id = useId();
  const { worn } = props.view;
  const bySlot = new Map(worn?.map((item) => [item.slot, item]));
  return (
    <section aria-labelledby={id} className={styles.section}>
      <h3 id={id}>Worn</h3>
      <SavedAt at={props.view.wornSavedAt} />
      <FailedNote view={props.view} kind="ce_equipment" />
      {worn === null ? (
        <p className={styles.note}>{withFix('Not known yet.', props.view, 'ce_equipment')}</p>
      ) : (
        <ul aria-labelledby={id} className={styles.equipment}>
          {EQUIPMENT_SCREEN.map(({ slot, name, row, column }) => {
            const item = bySlot.get(slot);
            return (
              <li
                key={slot}
                className={item ? styles.slot : `${styles.slot} ${styles.empty}`}
                style={{ gridArea: `${row} / ${column}` }}
                title={`${name}: ${item ? item.name : 'empty'}`}
              >
                <span className="visually-hidden">{name}</span>
                {item && <Icon kind="item" id={item.id} name={item.name} size={30} />}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** A stack's size on its icon, as the game writes it and in its color. */
function StackSize(props: { quantity: number }) {
  const { text, size } = stackSize(props.quantity);
  return (
    <span className={styles.stack} data-size={size}>
      {text}
    </span>
  );
}

/** The 28-slot inventory, 4 across, each stack's size on its icon. */
function Inventory(props: { view: BankView }) {
  const id = useId();
  const { inventory } = props.view;
  return (
    <section aria-labelledby={id} className={styles.section}>
      <h3 id={id}>Inventory</h3>
      <SavedAt at={props.view.inventorySavedAt} />
      <FailedNote view={props.view} kind="ce_inventory" />
      {inventory === null ? (
        <p className={styles.note}>{withFix('Not known yet.', props.view, 'ce_inventory')}</p>
      ) : (
        <ul aria-labelledby={id} className={styles.inventory}>
          {inventory.map((item, slot) =>
            item ? (
              // biome-ignore lint/suspicious/noArrayIndexKey: a slot's number is what it is.
              <li key={slot} title={withQuantity(item)}>
                <Icon kind="item" id={item.id} name={item.name} size={30} />
                {item.quantity > 1 && <StackSize quantity={item.quantity} />}
              </li>
            ) : (
              // biome-ignore lint/suspicious/noArrayIndexKey: a slot's number is what it is.
              <li key={slot} aria-hidden="true" />
            ),
          )}
        </ul>
      )}
    </section>
  );
}

/** The places a search covers that Character Export has saved, in a sentence's order. */
function searchedPlaces(view: BankView): string[] {
  const places: [string, unknown][] = [
    ['bank', view.bank],
    ['inventory', view.inventory],
    ['gear', view.worn],
    ['seed vault', view.seedVault],
  ];
  return places.flatMap(([name, saved]) => (saved ? [name] : []));
}

const joinOr = (words: string[]) =>
  words.length < 2 ? (words[0] ?? '') : `${words.slice(0, -1).join(', ')} or ${words.at(-1)}`;

/** What a search found, said once it's done: how many, too many, or nothing and where. */
function searchStatus(search: string | null, found: UseQueryResult<BankView>): string {
  if (search === null) return '';
  if (found.isPending) return `Searching for "${search}"…`;
  const view = found.data;
  if (!view?.search) return '';
  if (view.searchMore) {
    return `More than 50 items match "${search}", so these are the first 50. Type more of the name to narrow it down.`;
  }
  if (view.search.length > 0) {
    const count = view.search.length === 1 ? '1 match' : `${view.search.length} matches`;
    return `${count} for "${search}".`;
  }
  const places = searchedPlaces(view);
  if (places.length === 0) {
    const all = view.hasBank
      ? 'bank, inventory, gear or seed vault'
      : 'inventory, gear or seed vault';
    return `Character Export hasn't saved the ${all} yet, so there's nothing to search.`;
  }
  return `Nothing called "${search}" in the ${joinOr(places)} as Character Export last saw ${places.length === 1 ? 'it' : 'them'}.`;
}

/**
 * One search across everything the account owns, with where each find is kept. It has its own
 * request, so a search that fails leaves the page as it was and says why beside the box.
 */
function Search(props: { accountId: string }) {
  const [text, setText] = useState('');
  const [search, setSearch] = useState<string | null>(null);
  const found = useQuery(bankSearchQuery(props.accountId, search));
  const results = search === null ? null : (found.data?.search ?? null);
  return (
    <search className={styles.search}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          setSearch(text.trim() || null);
        }}
      >
        <input
          type="search"
          aria-label={SEARCH_LABEL}
          placeholder={SEARCH_LABEL}
          maxLength={SEARCH_MAX_LENGTH}
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            if (!event.target.value.trim()) setSearch(null);
          }}
        />
        <button type="submit">Search</button>
      </form>
      <p role="status" className={styles.status}>
        {searchStatus(search, found)}
      </p>
      {search !== null && found.isError && (
        <Problem className={styles.searchProblem}>
          Couldn't search for "{search}". {found.error.message}
        </Problem>
      )}
      {results && results.length > 0 && (
        <ul aria-label="Found" className={styles.items}>
          {results.map((item) => (
            <ItemRow key={`${item.id}:${item.where}`} item={item} showWhere />
          ))}
        </ul>
      )}
    </search>
  );
}

/**
 * A list of stacks behind a button that shows and hides it. It renders again only when the list
 * changes, as the whole bank's 800-odd rows needn't each time the inventory does.
 */
const SeeAll = memo(function SeeAll(props: { items: OwnedItem[]; name: string }) {
  const [shown, setShown] = useState(false);
  return (
    <>
      <button
        type="button"
        className={styles.more}
        aria-expanded={shown}
        onClick={() => setShown((wasShown) => !wasShown)}
      >
        {shown ? `Hide ${props.name}` : `See ${props.name} (${props.items.length})`}
      </button>
      {shown && (
        <ul aria-label={capitalize(props.name)} className={styles.items}>
          {props.items.map((item) => (
            <ItemRow key={`${item.slot}:${item.id}`} item={item} />
          ))}
        </ul>
      )}
    </>
  );
});

/**
 * The account's bank and gear: when the bank was seen and what it's worth (for reference, for
 * an account that can't trade), one search across everything it owns, the worn gear like the
 * in-game equipment screen, the 28-slot inventory, the bank's most valuable stacks, and the
 * whole bank and seed vault on request.
 */
export function BankGear(): JSX.Element {
  const { accountId = '' } = useParams();
  const zone = useTimeZone();
  const valuableId = useId();
  const state = pageStates(useQuery(bankQuery(accountId)), 'the bank and gear');
  if ('show' in state) return state.show;
  const { data: view, reloadFailed } = state;
  const seedVaultFix = fixFor(view, 'ce_seed_vault');
  return (
    <div className={styles.page}>
      {reloadFailed}
      <header>
        <h2>Bank and gear</h2>
        <p className={styles.seen}>{bankLine(view, zone)}</p>
        <FailedNote view={view} kind="ce_bank" />
      </header>
      <Search accountId={accountId} />
      <div className={styles.gear}>
        <Worn view={view} />
        <Inventory view={view} />
      </div>
      {(view.worn || view.inventory) && (
        // The plugin drops a change that comes too soon after its last save of a file.
        <p className={styles.note}>
          Character Export skips changes made within a few seconds of its last save. If the gear or
          inventory looks behind, press Sync Available in its side panel.
        </p>
      )}
      {view.mostValuable.length > 0 && (
        <section aria-labelledby={valuableId} className={styles.section}>
          <h3 id={valuableId}>Most valuable in the bank</h3>
          <ul aria-labelledby={valuableId} className={styles.valuable}>
            {view.mostValuable.map((item) => (
              <ItemRow key={`${item.slot}:${item.id}`} item={item} />
            ))}
          </ul>
        </section>
      )}
      <div className={styles.lists}>
        {view.bank && <SeeAll items={view.bank} name="the whole bank" />}
        {view.seedVault ? (
          <SeeAll items={view.seedVault} name="the seed vault" />
        ) : (
          seedVaultFix && <p className={styles.note}>Seed vault: {seedVaultFix}</p>
        )}
        <FailedNote view={view} kind="ce_seed_vault" />
      </div>
    </div>
  );
}
