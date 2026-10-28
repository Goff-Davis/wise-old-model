import { useQuery } from '@tanstack/react-query';
import {
  ACCOUNT_TYPE_LABELS,
  type Account,
  type Freshness,
  formatNumber,
  formatTime,
  type Overview as OverviewData,
  type SourceKind,
} from '@wom/shared';
import { type JSX, useId, useState } from 'react';
import { useParams } from 'react-router';
import { overviewQuery, useRefreshAccount, useRenameAccount } from '../../api/accounts.ts';
import { Icon } from '../../components/Icon.tsx';
import { Problem } from '../../components/Problem.tsx';
import { StatsTiles } from '../../components/StatsTiles.tsx';
import { useTimeZone } from '../../settings/useSettings.ts';
import styles from './Overview.module.css';

const SOURCE_NAMES: Record<SourceKind, string> = {
  hiscores: 'Hiscores',
  wom_player: 'Wise Old Man',
  wom_gains_week: "Wise Old Man's week",
  wom_achievements: "Wise Old Man's achievements",
  temple_clog: 'TempleOSRS',
  ce_character: 'Character',
  ce_quests: 'Quests',
  ce_diaries: 'Diaries',
  ce_combat_achievements: 'Combat achievements',
  ce_bank: 'Bank',
  ce_seed_vault: 'Seed vault',
  ce_inventory: 'Inventory',
  ce_equipment: 'Worn gear',
};

function freshnessText(entry: Freshness, zone: string): string {
  const fetched = entry.fetchedAt
    ? `Fetched ${formatTime(entry.fetchedAt, zone, 'relative')}`
    : 'Not fetched yet';
  return entry.error ? `${fetched}. The last try failed: ${entry.error}` : fetched;
}

function BossKills(props: {
  top: OverviewData['topKills'];
  all: OverviewData['allKills'];
  /** How to get Wise Old Man's boss list, when there's none to tell bosses apart with. */
  bossListFix: string | null;
}) {
  const id = useId();
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? props.all : props.top;
  return (
    <section aria-labelledby={id} className={styles.section}>
      <h3 id={id}>Boss kills</h3>
      {props.all.length === 0 ? (
        <p className={styles.note}>{props.bossListFix ?? 'No boss kills on the hiscores yet.'}</p>
      ) : (
        <>
          <ul aria-labelledby={id} className={styles.kills}>
            {shown.map((boss) => (
              <li key={boss.name}>
                <Icon kind="boss" name={boss.name} size={30} decorative />
                <span className={styles.bossName}>{boss.name}</span>
                <span className={styles.count}>{formatNumber(boss.kills)}</span>
              </li>
            ))}
          </ul>
          {props.all.length > props.top.length && (
            <button
              type="button"
              className={styles.more}
              aria-expanded={expanded}
              onClick={() => setExpanded((wasExpanded) => !wasExpanded)}
            >
              {expanded ? `Show the top ${props.top.length}` : `Show all ${props.all.length}`}
            </button>
          )}
        </>
      )}
    </section>
  );
}

/** When each source was last fetched, Refresh, and a rename Wise Old Man suggests after it. */
function Sources(props: { account: Account; freshness: Freshness[] }) {
  const id = useId();
  const zone = useTimeZone();
  const accountId = String(props.account.id);
  const refresh = useRefreshAccount(accountId);
  const rename = useRenameAccount(accountId);
  const suggestion = refresh.data?.renameSuggestion ?? null;

  return (
    <section aria-labelledby={id} className={styles.section}>
      <h3 id={id}>Sources</h3>
      <dl className={styles.sources}>
        {props.freshness.map((entry) => (
          <div key={entry.kind}>
            <dt>{SOURCE_NAMES[entry.kind]}</dt>
            <dd className={entry.stale ? styles.stale : undefined}>{freshnessText(entry, zone)}</dd>
          </div>
        ))}
      </dl>
      {suggestion && (
        <div className={styles.rename}>
          <p>
            Wise Old Man shows {props.account.name} was renamed to {suggestion}.
          </p>
          <button
            type="button"
            disabled={rename.isPending}
            onClick={() =>
              rename.mutate(suggestion, {
                // Then fetch everything under the new name.
                onSuccess: () => {
                  refresh.reset();
                  refresh.mutate();
                },
              })
            }
          >
            Rename to {suggestion}
          </button>
        </div>
      )}
      {rename.isError && (
        <Problem>
          Couldn't rename {props.account.name}. {rename.error.message}
        </Problem>
      )}
      {refresh.isError && <Problem>Couldn't refresh. {refresh.error.message}</Problem>}
      <div>
        <button type="button" disabled={refresh.isPending} onClick={() => refresh.mutate()}>
          {refresh.isPending ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>
    </section>
  );
}

/**
 * The selected account at a glance: name, type, combat and total level, the stats tiles, the
 * top boss kill counts (expandable to all of them), and where the data came from and when.
 */
export function Overview(): JSX.Element {
  const { accountId = '' } = useParams();
  const overview = useQuery(overviewQuery(accountId));

  if (overview.isPending) return <p className={styles.loading}>Loading the overview…</p>;
  if (!overview.data) {
    return (
      <Problem className={styles.failed}>
        Couldn't load the overview. {overview.error?.message}
      </Problem>
    );
  }

  const { account, skills, freshness, missing } = overview.data;
  const hiscores = freshness.find((entry) => entry.kind === 'hiscores');
  return (
    <div className={styles.overview}>
      {/* A failed reload keeps what was shown. */}
      {overview.isError && (
        <Problem>Couldn't reload the overview. {overview.error.message}</Problem>
      )}
      <header>
        <h2>{account.name}</h2>
        <p className={styles.type}>{ACCOUNT_TYPE_LABELS[account.type]}</p>
        <dl className={styles.facts}>
          <div>
            <dt>Combat level</dt>
            <dd>{overview.data.combatLevel ?? '–'}</dd>
          </div>
          <div>
            <dt>Total level</dt>
            <dd>
              {overview.data.totalLevel === null ? '–' : formatNumber(overview.data.totalLevel)}
            </dd>
          </div>
        </dl>
      </header>
      {hiscores?.notFound && (
        <p className={styles.notice}>
          The hiscores don't list {account.name}. Refresh checks Wise Old Man for a name change.
        </p>
      )}
      {skills.length > 0 ? (
        <StatsTiles skills={skills} totalLevel={overview.data.totalLevel} />
      ) : (
        !hiscores?.notFound && <p className={styles.note}>No stats yet.</p>
      )}
      <BossKills
        top={overview.data.topKills}
        all={overview.data.allKills}
        bossListFix={missing.find((entry) => entry.kind === 'wom_player')?.fix ?? null}
      />
      <Sources account={account} freshness={freshness} />
    </div>
  );
}
