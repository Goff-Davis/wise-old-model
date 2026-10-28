import { useQuery } from '@tanstack/react-query';
import { type JSX, useId, useState } from 'react';
import { NavLink } from 'react-router';
import { accountsQuery } from '../api/accounts.ts';
import { PAGES, type PageId, pagePath } from '../pages/pageList.ts';
import { AddAccountDialog } from './AddAccountDialog.tsx';
import styles from './Menu.module.css';
import { AccountsProblem } from './Problem.tsx';

/**
 * The menu beside the page: the accounts (each opening the page being viewed) and Add account,
 * then, once an account is open, its pages.
 */
export function Menu(props: { accountId?: string; page?: PageId }): JSX.Element {
  const accounts = useQuery(accountsQuery);
  const [adding, setAdding] = useState(false);
  const id = useId();
  const accountId = props.accountId;

  return (
    <div className={styles.menu}>
      <section aria-labelledby={`${id}-accounts`}>
        <h2 id={`${id}-accounts`} className={styles.heading}>
          Accounts
        </h2>
        {accounts.isError && <AccountsProblem error={accounts.error} className={styles.problem} />}
        {accounts.data && accounts.data.length > 0 && (
          <ul className={styles.links}>
            {accounts.data.map((account) => (
              <li key={account.id}>
                <NavLink to={pagePath(account.id, props.page ?? 'overview')}>
                  {account.name}
                </NavLink>
              </li>
            ))}
          </ul>
        )}
        <button type="button" className={styles.add} onClick={() => setAdding(true)}>
          Add account
        </button>
      </section>
      {accountId && (
        <section aria-labelledby={`${id}-pages`}>
          <h2 id={`${id}-pages`} className={styles.heading}>
            Pages
          </h2>
          <ul className={styles.links}>
            {PAGES.map((page) => (
              <li key={page.id}>
                <NavLink to={pagePath(accountId, page.id)}>{page.label}</NavLink>
              </li>
            ))}
          </ul>
        </section>
      )}
      <AddAccountDialog open={adding} onClose={() => setAdding(false)} />
    </div>
  );
}
