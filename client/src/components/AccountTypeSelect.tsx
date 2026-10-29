import { ACCOUNT_TYPE_LABELS, type AccountType, AccountTypeSchema } from '@wom/shared';
import type { JSX } from 'react';

/** The account types to pick from, then whether the one shown is Wise Old Man's or set by hand. */
export function AccountTypeSelect(props: {
  id: string;
  value: AccountType;
  fromWom: boolean;
  disabled?: boolean;
  noteClassName?: string;
  onChange: (type: AccountType) => void;
}): JSX.Element {
  return (
    <>
      <select
        id={props.id}
        value={props.value}
        disabled={props.disabled}
        onChange={(event) => props.onChange(AccountTypeSchema.parse(event.target.value))}
      >
        {AccountTypeSchema.options.map((option) => (
          <option key={option} value={option}>
            {ACCOUNT_TYPE_LABELS[option]}
          </option>
        ))}
      </select>
      <span className={props.noteClassName}>
        {props.fromWom ? 'From Wise Old Man' : 'Set by hand'}
      </span>
    </>
  );
}
