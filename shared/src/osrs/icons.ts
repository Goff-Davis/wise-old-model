/**
 * A wiki icon's file name as the server accepts it: letters, digits and `_().'%-` only, ending
 * `.png`. No slash, backslash or colon (which names a hidden stream on Windows), so nothing can
 * reach outside the icons folder.
 */
export const WIKI_ICON_FILE = /^[A-Za-z0-9_().'%-]+\.png$/;

/**
 * The wiki's names for icons whose files aren't named after the hiscores entry (each checked on
 * the wiki on 2026-10-27). Some entries have no icon on the wiki at all; those show a blank.
 */
const WIKI_ICON_NAMES = new Map([
  ["Kree'Arra", "Kree'arra"],
  ['Thermonuclear Smoke Devil', 'Thermonuclear smoke devil'],
  ['Barrows Chests', 'Barrows Brothers'],
  ['Brutus', 'Brutus Boss'],
  ['Chambers of Xeric: Challenge Mode', 'Chambers of Xeric Challenge Mode'],
  ['Tombs of Amascut', 'Tombs of Amascut - Normal Mode'],
  ['Tombs of Amascut: Expert Mode', 'Tombs of Amascut - Expert Mode'],
  ['Nightmare', 'The Nightmare'],
  ['Mimic', 'The Mimic'],
]);

/**
 * The wiki's file name for a skill's or boss's icon: its name with spaces as underscores, then
 * `_icon.png` (`Vorkath_icon.png`, `K'ril_Tsutsaroth_icon.png`), except where the wiki names it
 * otherwise. A colon becomes a hyphen, as the wiki does with file names.
 */
export function wikiIconFile(name: string, _kind: 'skill' | 'boss'): string {
  const wikiName = WIKI_ICON_NAMES.get(name) ?? name;
  return `${wikiName.replaceAll(':', '-').replaceAll(' ', '_')}_icon.png`;
}
