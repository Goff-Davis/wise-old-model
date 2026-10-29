import { capitalize, type Freshness, formatTime } from '@wom/shared';

/** The online sources a page names in its notes, as a sentence names them. */
const SOURCE_NAMES: Partial<Record<Freshness['kind'], string>> = {
  hiscores: 'the hiscores',
  wom_achievements: "Wise Old Man's achievements",
  temple_clog: 'TempleOSRS',
};

/**
 * What's said of the sources whose last try failed: when the copy shown was fetched and why the
 * last try failed, or, with none, why. A source that doesn't know the account is the page's to
 * say (each says what to do), and so is one it doesn't name.
 */
export function failureNotes(freshness: Freshness[], zone: string): string[] {
  return freshness.flatMap((entry) => {
    const name = SOURCE_NAMES[entry.kind];
    if (!name || !entry.error || entry.notFound) return [];
    return [
      entry.fetchedAt
        ? `${capitalize(name)}: fetched ${formatTime(entry.fetchedAt, zone, 'relative')}. The last try failed: ${entry.error}`
        : `Couldn't get ${name}. ${entry.error}`,
    ];
  });
}
