import { type Freshness, formatTime, TEMPLE_SYNC_STEPS } from '@wom/shared';

/** What's said when Temple has no collection log for a name: how to get it there. */
export const NO_TEMPLE_LOG = `No collection log yet. ${TEMPLE_SYNC_STEPS}`;

/**
 * What's known of an account's Character Export folder, as the add dialog and Settings say it:
 * found, when it was last written, or what to do in game for the plugin to write it; or, with
 * `error`, why it couldn't be checked.
 */
export function exportFolderFinding(
  folder: { found: boolean | null; lastWritten: string | null },
  name: string,
  zone: string,
  error: string | null = null,
): string {
  if (folder.found === null) return error ? `Couldn't check. ${error}` : "Couldn't check.";
  if (!folder.found) {
    return `Not found yet. Log in to ${name} with the Character Export plugin on, then open the bank and each diary journal once.`;
  }
  return folder.lastWritten
    ? `Found. Last written ${formatTime(folder.lastWritten, zone, 'relative')}.`
    : 'Found.';
}

/** What's known of an account's collection log on Temple, from its last fetch (Settings). */
export function templeLogFinding(temple: Freshness, zone: string): string {
  if (temple.fetchedAt) {
    const fetched = `Has the collection log, fetched ${formatTime(temple.fetchedAt, zone, 'relative')}.`;
    return temple.error ? `${fetched} The last try failed: ${temple.error}` : fetched;
  }
  if (temple.notFound) return NO_TEMPLE_LOG;
  if (temple.error) return `Couldn't check. ${temple.error}`;
  return 'Not fetched yet. The Collection log page fetches it.';
}
