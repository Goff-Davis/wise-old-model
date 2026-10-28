import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { WIKI_ICON_FILE, wikiIconFile } from './icons.ts';

const hiscores = JSON.parse(
  readFileSync(
    new URL('../../../server/test/fixtures/hiscores/lynx-titan.json', import.meta.url),
    'utf8',
  ),
) as { skills: { name: string }[]; activities: { name: string }[] };

describe('wikiIconFile', () => {
  it("names a skill's or boss's icon on the wiki, spaces as underscores", () => {
    expect(wikiIconFile('Attack', 'skill')).toBe('Attack_icon.png');
    expect(wikiIconFile('Vorkath', 'boss')).toBe('Vorkath_icon.png');
    expect(wikiIconFile("K'ril Tsutsaroth", 'boss')).toBe("K'ril_Tsutsaroth_icon.png");
  });

  it("uses the wiki's own name where it differs from the hiscores' (checked on the wiki)", () => {
    expect(wikiIconFile("Kree'Arra", 'boss')).toBe("Kree'arra_icon.png");
    expect(wikiIconFile('Thermonuclear Smoke Devil', 'boss')).toBe(
      'Thermonuclear_smoke_devil_icon.png',
    );
    expect(wikiIconFile('Barrows Chests', 'boss')).toBe('Barrows_Brothers_icon.png');
    expect(wikiIconFile('Brutus', 'boss')).toBe('Brutus_Boss_icon.png');
    expect(wikiIconFile('Chambers of Xeric: Challenge Mode', 'boss')).toBe(
      'Chambers_of_Xeric_Challenge_Mode_icon.png',
    );
    expect(wikiIconFile('Tombs of Amascut', 'boss')).toBe(
      'Tombs_of_Amascut_-_Normal_Mode_icon.png',
    );
    expect(wikiIconFile('Tombs of Amascut: Expert Mode', 'boss')).toBe(
      'Tombs_of_Amascut_-_Expert_Mode_icon.png',
    );
    expect(wikiIconFile('Nightmare', 'boss')).toBe('The_Nightmare_icon.png');
    expect(wikiIconFile('Mimic', 'boss')).toBe('The_Mimic_icon.png');
  });

  it('turns a colon into a hyphen, as the wiki does in file names', () => {
    expect(wikiIconFile('Theatre of Blood: Hard Mode', 'boss')).toBe(
      'Theatre_of_Blood-_Hard_Mode_icon.png',
    );
  });

  it('gives a file name the icon route accepts for every skill and activity on the hiscores', () => {
    const names = [...hiscores.skills, ...hiscores.activities].map((entry) => entry.name);
    for (const name of names) expect(wikiIconFile(name, 'boss'), name).toMatch(WIKI_ICON_FILE);
  });
});

describe('WIKI_ICON_FILE', () => {
  it('accepts plain file names only: nothing that could leave the icons folder', () => {
    expect(WIKI_ICON_FILE.test("K'ril_Tsutsaroth_icon.png")).toBe(true);
    for (const bad of ['../x.png', '..\\x.png', 'a/b.png', 'x.gif', 'a:b.png', '.png']) {
      expect(WIKI_ICON_FILE.test(bad), bad).toBe(false);
    }
  });
});
