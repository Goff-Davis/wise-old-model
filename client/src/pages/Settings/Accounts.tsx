import { useQuery } from '@tanstack/react-query';
import type { Account, AccountStatus } from '@wom/shared';
import { type JSX, useId, useRef, useState } from 'react';
import {
  accountStatusQuery,
  accountsQuery,
  useChangeAccount,
  useDeleteAccount,
} from '../../api/accounts.ts';
import { AccountTypeSelect } from '../../components/AccountTypeSelect.tsx';
import { exportFolderFinding, templeLogFinding } from '../../components/findings.ts';
import { focusOnShow } from '../../components/focus.ts';
import { DialogActions, ModalDialog } from '../../components/ModalDialog.tsx';
import { AccountsProblem, Problem } from '../../components/Problem.tsx';
import { useTimeZone } from '../../settings/useSettings.ts';
import styles from './Settings.module.css';

/** The account's new name, saved on Save (or Enter); Cancel or Escape keeps the old one. */
function RenameForm(props: { account: Account; onDone: () => void }): JSX.Element {
  const rename = useChangeAccount(String(props.account.id));
  const [name, setName] = useState(props.account.name);
  return (
    <form
      className={styles.renameForm}
      onSubmit={(event) => {
        event.preventDefault();
        if (name.trim() === props.account.name) props.onDone();
        else rename.mutate({ name }, { onSuccess: props.onDone });
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          // Handled: only the form closes, not the panel around it.
          event.preventDefault();
          props.onDone();
        }
      }}
    >
      <div className={styles.row}>
        <input
          ref={focusOnShow}
          aria-label="New name"
          value={name}
          maxLength={12}
          onChange={(event) => setName(event.target.value)}
        />
        <button type="submit" disabled={rename.isPending || name.trim() === ''}>
          Save
        </button>
        <button type="button" onClick={props.onDone}>
          Cancel
        </button>
      </div>
      {rename.isError && (
        <Problem>
          Couldn't rename {props.account.name}. {rename.error.message}
        </Problem>
      )}
    </form>
  );
}

/** Asks before deleting the account, naming it; it stays open with why a delete failed. */
function DeleteAccount(props: { account: Account; open: boolean; onClose: () => void }) {
  const remove = useDeleteAccount(String(props.account.id));
  const { name } = props.account;
  const close = () => {
    remove.reset();
    props.onClose();
  };
  return (
    <ModalDialog open={props.open} onClose={close} title={`Delete ${name}?`}>
      <p>
        This deletes everything saved for {name}: its history, goals and chats. It can't be undone.
      </p>
      {remove.isError && (
        <Problem>
          Couldn't delete {name}. {remove.error.message}
        </Problem>
      )}
      <DialogActions>
        {/* Cancel first, so it has the focus as the question opens. */}
        <button type="button" onClick={close}>
          Cancel
        </button>
        <button
          type="button"
          className={styles.danger}
          disabled={remove.isPending}
          onClick={() => remove.mutate()}
        >
          Delete {name}
        </button>
      </DialogActions>
    </ModalDialog>
  );
}

/** One account: its name with Rename and Delete, its type, and what's found of its data. */
function AccountEntry(props: {
  account: Account;
  status: AccountStatus | undefined;
  statusError: Error | null;
}): JSX.Element {
  const { account, status } = props;
  const zone = useTimeZone();
  const headingId = useId();
  const typeId = useId();
  const change = useChangeAccount(String(account.id));
  const [renaming, setRenaming] = useState(false);
  const renameButton = useRef<HTMLButtonElement>(null);
  const [asking, setAsking] = useState(false);
  // The type picked shows until the account list has it.
  const type = (change.isPending && change.variables.type) || account.type;
  const unknown = props.statusError ? `Couldn't check. ${props.statusError.message}` : 'Checking…';
  return (
    <li aria-labelledby={headingId} className={styles.account}>
      <div className={styles.accountTop}>
        <h4 id={headingId}>{account.name}</h4>
        <span className={styles.row}>
          <button ref={renameButton} type="button" onClick={() => setRenaming(true)}>
            Rename
          </button>
          <button type="button" onClick={() => setAsking(true)}>
            Delete
          </button>
        </span>
      </div>
      {renaming && (
        <RenameForm
          account={account}
          onDone={() => {
            // The focus goes back to Rename rather than to the page as the box goes.
            renameButton.current?.focus();
            setRenaming(false);
          }}
        />
      )}
      <dl className={styles.facts}>
        <div>
          <dt>
            <label htmlFor={typeId}>Type</label>
          </dt>
          <dd className={styles.row}>
            <AccountTypeSelect
              id={typeId}
              value={type}
              fromWom={account.typeSource === 'wom'}
              disabled={change.isPending}
              noteClassName={styles.muted}
              onChange={(picked) => change.mutate({ type: picked })}
            />
          </dd>
        </div>
        <div>
          <dt>Character Export</dt>
          <dd>
            {status
              ? exportFolderFinding(
                  status.characterExport,
                  account.name,
                  zone,
                  status.characterExport.error,
                )
              : unknown}
          </dd>
        </div>
        <div>
          <dt>TempleOSRS</dt>
          <dd>{status ? templeLogFinding(status.temple, zone) : unknown}</dd>
        </div>
      </dl>
      {change.isError && (
        <Problem>
          Couldn't change {account.name}'s type. {change.error.message}
        </Problem>
      )}
      <DeleteAccount account={account} open={asking} onClose={() => setAsking(false)} />
    </li>
  );
}

/**
 * Each account: its name, Rename and Delete (asked first); its type, which can be changed (it
 * then counts as set by hand); whether its Character Export folder is there; and whether Temple
 * has its collection log. What's found comes from what's saved; no site is asked.
 */
export function Accounts(): JSX.Element {
  const id = useId();
  const accounts = useQuery(accountsQuery);
  const statuses = useQuery(accountStatusQuery);
  let content: JSX.Element;
  if (accounts.isPending) content = <p className={styles.muted}>Loading the accounts…</p>;
  else if (accounts.isError) content = <AccountsProblem error={accounts.error} />;
  else if (accounts.data.length === 0) {
    content = <p className={styles.muted}>No accounts yet. Add one from the menu.</p>;
  } else {
    content = (
      <ul className={styles.accounts}>
        {accounts.data.map((account) => (
          <AccountEntry
            key={account.id}
            account={account}
            status={statuses.data?.find((status) => status.id === account.id)}
            statusError={statuses.error}
          />
        ))}
      </ul>
    );
  }
  return (
    <section aria-labelledby={id} className={styles.section}>
      <h3 id={id}>Accounts</h3>
      {content}
    </section>
  );
}
