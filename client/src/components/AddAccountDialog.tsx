import {
  ACCOUNT_TYPE_NOUNS,
  type Account,
  type AccountLookup,
  AccountNameSchema,
  type AccountType,
  formatNumber,
  formatTime,
} from '@wom/shared';
import { type FormEvent, type JSX, useId, useState } from 'react';
import { useNavigate } from 'react-router';
import { useAddAccount, useLookUp } from '../api/accounts.ts';
import { pagePath } from '../pages/pageList.ts';
import { useTimeZone } from '../settings/useSettings.ts';
import { AccountTypeSelect } from './AccountTypeSelect.tsx';
import styles from './AddAccountDialog.module.css';
import { exportFolderFinding, NO_TEMPLE_LOG } from './findings.ts';
import { focusOnShow } from './focus.ts';
import { ModalDialog } from './ModalDialog.tsx';
import { Problem } from './Problem.tsx';

function hiscoresFinding(found: AccountLookup): string {
  if (found.onHiscores === null) return "Couldn't check.";
  if (!found.onHiscores) return 'Not on the hiscores.';
  const combat = `Combat level ${found.combatLevel ?? 'unknown'}`;
  return found.totalLevel === null
    ? combat
    : `${combat}, total level ${formatNumber(found.totalLevel)}`;
}

function womFinding(found: AccountLookup): string {
  if (found.womTracked === null) return "Couldn't check.";
  if (!found.womTracked) return `Doesn't track ${found.name} yet.`;
  return found.womType
    ? `Tracks ${found.name} as ${ACCOUNT_TYPE_NOUNS[found.womType]}.`
    : `Tracks ${found.name}.`;
}

function templeFinding(found: AccountLookup, zone: string): string {
  const { synced, lastChecked } = found.temple;
  if (synced === null) return "Couldn't check.";
  if (!synced) return NO_TEMPLE_LOG;
  return lastChecked
    ? `Has the collection log, last synced ${formatTime(lastChecked, zone, 'relative')}.`
    : 'Has the collection log.';
}

/**
 * After an add that didn't go fully to plan (tracking that didn't start): what went wrong, then
 * a button to open the account, which takes the focus from the Add button it replaces.
 */
function Added(props: {
  account: Account;
  problems: string[];
  onDone: (account: Account) => void;
}): JSX.Element {
  return (
    <div className={styles.form}>
      <p className={styles.added}>{props.account.name} was added.</p>
      <ul className={styles.problems}>
        {props.problems.map((problem) => (
          <li key={problem}>{problem}</li>
        ))}
      </ul>
      <div className={styles.actions}>
        <button
          ref={focusOnShow}
          type="button"
          className={styles.primary}
          onClick={() => props.onDone(props.account)}
        >
          Open {props.account.name}
        </button>
      </div>
    </div>
  );
}

/**
 * Adding an account: look the name up, see what the hiscores, Wise Old Man, Character Export
 * and TempleOSRS know, pick the type, and add it. Wise Old Man starts tracking a name only when
 * the person ticks the box. `onDone` gets the account once it's added (after any problems along
 * the way have been read).
 */
export function AddAccountForm(props: {
  onDone: (account: Account) => void;
  onCancel?: () => void;
}): JSX.Element {
  const id = useId();
  const [name, setName] = useState('');
  const [nameProblem, setNameProblem] = useState<string | null>(null);
  const [type, setType] = useState<AccountType>('regular');
  const [track, setTrack] = useState(false);
  const lookUp = useLookUp();
  const add = useAddAccount();
  const zone = useTimeZone();
  const found = lookUp.data;

  function onLookUp(event: FormEvent) {
    event.preventDefault();
    const parsed = AccountNameSchema.safeParse(name);
    if (!parsed.success) {
      setNameProblem(parsed.error.issues[0]?.message ?? "That can't be an OSRS name.");
      return;
    }
    setNameProblem(null);
    add.reset();
    lookUp.mutate(parsed.data, {
      onSuccess: (answer) => {
        setType(answer.womType ?? 'regular');
        setTrack(false);
      },
    });
  }

  function onAdd(event: FormEvent) {
    event.preventDefault();
    if (!found) return;
    add.mutate(
      { name: found.name, type, trackOnWom: found.womTracked === false && track },
      { onSuccess: (added) => added.problems.length === 0 && props.onDone(added.account) },
    );
  }

  if (add.data && add.data.problems.length > 0) {
    return <Added account={add.data.account} problems={add.data.problems} onDone={props.onDone} />;
  }

  return (
    <div className={styles.form}>
      <form onSubmit={onLookUp} className={styles.lookUp}>
        <label htmlFor={`${id}-name`}>Name</label>
        <div className={styles.nameRow}>
          <input
            id={`${id}-name`}
            value={name}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => {
              setName(event.target.value);
              lookUp.reset();
            }}
          />
          <button type="submit" disabled={lookUp.isPending}>
            {lookUp.isPending ? 'Looking up…' : 'Look up'}
          </button>
        </div>
        {nameProblem && <Problem>{nameProblem}</Problem>}
        {lookUp.isError && <Problem>Couldn't look that name up. {lookUp.error.message}</Problem>}
      </form>

      {/* Announced when the lookup answers, since it appears below the name. */}
      <div aria-live="polite">
        {found && (
          <form id={`${id}-details`} onSubmit={onAdd} className={styles.details}>
            <dl className={styles.findings}>
              <dt>Hiscores</dt>
              <dd>{hiscoresFinding(found)}</dd>
              <dt>Wise Old Man</dt>
              <dd>
                {womFinding(found)}
                {found.womTracked === false && (
                  <label className={styles.track}>
                    <input
                      type="checkbox"
                      checked={track}
                      onChange={(event) => setTrack(event.target.checked)}
                    />
                    Start tracking {found.name} on Wise Old Man
                  </label>
                )}
              </dd>
              <dt>Character Export</dt>
              <dd>{exportFolderFinding(found.characterExport, found.name, zone)}</dd>
              <dt>TempleOSRS</dt>
              <dd>{templeFinding(found, zone)}</dd>
            </dl>
            {found.problems.length > 0 && (
              <ul aria-label="What went wrong" className={styles.problems}>
                {found.problems.map((problem) => (
                  <li key={problem}>{problem}</li>
                ))}
              </ul>
            )}
            <div className={styles.typeRow}>
              <label htmlFor={`${id}-type`}>Type</label>
              <AccountTypeSelect
                id={`${id}-type`}
                value={type}
                fromWom={type === found.womType}
                noteClassName={styles.typeSource}
                onChange={setType}
              />
            </div>
            {add.isError && (
              <Problem>
                Couldn't add {found.name}. {add.error.message}
              </Problem>
            )}
          </form>
        )}
      </div>

      {(found || props.onCancel) && (
        <div className={styles.actions}>
          {props.onCancel && (
            <button type="button" onClick={props.onCancel}>
              Cancel
            </button>
          )}
          {found && (
            <button
              type="submit"
              form={`${id}-details`}
              className={styles.primary}
              disabled={add.isPending}
            >
              Add {found.name}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** The add-account form in a modal dialog; adding opens the new account's overview. */
export function AddAccountDialog(props: { open: boolean; onClose: () => void }): JSX.Element {
  const navigate = useNavigate();
  return (
    <ModalDialog open={props.open} onClose={props.onClose} title="Add an account">
      <AddAccountForm
        onCancel={props.onClose}
        onDone={(account) => {
          props.onClose();
          navigate(pagePath(account.id, 'overview'));
        }}
      />
    </ModalDialog>
  );
}
