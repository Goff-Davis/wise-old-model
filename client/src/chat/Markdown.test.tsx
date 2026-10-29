import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Markdown } from './Markdown.tsx';

describe('Markdown', () => {
  it('renders headings, paragraphs, lists, bold, italics and code', () => {
    const { container } = render(
      <Markdown
        text={[
          '## Next steps',
          'Train **Magic** to *75* first, then `Dream Mentor`.',
          '',
          '- Reach 75 Magic',
          '- Complete _Dream Mentor_',
          '',
          '1. Bank',
          '2. Teleport',
          '',
          '```',
          'a = 1',
          '```',
        ].join('\n')}
      />,
    );
    expect(screen.getByRole('heading', { level: 3, name: 'Next steps' })).toBeTruthy();
    expect(container.querySelector('strong')?.textContent).toBe('Magic');
    expect([...container.querySelectorAll('em')].map((em) => em.textContent)).toEqual([
      '75',
      'Dream Mentor',
    ]);
    expect(container.querySelector('p code')?.textContent).toBe('Dream Mentor');
    expect([...container.querySelectorAll('ul li')].map((li) => li.textContent)).toEqual([
      'Reach 75 Magic',
      'Complete Dream Mentor',
    ]);
    expect(container.querySelectorAll('ol li')).toHaveLength(2);
    expect(container.querySelector('pre code')?.textContent).toBe('a = 1');
  });

  it('opens links in a new tab, and only web links', () => {
    render(
      <Markdown text="See [Dragon Slayer II](https://oldschool.runescape.wiki/w/Dragon_Slayer_II) and [this](javascript:alert(1))." />,
    );
    const link = screen.getByRole('link', { name: 'Dragon Slayer II' });
    expect(link.getAttribute('href')).toBe('https://oldschool.runescape.wiki/w/Dragon_Slayer_II');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    expect(screen.queryByRole('link', { name: 'this' })).toBeNull();
    expect(screen.getByText(/and this\./)).toBeTruthy();
  });

  it('shows raw HTML as text', () => {
    const { container } = render(<Markdown text={'<img src=x onerror="alert(1)"> **hi**'} />);
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('<img src=x onerror="alert(1)">');
  });

  it("keeps a numbered list's numbers across a paragraph, and nests indented bullets in their step", () => {
    const { container } = render(
      <Markdown
        text={[
          '1. Get 75 Magic',
          '   - About 6 hours',
          '2. Do Dream Mentor',
          '',
          'Then:',
          '',
          '3. Start the quest',
        ].join('\n')}
      />,
    );
    const lists = container.querySelectorAll(':scope > ol');
    expect(lists).toHaveLength(2);
    expect([...(lists[0]?.children ?? [])].map((item) => item.firstChild?.textContent)).toEqual([
      'Get 75 Magic',
      'Do Dream Mentor',
    ]);
    expect(lists[0]?.querySelector('li ul li')?.textContent).toBe('About 6 hours');
    expect(lists[0]?.getAttribute('start')).toBeNull();
    expect(lists[1]?.getAttribute('start')).toBe('3');
  });

  it('renders a table, with its columns lined up and formatted, and the text around it', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { container } = render(
      <Markdown
        text={[
          'The rooftop courses:',
          '| Course | Level | XP/h | Marks/h |',
          '|---|:---:|---:|:---|',
          '| **Canifis** | 40 | 19,700 | 16–18 |',
          '| Falador | 50 |',
          "| Seers' Village \\| no diary | 60 | 46,800 | 11–13.8 | extra |",
          'Source: Rooftop Agility Courses.',
        ].join('\n')}
      />,
    );
    const table = screen.getByRole('table');
    const rows = [...table.querySelectorAll('tr')].map((row) =>
      [...row.children].map((cell) => cell.textContent),
    );
    expect(rows).toEqual([
      ['Course', 'Level', 'XP/h', 'Marks/h'],
      ['Canifis', '40', '19,700', '16–18'],
      ['Falador', '50', '', ''],
      ["Seers' Village | no diary", '60', '46,800', '11–13.8'],
    ]);
    expect(screen.getAllByRole('columnheader').map((cell) => cell.getAttribute('scope'))).toEqual([
      'col',
      'col',
      'col',
      'col',
    ]);
    expect(table.querySelector('tbody strong')?.textContent).toBe('Canifis');
    for (const row of table.querySelectorAll('tr')) {
      expect([...row.children].map((cell) => (cell as HTMLElement).style.textAlign)).toEqual([
        '',
        'center',
        'right',
        'left',
      ]);
    }
    expect([...container.querySelectorAll(':scope > p')].map((p) => p.textContent)).toEqual([
      'The rooftop courses:',
      'Source: Rooftop Agility Courses.',
    ]);
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });

  it("leaves bars as text without a divider row, with bars, that matches the header's columns", () => {
    const { container } = render(
      <Markdown
        text={[
          'Magic | Ranged',
          'both 75',
          '',
          '| Attack | Strength |',
          '| --- |',
          '',
          '| Defence |',
          '---',
        ].join('\n')}
      />,
    );
    expect(container.querySelector('table')).toBeNull();
    expect([...container.querySelectorAll('p')].map((p) => p.textContent)).toEqual([
      'Magic | Rangedboth 75',
      '| Attack | Strength || --- |',
      '| Defence |---',
    ]);
  });

  it('gives each piece of a paragraph its own key, line after line', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<Markdown text={'**A**: 1\n**B**: 2'} />);
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });
});
