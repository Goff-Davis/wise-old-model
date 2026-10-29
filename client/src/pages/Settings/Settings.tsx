import { type JSX, useId, useMemo } from 'react';
import { Problem } from '../../components/Problem.tsx';
import { useSettings, useUpdateSettings } from '../../settings/useSettings.ts';
import { About } from './About.tsx';
import { Accounts } from './Accounts.tsx';
import { Ai } from './Ai.tsx';
import { Choices } from './Choices.tsx';
import { GameData } from './GameData.tsx';
import styles from './Settings.module.css';

const THEMES = [
  { value: 'dark', label: 'Dark' },
  { value: 'light', label: 'Light' },
] as const;

/** The theme and the time zone times are shown in. */
function Display(): JSX.Element | null {
  const settings = useSettings();
  const update = useUpdateSettings();
  const zoneId = useId();
  // UTC first; Chrome's list of zones leaves it out, while Firefox's and Safari's have it.
  const allZones = useMemo(() => [...new Set(['UTC', ...Intl.supportedValuesOf('timeZone')])], []);

  if (!settings.data) return null;
  const s = settings.data;
  // A zone saved under a name this browser lists differently (an alias) still shows.
  const zones =
    s.timeZone === 'auto' || allZones.includes(s.timeZone) ? allZones : [s.timeZone, ...allZones];

  return (
    <section aria-labelledby={`${zoneId}-display`} className={styles.section}>
      <h3 id={`${zoneId}-display`}>Display</h3>
      <Choices
        legend="Theme"
        value={s.theme}
        options={THEMES}
        onChange={(theme) => update.mutate({ theme })}
      />
      <div className={styles.field}>
        <label htmlFor={zoneId}>Time zone</label>
        <select
          id={zoneId}
          value={s.timeZone}
          onChange={(event) => update.mutate({ timeZone: event.target.value })}
        >
          <option value="auto">
            Automatic{s.detectedTimeZone ? ` (${s.detectedTimeZone})` : ''}
          </option>
          {zones.map((zone) => (
            <option key={zone} value={zone}>
              {zone}
            </option>
          ))}
        </select>
      </div>
      {update.isError && <Problem>Couldn't save that change. {update.error.message}</Problem>}
    </section>
  );
}

/**
 * The Settings page: Accounts, Game data, AI, Display and About. Each change is saved as it's
 * made; the .env settings are only shown.
 */
export function Settings(): JSX.Element {
  const settings = useSettings();
  return (
    <div className={styles.settings}>
      <h2>Settings</h2>
      {settings.isPending && <p className={styles.muted}>Loading settings…</p>}
      {settings.isError && <Problem>Couldn't load the settings. {settings.error.message}</Problem>}
      <Accounts />
      <GameData />
      <Ai />
      <Display />
      <About />
    </div>
  );
}
