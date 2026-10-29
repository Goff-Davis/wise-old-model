import { plural } from '@wom/shared';
import {
  type CSSProperties,
  type JSX,
  type KeyboardEvent,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import styles from './SearchSelect.module.css';

/** An option: its value, and what's shown after it (an entry, a tier). */
export type SearchOption = { value: string; detail?: string };

/** How many matches show at once. */
const SHOWN = 50;

/** The list's gap from the box, its tallest, and the room below it that's enough. */
const GAP = 4;
const TALLEST = 224;
const ENOUGH_BELOW = 160;

/**
 * Where the floating list goes: under the box, its width, or above it when there's more room
 * there; as tall as the room allows, up to 224 px, leaving a line for its note.
 */
function placeUnder(box: HTMLElement): CSSProperties {
  const rect = box.getBoundingClientRect();
  const below = window.innerHeight - rect.bottom - 2 * GAP;
  const above = rect.top - 2 * GAP;
  const up = below < ENOUGH_BELOW && above > below;
  const room = (up ? above : below) - 28;
  return {
    left: `${rect.left}px`,
    width: `${rect.width}px`,
    ...(up
      ? { bottom: `${window.innerHeight - rect.top + GAP}px` }
      : { top: `${rect.bottom + GAP}px` }),
    maxHeight: `${Math.max(Math.min(TALLEST, room), 80)}px`,
  };
}

/** Text as typed text is matched: in lowercase, without apostrophes. */
const plain = (text: string) => text.toLowerCase().replace(/['’]/g, '');

/**
 * A searchable dropdown: the ARIA pattern's combobox with list autocomplete and automatic
 * selection. Typing narrows the options to those with every word typed, in any order, ignoring
 * case and apostrophes (an option's detail counts too): an exact name first, then those starting
 * with what was typed. The first match is the one Enter picks; ↑ and ↓ move from it (opening a
 * closed list on its first option), keeping the one moved to in view and naming it to screen
 * readers; a click picks one; Escape closes the list (and only then the dialog it's in). A
 * status line says how many match. Only a picked option is a value: typed text is one only when
 * it's an option's whole name. Up to 50 matches show at once.
 */
export function SearchSelect(props: {
  id: string;
  /** The list's name for screen readers (Quests). */
  label: string;
  options: SearchOption[];
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}): JSX.Element {
  const [text, setText] = useState(props.value);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  // Whether an arrow key has moved to an option, so the box names it to screen readers.
  const [moved, setMoved] = useState(false);
  const box = useRef<HTMLInputElement>(null);
  const [place, setPlace] = useState<CSSProperties>({});
  const listId = useId();
  // An option's id is its place in `options`, so a new match never takes another's.
  const optionId = (index: number) => `${listId}-${index}`;

  const matches = useMemo(() => {
    const query = plain(text).trim();
    const words = query.split(/\s+/).filter(Boolean);
    const rank = (option: SearchOption) => {
      const value = plain(option.value);
      return value === query ? 0 : value.startsWith(query) ? 1 : 2;
    };
    return props.options
      .map((option, index) => ({ option, index }))
      .filter(({ option }) => {
        const haystack = plain(`${option.value} ${option.detail ?? ''}`);
        return words.every((word) => haystack.includes(word));
      })
      .sort((a, b) => rank(a.option) - rank(b.option) || a.index - b.index);
  }, [text, props.options]);
  const shown = matches.slice(0, SHOWN);
  const current = shown[Math.min(active, shown.length - 1)];
  const currentId = current ? optionId(current.index) : undefined;

  // The list floats over the page (a dialog included, which would clip it in its flow, and
  // would grow with it), under the box, following it when anything scrolls or the window
  // resizes. It's fixed from its first render: in the flow until placed, it would move the box
  // (a centred dialog grows both ways), and be placed by where the box was moved to.
  useLayoutEffect(() => {
    if (!open) return;
    const update = () => {
      if (box.current) setPlace(placeUnder(box.current));
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [open]);

  // The option moved to stays in view in the list's scroll.
  useEffect(() => {
    if (open && moved && currentId) {
      document.getElementById(currentId)?.scrollIntoView({ block: 'nearest' });
    }
  }, [open, moved, currentId]);

  /** Opens the list on its first option. */
  const show = () => {
    setOpen(true);
    setActive(0);
    setMoved(false);
  };
  const pick = (option: SearchOption) => {
    setText(option.value);
    setOpen(false);
    props.onChange(option.value);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) {
        show();
        return;
      }
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setActive((now) => Math.min(Math.max(now + step, 0), Math.max(shown.length - 1, 0)));
      setMoved(true);
    } else if (event.key === 'Enter' && open && current) {
      event.preventDefault();
      pick(current.option);
    } else if (event.key === 'Escape' && open) {
      event.preventDefault();
      setOpen(false);
    }
  };

  const more = matches.length - SHOWN;
  const note =
    shown.length === 0
      ? 'No matches.'
      : more > 0
        ? `${more} more: keep typing to narrow them down.`
        : null;
  const count = `${matches.length} ${plural(matches.length, 'match', 'matches')}.`;
  return (
    <div className={styles.search}>
      <input
        ref={box}
        id={props.id}
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && moved ? currentId : undefined}
        autoComplete="off"
        placeholder={props.placeholder}
        value={text}
        onFocus={show}
        onClick={() => {
          if (!open) show();
        }}
        onBlur={() => setOpen(false)}
        onKeyDown={onKeyDown}
        onChange={(event) => {
          const typed = event.target.value;
          setText(typed);
          show();
          const whole = props.options.find((option) => plain(option.value) === plain(typed).trim());
          props.onChange(whole ? whole.value : '');
        }}
      />
      {open && (
        // biome-ignore lint/a11y/noStaticElementInteractions: a press anywhere on the list keeps the focus in the box, so the list stays open; it does nothing else.
        <div
          className={styles.popup}
          style={{ position: 'fixed', ...place }}
          onMouseDown={(event) => event.preventDefault()}
        >
          <div role="listbox" id={listId} aria-label={props.label} className={styles.list}>
            {shown.map(({ option, index }) => (
              // biome-ignore lint/a11y/useKeyWithClickEvents: the box keeps the focus and handles the keys.
              <div
                key={option.value}
                id={optionId(index)}
                role="option"
                tabIndex={-1}
                aria-selected={index === current?.index}
                onClick={() => pick(option)}
              >
                {option.value}
                {option.detail && (
                  <>
                    {' '}
                    <span className={styles.detail}>{option.detail}</span>
                  </>
                )}
              </div>
            ))}
          </div>
          {note && <p className={styles.note}>{note}</p>}
        </div>
      )}
      <p role="status" className="visually-hidden">
        {open && (shown.length === 0 ? 'No matches.' : note ? `${count} ${note}` : count)}
      </p>
    </div>
  );
}
