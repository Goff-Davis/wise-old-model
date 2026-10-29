import { useQuery } from '@tanstack/react-query';
import { type About as AboutAnswer, DEFAULT_PORT, formatTime } from '@wom/shared';
import { type JSX, useId } from 'react';
import { aboutQuery, useBackUpNow } from '../../api/about.ts';
import { ExternalLink } from '../../components/ExternalLink.tsx';
import { Problem } from '../../components/Problem.tsx';
import { useTimeZone } from '../../settings/useSettings.ts';
import styles from './Settings.module.css';

/** Each .env setting as set, or what applies when it isn't; the API key only as set or not. */
function envRows(env: AboutAnswer['env']): [name: string, value: string][] {
  return [
    ['CONTACT', env.CONTACT],
    ['PORT', env.PORT ?? `Not set (${DEFAULT_PORT})`],
    ['DATA_DIR', env.DATA_DIR ?? 'Not set (the data folder above is the default)'],
    [
      'RUNELITE_DIR',
      env.RUNELITE_DIR ?? 'Not set (the RuneLite folder in Game data is the default)',
    ],
    ['ANTHROPIC_API_KEY', env.ANTHROPIC_API_KEY === 'set' ? 'Set' : 'Not set'],
  ];
}

/**
 * The data folder, the last backup and Back up now, the .env settings (read-only here), and the
 * credits: Jagex's game images, the wiki's license and the data sources.
 */
export function About(): JSX.Element {
  const id = useId();
  const envId = useId();
  const zone = useTimeZone();
  const about = useQuery(aboutQuery);
  const backUp = useBackUpNow();
  const data = about.data;
  return (
    <section aria-labelledby={id} className={styles.section}>
      <h3 id={id}>About</h3>
      {about.isError && <Problem>Couldn't load this. {about.error.message}</Problem>}
      {data && (
        <>
          <dl className={styles.facts}>
            <div>
              <dt>Data folder</dt>
              <dd>
                <code className={styles.path}>{data.dataDir}</code>
              </dd>
            </div>
            <div>
              <dt>Last backup</dt>
              <dd>
                {data.lastBackup ? (
                  <>
                    {formatTime(data.lastBackup.at, zone, 'relative')}:{' '}
                    <code className={styles.path}>{data.lastBackup.file}</code>
                  </>
                ) : (
                  'None yet'
                )}
              </dd>
            </div>
          </dl>
          <div className={styles.row}>
            <button type="button" disabled={backUp.isPending} onClick={() => backUp.mutate()}>
              {backUp.isPending ? 'Backing up…' : 'Back up now'}
            </button>
          </div>
          {backUp.isError && <Problem>Couldn't back up. {backUp.error.message}</Problem>}
          <h4 id={envId}>.env settings</h4>
          <p className={styles.hint}>
            Read-only here: change them in .env, then restart Wise Old Model.
          </p>
          <ul aria-labelledby={envId} className={styles.env}>
            {envRows(data.env).map(([name, value]) => (
              <li key={name}>
                <code>{name}</code>
                <span className={styles.path}>{value}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      <h4>Credits</h4>
      <p>Game images © Jagex Ltd.</p>
      <p>
        Wiki content is from the{' '}
        <ExternalLink href="https://oldschool.runescape.wiki">OSRS Wiki</ExternalLink>, under{' '}
        <ExternalLink href="https://creativecommons.org/licenses/by-nc-sa/3.0/">
          CC BY-NC-SA 3.0
        </ExternalLink>
        .
      </p>
      <p>
        Data comes from the{' '}
        <ExternalLink href="https://secure.runescape.com/m=hiscore_oldschool/overall">
          OSRS Hiscores
        </ExternalLink>{' '}
        (Jagex), <ExternalLink href="https://wiseoldman.net">Wise Old Man</ExternalLink>,{' '}
        <ExternalLink href="https://templeosrs.com">TempleOSRS</ExternalLink> and the wiki, with
        item icons from <ExternalLink href="https://runelite.net">RuneLite</ExternalLink>'s icon
        server, Grand Exchange prices from the wiki's{' '}
        <ExternalLink href="https://prices.runescape.wiki">real-time prices API</ExternalLink>, and
        quests, diaries, bank and gear from the{' '}
        <ExternalLink href="https://github.com/DZWNK/Character-Export">
          Character Export
        </ExternalLink>{' '}
        RuneLite plugin.
      </p>
    </section>
  );
}
