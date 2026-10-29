import { type JSX, type ReactNode, useEffect, useId, useRef } from 'react';
import styles from './ModalDialog.module.css';

/**
 * A modal dialog with a heading, shown while `open`. Its content is mounted only while open, so
 * each opening starts afresh; Escape, or the content's own buttons, close it (`onClose`).
 */
export function ModalDialog(props: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}): JSX.Element {
  const dialog = useRef<HTMLDialogElement>(null);
  const headingId = useId();

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (props.open && !element.open) element.showModal();
    if (!props.open && element.open) element.close();
  }, [props.open]);

  return (
    <dialog
      ref={dialog}
      aria-labelledby={headingId}
      className={styles.dialog}
      onClose={props.onClose}
    >
      {props.open && (
        <>
          <h2 id={headingId}>{props.title}</h2>
          {props.children}
        </>
      )}
    </dialog>
  );
}
