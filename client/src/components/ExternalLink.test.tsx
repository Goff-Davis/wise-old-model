import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ExternalLink } from './ExternalLink.tsx';

describe('ExternalLink', () => {
  it('opens in a new tab that can’t reach back, and says so before it’s followed', () => {
    render(<ExternalLink href="https://oldschool.runescape.wiki">OSRS Wiki</ExternalLink>);
    // A no-break space keeps the mark with the last word.
    const link = screen.getByRole('link', { name: 'OSRS Wiki\u00a0(opens in a new tab)' });
    expect(link.getAttribute('href')).toBe('https://oldschool.runescape.wiki');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    // A mark says it to the eye; the words are for screen readers.
    expect(link.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    expect(link.querySelector('.visually-hidden')?.textContent).toBe('(opens in a new tab)');
  });
});
