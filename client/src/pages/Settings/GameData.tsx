import { useQuery } from '@tanstack/react-query';
import type { About } from '@wom/shared';
import { type JSX, useId } from 'react';
import { aboutQuery } from '../../api/about.ts';
import { Problem } from '../../components/Problem.tsx';
import { useSettings, useUpdateSettings } from '../../settings/useSettings.ts';
import { Choices } from './Choices.tsx';
import { NumberField } from './NumberField.tsx';
import styles from './Settings.module.css';

const MODES = [
  { value: 'automatic', label: 'Automatic' },
  { value: 'manual', label: 'Manual' },
] as const;

/** Whether the RuneLite folder is there, and Character Export's folder in it. */
function folderFinding(about: About): string {
  if (!about.runeliteFound) {
    return 'Not found. Set RUNELITE_DIR in .env to the folder RuneLite keeps its files in, then restart Wise Old Model.';
  }
  return about.characterExportFound
    ? 'Found.'
    : "Found, but Character Export hasn't written anything in it yet. Install Character Export from the Plugin Hub, then log in with it on.";
}

/**
 * Where Character Export's files are read from (RUNELITE_DIR, set in .env), and how: as they
 * change (Automatic, checked every few seconds) or only on Refresh (Manual).
 */
export function GameData(): JSX.Element {
  const id = useId();
  const about = useQuery(aboutQuery);
  const settings = useSettings();
  const update = useUpdateSettings();
  const s = settings.data;
  const unknown = about.isError ? `Couldn't check. ${about.error.message}` : 'Checking…';
  return (
    <section aria-labelledby={id} className={styles.section}>
      <h3 id={id}>Game data</h3>
      <dl className={styles.facts}>
        <div>
          <dt>RuneLite folder</dt>
          <dd>
            {about.data ? (
              <>
                <code className={styles.path}>{about.data.runeliteDir}</code>{' '}
                {folderFinding(about.data)}
              </>
            ) : (
              unknown
            )}
          </dd>
        </div>
      </dl>
      {s && (
        <>
          <Choices
            legend="Update mode"
            value={s.runeliteMode}
            options={MODES}
            onChange={(runeliteMode) => update.mutate({ runeliteMode })}
          >
            <p className={styles.hint}>
              Automatic reads Character Export's files as they change; Manual reads them only when
              you press Refresh.
            </p>
          </Choices>
          <NumberField
            label="Check every (seconds)"
            value={s.pollSeconds}
            min={2}
            max={300}
            whole
            disabled={s.runeliteMode === 'manual'}
            invalid="Use 2 to 300 seconds."
            onSave={(value) => value !== null && update.mutate({ pollSeconds: value })}
          />
        </>
      )}
      {update.isError && <Problem>Couldn't save that change. {update.error.message}</Problem>}
    </section>
  );
}
