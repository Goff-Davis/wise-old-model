import { useQuery } from '@tanstack/react-query';
import {
  ACCOUNT_TYPE_LABELS,
  type Account,
  capitalize,
  type Freshness,
  formatNumber,
  formatTime,
  type Overview as OverviewData,
  PROGRESS_ICONS,
  type SourceKind,
} from '@wom/shared';
import { type JSX, useId, useState } from 'react';
import { useParams } from 'react-router';
import { overviewQuery, useRefreshAccount, useRenameAccount } from '../../api/accounts.ts';
import { Icon } from '../../components/Icon.tsx';
import { pageStates } from '../../components/PageStates.tsx';
import { Problem } from '../../components/Problem.tsx';
import { RefreshButton } from '../../components/RefreshButton.tsx';
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

/** When a source was fetched, or for Character Export's files, when the plugin saved them. */
function freshnessText(entry: Freshness, zone: string): string {
  const file = entry.kind.startsWith('ce_');
  const fetched = entry.fetchedAt
    ? `${file ? 'Saved' : 'Fetched'} ${formatTime(entry.fetchedAt, zone, 'relative')}`
    : file
      ? 'Not read yet'
      : 'Not fetched yet';
  return entry.error ? `${fetched}. The last try failed: ${entry.error}` : fetched;
}

function caText(ca: NonNullable<OverviewData['progress']['combatAchievements']>): string {
  const points = `${formatNumber(ca.points)} points`;
  const reached = ca.tier ? `${ca.tier} tier, ${points}` : points;
  return ca.nextTier && ca.nextTierPoints !== null
    ? `${reached} (${ca.nextTier} at ${formatNumber(ca.nextTierPoints)})`
    : reached;
}

/** Quests, diary tiers, combat achievements and the collection log, each with its wiki icon. */
function Progress(props: { progress: OverviewData['progress'] }) {
  const id = useId();
  const { quests, diaryTiers, combatAchievements, collectionLog } = props.progress;
  const rows = [
    {
      label: 'Quests',
      icon: PROGRESS_ICONS.quests,
      value: quests && `${formatNumber(quests.done)} of ${formatNumber(quests.total)}`,
    },
    {
      label: 'Achievement diaries',
      icon: PROGRESS_ICONS.diaries,
      value: diaryTiers && `${diaryTiers.done} of ${diaryTiers.total} tiers`,
    },
    {
      label: 'Combat achievements',
      icon: PROGRESS_ICONS.combatAchievements,
      value: combatAchievements && caText(combatAchievements),
    },
    {
      label: 'Collection log',
      icon: PROGRESS_ICONS.collectionLog,
      value:
        collectionLog &&
        (collectionLog.total === null
          ? `${formatNumber(collectionLog.obtained)} logged, sync Temple for details`
          : `${formatNumber(collectionLog.obtained)} of ${formatNumber(collectionLog.total)}`),
    },
  ];
  return (
    <section aria-labelledby={id} className={styles.section}>
      <h3 id={id}>Progress</h3>
      <ul className={styles.progress}>
        {rows.map((row) => (
          <li key={row.label}>
            <Icon kind="wiki" file={row.icon} name={row.label} size={28} decorative />
            <dl>
              <dt>{row.label}</dt>
              <dd className={row.value ? undefined : styles.note}>
                {row.value ?? 'Not known yet'}
              </dd>
            </dl>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** What the account wears, by slot, with each item's icon. */
function WornGear(props: { worn: OverviewData['worn'] }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className={styles.section}>
      <h3 id={id}>Worn gear</h3>
      {props.worn === null || props.worn.length === 0 ? (
        <p className={styles.note}>{props.worn ? 'Nothing worn.' : 'Not known yet.'}</p>
      ) : (
        <ul className={styles.gear}>
          {props.worn.map((item) => (
            <li key={item.slot}>
              <Icon kind="item" id={item.id} name={item.name} size={32} decorative />
              <span className={styles.slot}>{capitalize(item.slot)}</span>
              <span>{item.name}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** The data the account doesn't have yet, and what to do in game for each. */
function Missing(props: { missing: OverviewData['missing'] }) {
  const id = useId();
  if (props.missing.length === 0) return null;
  return (
    <section aria-labelledby={id} className={styles.section}>
      <h3 id={id}>What's missing</h3>
      <ul className={styles.missing}>
        {props.missing.map((entry) => (
          <li key={entry.kind}>
            {SOURCE_NAMES[entry.kind]}: {entry.fix}
          </li>
        ))}
      </ul>
    </section>
  );
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
      <RefreshButton refresh={refresh} />
    </section>
  );
}

/**
 * The selected account at a glance: name, type, combat and total level, the stats tiles, the
 * progress rows, the top boss kill counts (expandable to all of them), worn gear, what's missing
 * and how to get it, and where the data came from and when.
 */
export function Overview(): JSX.Element {
  const { accountId = '' } = useParams();
  const overview = useQuery(overviewQuery(accountId));

  const state = pageStates(overview, 'the overview');
  if ('show' in state) return state.show;

  const { data, reloadFailed } = state;
  const { account, skills, freshness, missing } = data;
  const hiscores = freshness.find((entry) => entry.kind === 'hiscores');
  return (
    <div className={styles.overview}>
      {reloadFailed}
      <header>
        <h2>{account.name}</h2>
        <p className={styles.type}>{ACCOUNT_TYPE_LABELS[account.type]}</p>
        <dl className={styles.facts}>
          <div>
            <dt>Combat level</dt>
            <dd>{data.combatLevel ?? '–'}</dd>
          </div>
          <div>
            <dt>Total level</dt>
            <dd>{data.totalLevel === null ? '–' : formatNumber(data.totalLevel)}</dd>
          </div>
        </dl>
      </header>
      {hiscores?.notFound && (
        <p className={styles.notice}>
          The hiscores don't list {account.name}. Refresh checks Wise Old Man for a name change.
        </p>
      )}
      {skills.length > 0 ? (
        <StatsTiles skills={skills} totalLevel={data.totalLevel} />
      ) : (
        !hiscores?.notFound && <p className={styles.note}>No stats yet.</p>
      )}
      <Progress progress={data.progress} />
      <BossKills
        top={data.topKills}
        all={data.allKills}
        bossListFix={missing.find((entry) => entry.kind === 'wom_player')?.fix ?? null}
      />
      <WornGear worn={data.worn} />
      {/* The boss list's fix shows with the kill counts. */}
      <Missing missing={missing.filter((entry) => entry.kind !== 'wom_player')} />
      <Sources account={account} freshness={freshness} />
    </div>
  );
}
