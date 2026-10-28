// Apostrophes are left out of names before matching: "ahrims hood" is Ahrim's hood.
const APOSTROPHES = /['\u2019]/g;

/** An item name's words, for matching: lowercase, apostrophes dropped, split at anything else. */
function wordsOf(name: string): string[] {
  return name
    .toLowerCase()
    .replace(APOSTROPHES, '')
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** Whether each query word starts a name word, in the query's order. */
function startsWordsInOrder(query: string[], words: string[]): boolean {
  let next = 0;
  for (const part of query) {
    while (next < words.length && !words[next].startsWith(part)) next += 1;
    if (next === words.length) return false;
    next += 1;
  }
  return true;
}

/** A name for matching inside words: lowercase, apostrophes dropped, spaces squeezed. */
const squeeze = (text: string) =>
  text.toLowerCase().replace(APOSTROPHES, '').replace(/\s+/g, ' ').trim();

/**
 * Finds items by a loose name, ignoring case, best match first: the exact name (score 3), then
 * names whose words start with the query's words in order (2: "dragon scim" is Dragon scimitar),
 * then names containing the query (1). Shorter names come first among equals.
 */
export function createItemIndex(items: { id: number; name: string }[]): {
  find(query: string, limit?: number): { id: number; name: string; score: number }[];
} {
  const entries = items.map((item) => {
    const words = wordsOf(item.name);
    return { item, text: squeeze(item.name), words, key: words.join(' ') };
  });
  return {
    find(query, limit = 5) {
      const text = squeeze(query);
      const words = wordsOf(query);
      if (words.length === 0) return [];
      const key = words.join(' ');
      const matches: { id: number; name: string; score: number }[] = [];
      for (const entry of entries) {
        const score =
          entry.key === key
            ? 3
            : startsWordsInOrder(words, entry.words)
              ? 2
              : entry.text.includes(text)
                ? 1
                : 0;
        if (score > 0) matches.push({ id: entry.item.id, name: entry.item.name, score });
      }
      matches.sort(
        (a, b) =>
          b.score - a.score || a.name.length - b.name.length || a.name.localeCompare(b.name),
      );
      return matches.slice(0, limit);
    },
  };
}
