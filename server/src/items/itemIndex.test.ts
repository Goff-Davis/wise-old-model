import { describe, expect, it } from 'vitest';
import { fixture } from '../../test/helpers.ts';
import { createItemIndex } from './itemIndex.ts';

const items: { id: number; name: string }[] = JSON.parse(fixture('prices/mapping-sample.json'));
const index = createItemIndex(items);
const names = (query: string, limit?: number) =>
  index.find(query, limit).map((match) => match.name);

describe('createItemIndex', () => {
  it('finds an item by the start of each word, in order: "dragon scim" is Dragon scimitar', () => {
    expect(index.find('dragon scim')[0]?.name).toBe('Dragon scimitar');
    expect(names('dragon scim')).toEqual(['Dragon scimitar', 'Dragon scimitar ornament kit']);
    expect(names('scim dragon')).toEqual([]);
  });

  it('ignores case', () => {
    expect(index.find('WHIP')[0]).toEqual({ id: 4151, name: 'Abyssal whip', score: 2 });
  });

  it('finds nothing for a name no item has, or for no name at all', () => {
    expect(index.find('zzz')).toEqual([]);
    expect(index.find('  ')).toEqual([]);
  });

  it('puts the exact name first, then names whose words start that way, then names containing it', () => {
    expect(index.find('rune scimitar')).toEqual([
      { id: 1333, name: 'Rune scimitar', score: 3 },
      { id: 23321, name: 'Rune scimitar ornament kit (Guthix)', score: 2 },
    ]);
    // Inside every scimitar's name, but at the start of no word: the shortest names come first.
    expect(names('imitar', 10)).toEqual([
      'Rune scimitar',
      'Dragon scimitar',
      'Adamant scimitar',
      'Dragon scimitar ornament kit',
      'Rune scimitar ornament kit (Guthix)',
    ]);
    expect(index.find('imitar').every((match) => match.score === 1)).toBe(true);
  });

  it('skips words in a name that the query leaves out', () => {
    expect(index.find('dragon kit')[0]?.name).toBe('Dragon scimitar ornament kit');
    expect(index.find('3rd age axe')[0]?.name).toBe('3rd Age felling axe');
  });

  it('reads past apostrophes and punctuation', () => {
    expect(index.find('ahrims hood')[0]).toEqual({ id: 4708, name: "Ahrim's hood", score: 3 });
    expect(names("ahrim's hood")).toEqual(["Ahrim's hood", "Ahrim's hood 0"]);
    expect(names('rune scimitar ornament kit guthix')).toEqual([
      'Rune scimitar ornament kit (Guthix)',
    ]);
    // Inside a word, too.
    expect(names('rims hood')).toEqual(["Ahrim's hood", "Ahrim's hood 0"]);
    expect(index.find('hrims')[0]).toMatchObject({ name: "Ahrim's hood", score: 1 });
  });

  it('gives five matches unless told otherwise', () => {
    expect(index.find('a')).toHaveLength(5);
    expect(index.find('a', 2)).toHaveLength(2);
  });
});
