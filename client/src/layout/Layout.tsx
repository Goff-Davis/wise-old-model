import {
  type JSX,
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import styles from './Layout.module.css';

const NARROW = '(max-width: 999px)';

function subscribe(onChange: () => void): () => void {
  const query = window.matchMedia(NARROW);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

function isNarrow(): boolean {
  return window.matchMedia(NARROW).matches;
}

/**
 * Three columns, built for a second monitor to the right of the user: the chat (the main
 * feature) on the left, then the selected page, then the menu that controls it. On narrow
 * windows the page and menu fold away behind a menu button (a hamburger) so the chat keeps the screen; they
 * stay mounted while hidden, so nothing typed or scrolled there is lost.
 */
export function Layout(props: { chat: ReactNode; page: ReactNode; menu: ReactNode }): JSX.Element {
  const narrow = useSyncExternalStore(subscribe, isNarrow);
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const menuButton = useRef<HTMLButtonElement>(null);

  // Widening the window shows everything; narrowing it again starts with the panel closed.
  useEffect(() => {
    if (!narrow) setOpen(false);
  }, [narrow]);

  // Escape closes the open panel, wherever focus is, except inside a dialog: that's the
  // dialog's own Escape.
  useEffect(() => {
    if (!narrow || !open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (event.target instanceof Element && event.target.closest('dialog[open]')) return;
      setOpen(false);
      menuButton.current?.focus();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [narrow, open]);

  return (
    <div className={styles.layout} data-narrow={narrow ? '' : undefined}>
      {narrow && (
        <div className={styles.bar}>
          <button
            ref={menuButton}
            type="button"
            className={styles.menuButton}
            aria-label="Menu"
            aria-expanded={open}
            aria-controls={panelId}
            onClick={() => setOpen((wasOpen) => !wasOpen)}
          >
            <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
              <path
                d="M3 5h14M3 10h14M3 15h14"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>
      )}
      {/* Going into the chat (a page sending it a question moves the focus there) closes the
        panel over it. */}
      <section
        aria-label="Chat"
        className={styles.chat}
        onFocus={() => {
          if (narrow && open) setOpen(false);
        }}
      >
        {props.chat}
      </section>
      <div id={panelId} className={styles.side} hidden={narrow && !open}>
        <section aria-label="Page" className={styles.page}>
          {props.page}
        </section>
        <nav aria-label="Menu" className={styles.menu}>
          {props.menu}
        </nav>
      </div>
    </div>
  );
}
