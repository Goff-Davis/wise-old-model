import { fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type SearchOption, SearchSelect } from './SearchSelect.tsx';

const QUESTS: SearchOption[] = [
  { value: 'Dragon Slayer I' },
  { value: 'Dragon Slayer II' },
  { value: 'Dream Mentor' },
  { value: "Eadgar's Ruse" },
  { value: 'Monkey Madness II' },
];

/** A labelled SearchSelect over `options`, keeping what's picked; `picked` sees each change. */
function Harness(props: { options: SearchOption[]; picked: (value: string) => void }) {
  const [value, setValue] = useState('');
  return (
    <form>
      <label htmlFor="quest">Quest</label>
      <SearchSelect
        id="quest"
        label="Quests"
        options={props.options}
        value={value}
        onChange={(next) => {
          setValue(next);
          props.picked(next);
        }}
      />
    </form>
  );
}

function renderSelect(options: SearchOption[] = QUESTS) {
  const picked = vi.fn();
  render(<Harness options={options} picked={picked} />);
  const box = screen.getByRole('combobox', { name: 'Quest' }) as HTMLInputElement;
  const shown = () =>
    screen.queryByRole('listbox')
      ? within(screen.getByRole('listbox'))
          .queryAllByRole('option')
          .map((option) => option.textContent ?? '')
      : [];
  const selected = () =>
    screen
      .queryAllByRole('option')
      .find((option) => option.getAttribute('aria-selected') === 'true');
  return { box, picked, shown, selected };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('SearchSelect', () => {
  it('lists the options when focused, and narrows them by the words typed, in any order', () => {
    const { box, shown } = renderSelect();
    fireEvent.focus(box);
    expect(shown()).toHaveLength(5);
    expect(box.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('listbox', { name: 'Quests' })).toBeTruthy();
    fireEvent.change(box, { target: { value: 'slayer dragon' } });
    expect(shown()).toEqual(['Dragon Slayer I', 'Dragon Slayer II']);
    // Case and apostrophes don't count.
    fireEvent.change(box, { target: { value: 'EADGARS' } });
    expect(shown()).toEqual(["Eadgar's Ruse"]);
    fireEvent.change(box, { target: { value: 'zzz' } });
    expect(shown()).toEqual([]);
    expect(screen.getByRole('status').textContent).toBe('No matches.');
  });

  it('puts an exact name first, then those starting with what was typed', () => {
    const { box, shown } = renderSelect([
      { value: 'Recipe for Disaster' },
      { value: 'Monkey Madness II' },
      { value: 'Monkey Madness I' },
    ]);
    fireEvent.change(box, { target: { value: 'madness' } });
    expect(shown()).toEqual(['Monkey Madness II', 'Monkey Madness I']);
    fireEvent.change(box, { target: { value: 'monkey madness i' } });
    expect(shown()).toEqual(['Monkey Madness I', 'Monkey Madness II']);
  });

  it('ranks an option starting with what was typed above one only containing it', () => {
    const { box, shown } = renderSelect([{ value: 'Barrows Novice' }, { value: 'Noxious Foe' }]);
    fireEvent.change(box, { target: { value: 'no' } });
    expect(shown()).toEqual(['Noxious Foe', 'Barrows Novice']);
  });

  it('marks the first match as the one Enter picks, naming it to screen readers once an arrow key moves', () => {
    const { box, picked, shown, selected } = renderSelect();
    fireEvent.change(box, { target: { value: 'dr' } });
    expect(selected()?.textContent).toBe('Dragon Slayer I');
    expect(box.getAttribute('aria-activedescendant')).toBeNull();
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    expect(selected()?.textContent).toBe('Dragon Slayer II');
    expect(box.getAttribute('aria-activedescendant')).toBe(selected()?.id);
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(picked).toHaveBeenLastCalledWith('Dragon Slayer II');
    expect(box.value).toBe('Dragon Slayer II');
    expect(shown()).toEqual([]);
  });

  it('keeps each option its own id, wherever it falls among the matches', () => {
    const { box } = renderSelect();
    fireEvent.change(box, { target: { value: 'dragon' } });
    const second = screen.getByRole('option', { name: 'Dragon Slayer II' }).id;
    fireEvent.change(box, { target: { value: 'slayer ii' } });
    expect(screen.getByRole('option', { name: 'Dragon Slayer II' }).id).toBe(second);
  });

  it('opens a closed list on its first option with ↓, and scrolls the one moved to into view', () => {
    const scrolled = vi.spyOn(Element.prototype, 'scrollIntoView');
    const { box, selected } = renderSelect();
    fireEvent.focus(box);
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    fireEvent.keyDown(box, { key: 'Escape' });
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    expect(selected()?.textContent).toBe('Dragon Slayer I');
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    expect(selected()?.textContent).toBe('Dragon Slayer II');
    expect(scrolled).toHaveBeenLastCalledWith({ block: 'nearest' });
    expect(scrolled.mock.contexts.at(-1)).toBe(selected());
  });

  it('picks with a click, and opens again on a click in the box', () => {
    const { box, picked, shown } = renderSelect();
    fireEvent.change(box, { target: { value: 'dream' } });
    fireEvent.click(screen.getByRole('option', { name: 'Dream Mentor' }));
    expect(picked).toHaveBeenLastCalledWith('Dream Mentor');
    expect(shown()).toEqual([]);
    fireEvent.click(box);
    expect(shown()).toHaveLength(1);
    // A press anywhere on the list keeps the focus in the box.
    expect(fireEvent.mouseDown(screen.getByRole('listbox'))).toBe(false);
  });

  it('takes typed text as a pick only when it is a whole option', () => {
    const { box, picked } = renderSelect();
    fireEvent.change(box, { target: { value: 'dragon slayer ii' } });
    expect(picked).toHaveBeenLastCalledWith('Dragon Slayer II');
    fireEvent.change(box, { target: { value: 'dragon slayer iii' } });
    expect(picked).toHaveBeenLastCalledWith('');
  });

  it('closes the list on Escape without letting the key go further', () => {
    const { box, shown } = renderSelect();
    fireEvent.focus(box);
    // fireEvent gives false when the key's default was prevented.
    expect(fireEvent.keyDown(box, { key: 'Escape' })).toBe(false);
    expect(shown()).toEqual([]);
    // With the list closed, Escape is left to close the dialog.
    expect(fireEvent.keyDown(box, { key: 'Escape' })).toBe(true);
  });

  it('shows 50 matches at once, and says how many there are', () => {
    const many = Array.from({ length: 70 }, (_, i) => ({
      value: `Item ${i + 1}`,
      detail: 'Entry',
    }));
    const { box, shown } = renderSelect(many);
    fireEvent.focus(box);
    expect(shown()).toHaveLength(50);
    expect(shown()[0]).toBe('Item 1 Entry');
    expect(screen.getByRole('status').textContent).toBe(
      '70 matches. 20 more: keep typing to narrow them down.',
    );
    fireEvent.change(box, { target: { value: 'item 7' } });
    expect(screen.getByRole('status').textContent).toBe('8 matches.');
  });

  it('floats the list over the page, under the box, leaving the page as it was', () => {
    const { box } = renderSelect();
    vi.spyOn(box, 'getBoundingClientRect').mockReturnValue(
      DOMRect.fromRect({ x: 20, y: 100, width: 200, height: 30 }),
    );
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(768);
    fireEvent.focus(box);
    const popup = screen.getByRole('listbox').parentElement as HTMLElement;
    expect(popup.style).toMatchObject({
      position: 'fixed',
      top: '134px',
      left: '20px',
      width: '200px',
    });
    // The count is for screen readers; what's shown for the eye is in the floating list.
    expect(screen.getByRole('status').className).toBe('visually-hidden');
    fireEvent.change(box, { target: { value: 'zzz' } });
    expect(within(popup).getByText('No matches.')).toBeTruthy();
  });

  it('places the list right the first time it opens, never letting it take room in the page', () => {
    const { box } = renderSelect();
    // As in a centred dialog: a list in the dialog's flow makes it taller, moving the box up.
    vi.spyOn(box, 'getBoundingClientRect').mockImplementation(() => {
      const popup = screen.queryByRole('listbox')?.parentElement;
      const inFlow = popup && popup.style.position !== 'fixed';
      return DOMRect.fromRect({ x: 20, y: inFlow ? 20 : 100, width: 200, height: 30 });
    });
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(768);
    fireEvent.focus(box);
    expect(screen.getByRole('listbox').parentElement?.style.top).toBe('134px');
  });

  it('opens the list above the box when there is more room there, and follows the box when the page scrolls', () => {
    const { box } = renderSelect();
    const rect = vi
      .spyOn(box, 'getBoundingClientRect')
      .mockReturnValue(DOMRect.fromRect({ x: 20, y: 700, width: 200, height: 30 }));
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(768);
    fireEvent.focus(box);
    const popup = () => screen.getByRole('listbox').parentElement as HTMLElement;
    expect(popup().style.bottom).toBe('72px');
    expect(popup().style.top).toBe('');
    rect.mockReturnValue(DOMRect.fromRect({ x: 40, y: 200, width: 180, height: 30 }));
    fireEvent.scroll(window);
    expect(popup().style).toMatchObject({ top: '234px', left: '40px', width: '180px' });
    // More room above, but enough below: it stays below.
    rect.mockReturnValue(DOMRect.fromRect({ x: 40, y: 400, width: 180, height: 30 }));
    fireEvent.scroll(window);
    expect(popup().style.top).toBe('434px');
  });
});
