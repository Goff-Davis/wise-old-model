import { type JSX, useId, useMemo } from 'react';
import { Problem } from '../../components/Problem.tsx';
import { useSettings, useUpdateSettings } from '../../settings/useSettings.ts';
import styles from './Settings.module.css';

const THEMES = [
  { value: 'dark', label: 'Dark' },
  { value: 'light', label: 'Light' },
] as const;

export function Settings(): JSX.Element {
  const settings = useSettings();
  const update = useUpdateSettings();
  const zoneId = useId();
  // UTC first; Chrome's list of zones leaves it out, while Firefox's and Safari's have it.
  const allZones = useMemo(() => [...new Set(['UTC', ...Intl.supportedValuesOf('timeZone')])], []);

  if (settings.isPending) return <p className={styles.note}>Loading settings…</p>;
  if (settings.isError) {
    return <Problem>Couldn't load the settings. {settings.error.message}</Problem>;
  }

  const s = settings.data;
  // A zone saved under a name this browser lists differently (an alias) still shows.
  const zones =
    s.timeZone === 'auto' || allZones.includes(s.timeZone) ? allZones : [s.timeZone, ...allZones];

  return (
    <div className={styles.settings}>
      <h2>Settings</h2>
      <section aria-labelledby={`${zoneId}-display`} className={styles.section}>
        <h3 id={`${zoneId}-display`}>Display</h3>
        <fieldset className={styles.field}>
          <legend>Theme</legend>
          <div className={styles.choices}>
            {THEMES.map((theme) => (
              <label key={theme.value} className={styles.choice}>
                <input
                  type="radio"
                  name="theme"
                  value={theme.value}
                  checked={s.theme === theme.value}
                  onChange={() => update.mutate({ theme: theme.value })}
                />
                {theme.label}
              </label>
            ))}
          </div>
        </fieldset>
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
    </div>
  );
}
