import { keepPreviousData, useQuery } from '@tanstack/react-query';
import {
  DAY_MS,
  dayStart,
  formatNumber,
  formatTime,
  type Gains,
  type GainsPeriod,
  type GainsRange,
  TEMPLE_SYNC_STEPS,
  WOM_TRACKING_STEPS,
} from '@wom/shared';
import { type JSX, useId, useState } from 'react';
import { useParams } from 'react-router';
import { gainsQuery, useAccountName, useRefreshAccount } from '../../api/accounts.ts';
import { Icon } from '../../components/Icon.tsx';
import { pageStates } from '../../components/PageStates.tsx';
import { RefreshButton } from '../../components/RefreshButton.tsx';
import { failureNotes } from '../../components/sourceNotes.ts';
import { useTimeZone } from '../../settings/useSettings.ts';
import styles from './ThisWeek.module.css';

/** The periods the page offers, as its chips name them, then Custom. */
const PERIODS: { period: Picked; label: string }[] = [
  { period: 'day', label: 'Today' },
  { period: 'week', label: '7 days' },
  { period: 'month', label: '30 days' },
  { period: 'custom', label: 'Custom' },
];

type Picked = GainsPeriod | 'custom';

const KIND_LABELS: Record<Gains['progress'][number]['kind'], string> = {
  quest: 'Quest',
  diary: 'Diary',
  combat_achievement: 'Combat achievement',
  achievement: 'Achievement',
  goal: 'Goal',
};

/** The calendar day after one ('YYYY-MM-DD'). */
const nextDay = (day: string) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10);

/**
 * Two days picked: the range runs from the start of the first to the end of the last, in the
 * settings' zone. Show is offered once they're in order.
 */
function CustomRange(props: { onShow: (range: GainsRange) => void }): JSX.Element {
  const zone = useTimeZone();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const ready = from !== '' && to !== '' && from <= to;
  return (
    <form
      className={styles.custom}
      onSubmit={(event) => {
        event.preventDefault();
        if (ready) props.onShow({ start: dayStart(from, zone), end: dayStart(nextDay(to), zone) });
      }}
    >
      <label>
        From
        <input
          type="date"
          value={from}
          max={to || undefined}
          onChange={(event) => setFrom(event.target.value)}
        />
      </label>
      <label>
        To
        <input
          type="date"
          value={to}
          min={from || undefined}
          onChange={(event) => setTo(event.target.value)}
        />
      </label>
      <button type="submit" disabled={!ready}>
        Show
      </button>
    </form>
  );
}

/** What's said of Wise Old Man's gains when they aren't known, or are an old copy. */
function gainsNote(gains: Gains, name: string, zone: string): string | null {
  const source = gains.gainsSource;
  if (source.notFound) {
    // The week saved before Wise Old Man stopped finding the name (after a rename, say).
    return source.fetchedAt
      ? `Fetched from Wise Old Man ${formatTime(source.fetchedAt, zone, 'relative')}. It doesn't find ${name} now, so these may be out of date.`
      : `Wise Old Man doesn't track ${name}, so XP and kills aren't known. ${WOM_TRACKING_STEPS}`;
  }
  if (!source.error) return null;
  return source.fetchedAt
    ? `Fetched from Wise Old Man ${formatTime(source.fetchedAt, zone, 'relative')}. The last try failed: ${source.error}`
    : `Couldn't get XP and kills from Wise Old Man. ${source.error}`;
}

/** What's said of Wise Old Man's achievements and Temple's log when the last try failed. */
function sourceNotes(gains: Gains, name: string, zone: string): string[] {
  const unsynced = gains.freshness.some((entry) => entry.kind === 'temple_clog' && entry.notFound);
  return [
    ...(unsynced
      ? [`TempleOSRS doesn't have ${name}'s collection log yet. ${TEMPLE_SYNC_STEPS}`]
      : []),
    ...failureNotes(gains.freshness, zone),
  ];
}

/** A section with its heading, its rows, or what it says when it has none. */
function Section(props: { title: string; empty: string | null; rows: JSX.Element[] }): JSX.Element {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className={styles.section}>
      <h3 id={headingId}>{props.title}</h3>
      {props.rows.length > 0 ? (
        <ul aria-label={props.title} className={styles.rows}>
          {props.rows}
        </ul>
      ) : (
        props.empty && <p className={styles.note}>{props.empty}</p>
      )}
    </section>
  );
}

/**
 * What the account did in a range: a period picker (Today, 7 days, 30 days, Custom), a one-line
 * summary, the XP per skill with level-ups, kills and clues, what it completed, and new
 * collection log items, dated in the settings' zone.
 */
export function ThisWeek(): JSX.Element {
  const { accountId = '' } = useParams();
  const zone = useTimeZone();
  const [picked, setPicked] = useState<Picked>('week');
  const [range, setRange] = useState<GainsRange>({ period: 'week' });
  // The last range's answer stays while another is fetched.
  const query = useQuery({ ...gainsQuery(accountId, range), placeholderData: keepPreviousData });
  const refresh = useRefreshAccount(accountId);

  const pick = (choice: Picked) => {
    setPicked(choice);
    if (choice !== 'custom') setRange({ period: choice });
  };
  const state = pageStates(query, 'this week');
  const name = useAccountName(accountId);
  // Whether Wise Old Man's gains are there to show (an old copy among them), so an empty list
  // means none were gained.
  const known = 'data' in state && state.data.gainsSource.fetchedAt !== null;

  return (
    <div className={styles.page}>
      <header>
        <h2>This week</h2>
        <fieldset className={styles.periods}>
          <legend className="visually-hidden">Period</legend>
          {PERIODS.map((each) => (
            <button
              key={each.period}
              type="button"
              aria-pressed={picked === each.period}
              onClick={() => pick(each.period)}
            >
              {each.label}
            </button>
          ))}
        </fieldset>
        {picked === 'custom' && <CustomRange onShow={setRange} />}
      </header>
      {'show' in state ? (
        state.show
      ) : (
        <div className={styles.gains} aria-busy={query.isPlaceholderData}>
          {state.reloadFailed}
          <p className={styles.summary}>{state.data.summary}</p>
          {[gainsNote(state.data, name, zone), ...sourceNotes(state.data, name, zone)].map(
            (note) =>
              note && (
                <p key={note} className={styles.stale}>
                  {note}
                </p>
              ),
          )}
          <Section
            title="Experience"
            empty={known ? 'No XP gained.' : null}
            rows={state.data.skills.map((skill) => (
              <li key={skill.name}>
                <Icon kind="skill" name={skill.name} size={20} decorative />
                <span>{skill.name}</span>
                <span className={styles.count}>+{formatNumber(skill.xpGained)} XP</span>
                <span className={skill.levelTo > skill.levelFrom ? styles.levelUp : styles.level}>
                  {skill.levelTo > skill.levelFrom
                    ? `${skill.levelFrom} → ${skill.levelTo}`
                    : `Level ${skill.levelTo}`}
                </span>
              </li>
            ))}
          />
          <Section
            title="Kills and clues"
            empty={known ? 'No boss kills or clues.' : null}
            rows={state.data.kills.map((kill) => (
              <li key={kill.name}>
                <Icon kind="wiki" file={kill.icon} name={kill.name} size={20} decorative />
                <span>{kill.name}</span>
                <span className={styles.count}>+{formatNumber(kill.gained)}</span>
              </li>
            ))}
          />
          <Section
            title="Progress"
            empty="Nothing completed."
            rows={state.data.progress.map((item) => (
              <li key={`${item.kind} ${item.title} ${item.at}`}>
                <span className={styles.kind}>{KIND_LABELS[item.kind]}</span>
                <span>{item.title}</span>
                <span className={styles.date}>{formatTime(item.at, zone, 'date')}</span>
              </li>
            ))}
          />
          <Section
            title="New collection log items"
            empty="No new items."
            rows={state.data.newCollectionLogItems.map((item) => (
              <li key={`${item.id} ${item.at}`}>
                <Icon kind="item" id={item.id} name={item.name} size={32} decorative />
                <span>{item.name}</span>
                <span className={styles.date}>{formatTime(item.at, zone, 'date')}</span>
              </li>
            ))}
          />
          <RefreshButton refresh={refresh} />
        </div>
      )}
    </div>
  );
}
